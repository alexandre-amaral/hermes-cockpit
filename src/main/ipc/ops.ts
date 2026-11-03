// Domínio "ops" — operações do host (macOS, Windows, Linux): modelos (Ollama),
// portas, processos/aplicações, projetos/repos, containers, screenshot e
// sistema (CPU/RAM/volumes/GPU, em ../metrics.ts).
//
// Regras: só execFile (nunca shell com string do usuário), timeout em tudo,
// argumentos validados (pid inteiro, ids/nomes por regex, caminhos absolutos
// dentro do HOME). Falha de fonte vira erro com mensagem útil — a UI mostra.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join, normalize } from 'node:path'
import { extraBinDirs, findExecutable, IS_MAC, IS_WIN, isInside } from '../platform'
import { systemInfo } from '../metrics.ts'
import { app, desktopCapturer, screen, shell, systemPreferences } from 'electron'
import type {
  AppRow,
  AppsResult,
  ContainerAction,
  ContainerRow,
  ContainersResult,
  KillSignal,
  ModelsResult,
  OllamaModel,
  OpenTarget,
  PortRow,
  ProcRow,
  PullProgress,
  RepoBranch,
  RepoCommit,
  RepoDetail,
  RepoRow,
  RepoWorktree,
  Screenshot,
  SystemInfo,
} from '../../renderer/src/lib/ops'
import { ensureBackend, hasBackend } from '../backend'
import { broadcast, handle } from './index'

const HOME = homedir()
const BIN_DIRS = IS_WIN ? extraBinDirs() : [...extraBinDirs(), '/usr/bin', '/bin', '/usr/sbin', '/sbin']

/**
 * Features baseadas em ps/lsof/osascript: sem equivalente validado no Windows.
 * A mensagem começa com "indisponível" de propósito — a UI (ErrorState) trata
 * esse prefixo como estado neutro, não como falha.
 */
function needPosix(feature: string): void {
  if (IS_WIN) throw new Error(`indisponível no Windows: ${feature} depende de ps/lsof/osascript (POSIX/macOS)`)
}
const OLLAMA = 'http://127.0.0.1:11434'

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(e)) if (k.toUpperCase() === 'PATH') delete e[k] // Windows: "Path"
  e.PATH = [BIN_DIRS.join(delimiter), process.env.PATH ?? ''].join(delimiter)
  delete e.ELECTRON_RUN_AS_NODE
  e.LC_ALL = 'C'
  return e
}

function which(bin: string): string | null {
  return findExecutable(bin, BIN_DIRS)
}

interface RunResult {
  stdout: string
  stderr: string
  code: number
  /** binário não encontrado / timeout */
  failed?: string
}

/** execFile que NÃO rejeita por exit code ≠ 0 (lsof sem resultado sai 1). */
function run(cmd: string, args: string[], opts: { timeout?: number; cwd?: string; maxBuffer?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeout ?? 8000, cwd: opts.cwd, env: env(), maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null
        let failed: string | undefined
        if (e?.code === 'ENOENT') failed = `${cmd}: não encontrado`
        else if (e?.killed) failed = `${cmd}: tempo esgotado`
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: typeof e?.code === 'number' ? e.code : e ? 1 : 0,
          failed,
        })
      },
    )
  })
}

// ─── processos / árvore do app ──────────────────────────────────────────────

interface PsEntry {
  pid: number
  ppid: number
  uid: number
  user: string
  cpu: number
  mem: number
  rss: number
  etime: string
  args: string
}

async function psAll(): Promise<PsEntry[]> {
  needPosix('Processos')
  const r = await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,uid=,user=,pcpu=,pmem=,rss=,etime=,args='], { timeout: 6000 })
  if (r.failed) throw new Error(r.failed)
  const out: PsEntry[] = []
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    out.push({
      pid: +m[1],
      ppid: +m[2],
      uid: +m[3],
      user: m[4],
      cpu: +m[5],
      mem: +m[6],
      rss: +m[7],
      etime: m[8],
      args: m[9],
    })
  }
  return out
}

/** pids do próprio app: main, descendentes (renderer, hermes serve, PTYs) e o serve do app. */
async function ownPids(entries?: PsEntry[]): Promise<Set<number>> {
  const list = entries ?? (await psAll())
  const kids = new Map<number, number[]>()
  for (const e of list) {
    const arr = kids.get(e.ppid)
    if (arr) arr.push(e.pid)
    else kids.set(e.ppid, [e.pid])
  }
  const own = new Set<number>([process.pid])
  const roots = [process.pid]
  if (hasBackend()) {
    try {
      const info = await ensureBackend()
      if (info.pid) roots.push(info.pid)
    } catch {
      /* backend não subiu — nada a acrescentar */
    }
  }
  const stack = [...roots]
  while (stack.length) {
    const p = stack.pop() as number
    own.add(p)
    for (const c of kids.get(p) ?? []) if (!own.has(c)) stack.push(c)
  }
  return own
}

const PROC_KINDS: [string, RegExp][] = [
  ['hermes', /hermes/i],
  ['claude', /(^|\/)claude(\s|$)|@anthropic-ai\/claude-code/i],
  ['ollama', /ollama/i],
  ['docker', /docker|com\.docker|containerd|vpnkit/i],
  ['dev', /\b(vite|next(-server)?|webpack|esbuild|turbo|nodemon|tsx|electron-vite|uvicorn|gunicorn|flask|rails|bun|deno)\b/i],
  ['python', /(^|\/)python[\d.]*(\s|$)|\bPython\.app\b/i],
  ['node', /(^|\/)node(\s|$)|\b(npm|pnpm|yarn|npx)\b/i],
]

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'login', 'tmux', 'ps', 'lsof'])

function procKind(args: string): string | null {
  for (const [k, re] of PROC_KINDS) if (re.test(args)) return k
  return null
}

function procName(args: string): string {
  const first = args.split(/\s+/)[0] ?? ''
  const appM = args.match(/\/([^/]+)\.app\//)
  return appM ? appM[1] : basename(first)
}

// Nomes de processos de sessão do macOS que nunca matamos, mesmo sendo do usuário.
const PROTECTED_NAMES = new Set([
  'launchd',
  'WindowServer',
  'loginwindow',
  'Dock',
  'Finder',
  'SystemUIServer',
  'ControlCenter',
  'NotificationCenter',
  'coreaudiod',
  'kernel_task',
  'cfprefsd',
  'distnoted',
  'UserEventAgent',
])

async function killPid(pidArg: unknown, sigArg: unknown): Promise<void> {
  const pid = Number(pidArg)
  if (!Number.isInteger(pid) || pid <= 1 || pid > 99_999_999) throw new Error(`pid inválido: ${String(pidArg)}`)
  const sig: KillSignal = sigArg === 'SIGKILL' || sigArg === 'SIGINT' ? sigArg : 'SIGTERM'
  const entries = await psAll()
  const e = entries.find((x) => x.pid === pid)
  if (!e) throw new Error(`processo ${pid} não existe mais`)
  const myUid = typeof process.getuid === 'function' ? process.getuid() : -1
  if (e.uid === 0 || (myUid >= 0 && e.uid !== myUid)) throw new Error(`recusado: pid ${pid} é do sistema/de outro usuário (${e.user})`)
  if (pid < 200) throw new Error(`recusado: pid ${pid} é de sistema`)
  if (PROTECTED_NAMES.has(procName(e.args))) throw new Error(`recusado: ${procName(e.args)} é processo de sessão do macOS`)
  const own = await ownPids(entries)
  if (own.has(pid)) throw new Error(`recusado: pid ${pid} pertence ao próprio Hermes Cockpit (ou ao hermes serve dele)`)
  try {
    process.kill(pid, sig)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(code === 'EPERM' ? `sem permissão para sinalizar ${pid}` : code === 'ESRCH' ? `processo ${pid} já terminou` : String(err))
  }
}

async function processes(): Promise<ProcRow[]> {
  const entries = await psAll()
  const own = await ownPids(entries)
  const myUid = typeof process.getuid === 'function' ? process.getuid() : -1
  const rows: ProcRow[] = []
  for (const e of entries) {
    if (e.pid === 0) continue
    if (SHELLS.has(procName(e.args).replace(/^-/, ''))) continue
    const kind = procKind(e.args)
    if (!kind) continue
    if (e.uid !== myUid && kind !== 'docker' && kind !== 'ollama') continue
    rows.push({
      pid: e.pid,
      ppid: e.ppid,
      user: e.user,
      cpu: e.cpu,
      mem: e.mem,
      rssKb: e.rss,
      elapsed: e.etime,
      name: procName(e.args),
      args: e.args.slice(0, 600),
      kind,
      own: own.has(e.pid),
    })
  }
  rows.sort((a, b) => b.cpu - a.cpu || b.rssKb - a.rssKb)
  return rows.slice(0, 300)
}

// ─── portas ─────────────────────────────────────────────────────────────────

async function ports(): Promise<PortRow[]> {
  needPosix('Portas')
  const r = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpcLn'], { timeout: 8000 })
  if (r.failed) throw new Error(r.failed)
  if (r.code !== 0 && !r.stdout.trim()) {
    if (r.stderr.trim()) throw new Error(`lsof: ${r.stderr.trim().slice(0, 200)}`)
    return []
  }
  const out: PortRow[] = []
  const seen = new Set<string>()
  let pid = 0
  let command = ''
  let user: string | undefined
  for (const line of r.stdout.split('\n')) {
    if (!line) continue
    const tag = line[0]
    const val = line.slice(1)
    if (tag === 'p') {
      pid = Number(val)
      command = ''
      user = undefined
    } else if (tag === 'c') command = val
    else if (tag === 'L') user = val
    else if (tag === 'n') {
      const i = val.lastIndexOf(':')
      if (i < 0) continue
      const port = Number(val.slice(i + 1))
      if (!Number.isInteger(port)) continue
      const address = val.slice(0, i) || '*'
      const key = `${pid}|${address}|${port}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ port, pid, command, address, ...(user ? { user } : {}) })
    }
  }
  out.sort((a, b) => a.port - b.port || a.pid - b.pid)
  return out
}

// ─── aplicações GUI ─────────────────────────────────────────────────────────

async function apps(): Promise<AppsResult> {
  if (!IS_MAC) return { apps: [], error: 'lista de aplicações disponível apenas no macOS' }
  const r = await run(
    '/usr/bin/osascript',
    [
      '-e',
      'set out to ""',
      '-e',
      'tell application "System Events"',
      '-e',
      'repeat with p in (every process whose background only is false)',
      '-e',
      'set out to out & (name of p) & tab & (unix id of p) & linefeed',
      '-e',
      'end repeat',
      '-e',
      'end tell',
      '-e',
      'return out',
    ],
    { timeout: 8000 },
  )
  if (r.failed) return { apps: [], error: r.failed }
  if (r.code !== 0) {
    const msg = r.stderr.trim()
    const hint = /not allowed|-1743|assistive|permiss/i.test(msg)
      ? 'sem permissão de Automação para "System Events" (Ajustes › Privacidade e Segurança › Automação)'
      : msg.slice(0, 240) || 'osascript falhou'
    return { apps: [], error: hint }
  }
  const list: AppRow[] = []
  for (const line of r.stdout.split('\n')) {
    const [name, pidS] = line.split('\t')
    if (!name?.trim()) continue
    const pid = Number(pidS)
    list.push({ name: name.trim(), ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) })
  }
  list.sort((a, b) => a.name.localeCompare(b.name))
  return { apps: list }
}

const APP_NAME_RE = /^[\p{L}\p{N} ._()&+'’-]{1,80}$/u

async function quitApp(nameArg: unknown): Promise<void> {
  if (!IS_MAC) throw new Error('fechar aplicações disponível apenas no macOS')
  const name = typeof nameArg === 'string' ? nameArg.trim() : ''
  if (!APP_NAME_RE.test(name)) throw new Error(`nome de app inválido: ${String(nameArg).slice(0, 80)}`)
  const mine = new Set([app.getName(), 'Hermes Cockpit', 'Electron'])
  if (mine.has(name)) throw new Error('recusado: não fecho o próprio Hermes Cockpit por aqui')
  if (PROTECTED_NAMES.has(name)) throw new Error(`recusado: ${name} é parte da sessão do macOS`)
  // nome vai como argv do script — nunca interpolado no código AppleScript
  // resolve o bundle id pelo nome do processo (o nome do processo pode diferir do app: "Code")
  const script = [
    'on run argv',
    'tell application "System Events" to set bid to bundle identifier of first process whose name is (item 1 of argv)',
    'tell application id bid to quit',
    'end run',
  ]
  const r = await run('/usr/bin/osascript', [...script.flatMap((l) => ['-e', l]), name], {
    timeout: 15000,
  })
  if (r.failed) throw new Error(r.failed)
  if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 240) || `não consegui fechar ${name}`)
}

// ─── repos ──────────────────────────────────────────────────────────────────

const SCAN_ROOTS = [join(HOME, 'dev'), join(HOME, 'Documents')]
const SKIP_DIRS = new Set(['node_modules', 'Library', 'vendor', 'dist', 'build', 'out', 'release', 'target', '__pycache__', 'venv', '.venv'])
let repoCache: { at: number; rows: RepoRow[] } | null = null
let repoInflight: Promise<RepoRow[]> | null = null

async function findRepos(): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length > 400) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.name === '.git')) {
      found.push(dir)
      // raiz de varredura que é repo (ex.: ~/Documents versionado) ainda desce
      if (depth > 0) return
    }
    if (depth >= 3) return
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && !e.name.endsWith('.app'))
        .map((e) => walk(join(dir, e.name), depth + 1)),
    )
  }
  for (const root of SCAN_ROOTS) await walk(root, 0)
  return found
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await fn(items[k])
      }
    }),
  )
  return out
}

function git(cwd: string, args: string[], timeout = 6000): Promise<RunResult> {
  return run('git', ['-c', 'core.quotepath=off', '--no-optional-locks', ...args], { cwd, timeout })
}

async function repoSummary(path: string): Promise<RepoRow> {
  const row: RepoRow = { path, name: basename(path), dirty: 0 }
  const [st, log] = await Promise.all([git(path, ['status', '--porcelain', '-b']), git(path, ['log', '-1', '--format=%cr · %s'])])
  if (!st.failed && st.code === 0) {
    const lines = st.stdout.split('\n').filter(Boolean)
    const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : ''
    row.dirty = lines.length
    // "main...origin/main [ahead 1, behind 2]" | "No commits yet on main" | "HEAD (no branch)"
    const bname = head.replace(/^(No commits yet on |Initial commit on )/, '').split('...')[0].split(' ')[0]
    if (bname && !head.startsWith('HEAD (no branch)')) row.branch = bname
    else if (head.startsWith('HEAD')) row.branch = 'HEAD (detached)'
    const a = head.match(/ahead (\d+)/)
    const b = head.match(/behind (\d+)/)
    if (head.includes('...')) {
      row.ahead = a ? +a[1] : 0
      row.behind = b ? +b[1] : 0
    }
  }
  if (!log.failed && log.code === 0 && log.stdout.trim()) row.lastCommit = log.stdout.trim().slice(0, 200)
  return row
}

async function repos(opts: unknown): Promise<RepoRow[]> {
  const force = Boolean(opts && typeof opts === 'object' && (opts as { force?: boolean }).force)
  if (!force && repoCache && Date.now() - repoCache.at < 60_000) return repoCache.rows
  if (repoInflight) return repoInflight
  repoInflight = (async () => {
    const paths = await findRepos()
    const rows = await pool(paths, 8, repoSummary)
    rows.sort((a, b) => a.name.localeCompare(b.name))
    repoCache = { at: Date.now(), rows }
    return rows
  })().finally(() => {
    repoInflight = null
  })
  return repoInflight
}

/** Caminho absoluto, normalizado, existente e dentro do HOME. */
async function safePath(p: unknown): Promise<string> {
  if (typeof p !== 'string' || !p || p.length > 1024 || p.includes('\0')) throw new Error('caminho inválido')
  const abs = normalize(/^~[\\/]/.test(p) ? join(HOME, p.slice(2)) : p)
  if (!isAbsolute(abs)) throw new Error(`caminho precisa ser absoluto: ${p}`)
  if (!isInside(HOME, abs)) throw new Error(`fora do HOME: ${abs}`)
  try {
    await stat(abs)
  } catch {
    throw new Error(`não existe: ${abs}`)
  }
  return abs
}

async function repoDetail(pathArg: unknown): Promise<RepoDetail> {
  const path = await safePath(pathArg)
  if (!existsSync(join(path, '.git'))) throw new Error(`não é repositório git: ${path}`)
  const [br, rem, wt, log, st] = await Promise.all([
    git(path, ['branch', '--sort=-committerdate', '--format=%(HEAD)\x1f%(refname:short)\x1f%(upstream:short)\x1f%(committerdate:relative)']),
    git(path, ['remote', '-v']),
    git(path, ['worktree', 'list', '--porcelain']),
    git(path, ['log', '-12', '--format=%h\x1f%s\x1f%cr\x1f%an']),
    git(path, ['status', '--porcelain']),
  ])
  for (const r of [br, rem, wt, log, st]) if (r.failed) throw new Error(r.failed)
  const branches: RepoBranch[] = br.stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, 60)
    .map((l) => {
      const [h, name, up, when] = l.split('\x1f')
      return { name, current: h === '*', ...(up ? { upstream: up } : {}), ...(when ? { when } : {}) }
    })
  const remotes: { name: string; url: string }[] = []
  for (const l of rem.stdout.split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+)\s+\(fetch\)/)
    if (m) remotes.push({ name: m[1], url: m[2] })
  }
  const worktrees: RepoWorktree[] = []
  let cur: RepoWorktree | null = null
  for (const l of wt.stdout.split('\n')) {
    if (l.startsWith('worktree ')) {
      cur = { path: l.slice(9) }
      worktrees.push(cur)
    } else if (cur && l.startsWith('HEAD ')) cur.head = l.slice(5, 13)
    else if (cur && l.startsWith('branch ')) cur.branch = l.slice(7).replace(/^refs\/heads\//, '')
    else if (cur && l === 'bare') cur.bare = true
  }
  const commits: RepoCommit[] = log.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, when, author] = l.split('\x1f')
      return { hash, subject, when, author }
    })
  return { path, branches, remotes, worktrees, commits, status: st.stdout.split('\n').filter(Boolean).slice(0, 200) }
}

// ─── abrir ──────────────────────────────────────────────────────────────────

const BUNDLE_RE = /\.(app|bundle|framework|plugin|prefpane|pkg|mpkg|workflow|action|saver|kext|appex|qlgenerator|mdimporter)\/?$/i

/** Windows: Explorer / VS Code / Windows Terminal. Sempre execFile, nunca shell com string. */
async function openTargetWin(kind: OpenTarget['kind'], p: string, isDir: boolean): Promise<RunResult> {
  if (kind === 'finder') {
    if (isDir) {
      const err = await shell.openPath(p) // string vazia = ok
      return { stdout: '', stderr: err, code: err ? 1 : 0 }
    }
    shell.showItemInFolder(p) // revela o arquivo sem executá-lo
    return { stdout: '', stderr: '', code: 0 }
  }
  if (kind === 'vscode') {
    const local = process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local')
    const exe = [
      join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
    ].find((c) => existsSync(c))
    if (!exe) return { stdout: '', stderr: 'VS Code não encontrado (Code.exe)', code: 1 }
    return run(exe, [p])
  }
  if (kind === 'terminal') {
    if (!isDir) throw new Error(`terminal só abre diretórios: ${p}`)
    const wt = await run('wt.exe', ['-d', p])
    if (!wt.failed && wt.code === 0) return wt
    return run('cmd.exe', ['/c', 'start', '', '/D', p, 'powershell.exe'])
  }
  throw new Error(`tipo de alvo inválido: ${String(kind)}`)
}

async function openTarget(t: unknown): Promise<void> {
  if (!t || typeof t !== 'object') throw new Error('alvo inválido')
  const { kind, path, url } = t as OpenTarget
  if (kind === 'url') {
    // http(s) ou, como exceção única, os painéis de Privacidade dos Ajustes
    // (botão "abrir ajustes" da aba Tela Mac / microfone).
    const prefs = /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_[A-Za-z]+$/
    if (typeof url !== 'string' || !(/^https?:\/\/[^\s]+$/i.test(url) || prefs.test(url))) {
      throw new Error('só abro URLs http/https (ou Ajustes > Privacidade)')
    }
    await shell.openExternal(url)
    return
  }
  // realpath: um symlink dentro do HOME não pode apontar para fora nem
  // disfarçar um .app como pasta comum.
  const p = await realpath(await safePath(path))
  if (!isInside(HOME, p)) throw new Error(`fora do HOME: ${p}`)
  const s = await stat(p)
  // Pastas-pacote (X.app etc.): `open <dir>` EXECUTA o bundle — só revelar.
  const bundle = s.isDirectory() && BUNDLE_RE.test(p)
  let r: RunResult
  if (IS_WIN) {
    r = await openTargetWin(kind, p, s.isDirectory())
  } else if (kind === 'finder') {
    r = await run('/usr/bin/open', s.isDirectory() && !bundle ? [p] : ['-R', p])
  } else if (kind === 'vscode') {
    // VS Code abre arquivo ou pasta como texto; nunca executa.
    r = await run('/usr/bin/open', ['-a', 'Visual Studio Code', p])
  } else if (kind === 'terminal') {
    // `open -a Terminal <arquivo>` executa scripts: só diretórios comuns.
    if (!s.isDirectory() || bundle) throw new Error(`terminal só abre diretórios: ${p}`)
    const ghostty = existsSync('/Applications/Ghostty.app') || existsSync(join(HOME, 'Applications', 'Ghostty.app'))
    r = await run('/usr/bin/open', ['-a', ghostty ? 'Ghostty' : 'Terminal', p])
  } else throw new Error(`tipo de alvo inválido: ${String(kind)}`)
  if (r.failed) throw new Error(r.failed)
  if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 240) || 'open falhou')
}

// ─── containers ─────────────────────────────────────────────────────────────

const CONTAINER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

async function containers(): Promise<ContainersResult> {
  const docker = which('docker')
  if (!docker) return { daemon: false, installed: false, error: 'docker CLI não encontrado' }
  const r = await run(docker, ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], { timeout: 8000 })
  if (r.failed) return { daemon: false, installed: true, error: r.failed }
  if (r.code !== 0) {
    const msg = r.stderr.trim()
    const down = /daemon|docker\.sock|connect|Is the docker daemon running/i.test(msg)
    return { daemon: false, installed: true, error: down ? 'daemon do Docker parado (abra o Docker Desktop / colima)' : msg.slice(0, 240) }
  }
  const rows: ContainerRow[] = []
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line) as Record<string, string>
      rows.push({
        id: String(j.ID ?? '').slice(0, 64),
        name: String(j.Names ?? ''),
        image: String(j.Image ?? ''),
        state: String(j.State ?? ''),
        status: String(j.Status ?? ''),
        ports: String(j.Ports ?? ''),
        ...(j.CreatedAt ? { created: String(j.CreatedAt) } : {}),
      })
    } catch {
      /* linha não-JSON: ignora */
    }
  }
  return { daemon: true, containers: rows }
}

async function containerAction(actionArg: unknown, idArg: unknown): Promise<string | void> {
  const action = actionArg as ContainerAction
  if (!['start', 'stop', 'restart', 'rm', 'logs'].includes(action)) throw new Error(`ação inválida: ${String(actionArg)}`)
  const id = typeof idArg === 'string' ? idArg : ''
  if (!CONTAINER_ID_RE.test(id)) throw new Error(`id de container inválido: ${String(idArg).slice(0, 80)}`)
  const docker = which('docker')
  if (!docker) throw new Error('docker CLI não encontrado')
  const args = action === 'logs' ? ['logs', '--tail', '400', '--timestamps', id] : [action, id]
  const r = await run(docker, args, { timeout: action === 'logs' ? 10000 : 40000, maxBuffer: 8 * 1024 * 1024 })
  if (r.failed) throw new Error(r.failed)
  if (action === 'logs') {
    if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 300) || 'docker logs falhou')
    // docker logs escreve stdout e stderr do container nos dois canais
    return (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).slice(-200_000)
  }
  if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 300) || `docker ${action} falhou`)
}

// ─── modelos (Ollama) ───────────────────────────────────────────────────────

const MODEL_RE = /^[a-zA-Z0-9][\w.\-/:]{0,199}$/
const pulls = new Map<string, AbortController>()

function modelName(n: unknown): string {
  if (typeof n !== 'string' || !MODEL_RE.test(n)) throw new Error(`nome de modelo inválido: ${String(n).slice(0, 80)}`)
  return n
}

async function ollamaJson<T>(path: string, init?: { method?: string; body?: unknown; timeout?: number }): Promise<T> {
  const res = await fetch(`${OLLAMA}${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init?.timeout ?? 5000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ollama ${res.status}: ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : {}) as T
}

interface TagsResp {
  models?: {
    name: string
    size: number
    modified_at?: string
    details?: { family?: string; parameter_size?: string; quantization_level?: string; context_length?: number }
    capabilities?: string[]
  }[]
}
interface PsResp {
  models?: { name: string; size_vram?: number; expires_at?: string }[]
}

async function models(): Promise<ModelsResult> {
  const pulling = [...pulls.keys()]
  let tags: TagsResp
  let ps: PsResp
  let version: string | undefined
  try {
    ;[tags, ps] = await Promise.all([ollamaJson<TagsResp>('/api/tags'), ollamaJson<PsResp>('/api/ps')])
    version = (await ollamaJson<{ version?: string }>('/api/version').catch(() => ({ version: undefined }))).version
  } catch (err) {
    const installed = Boolean(which('ollama')) || existsSync('/Applications/Ollama.app')
    const msg = err instanceof Error ? err.message : String(err)
    const refused = /ECONNREFUSED|fetch failed|timeout|aborted/i.test(msg) || /ECONNREFUSED/.test(String((err as { cause?: unknown })?.cause))
    return {
      running: false,
      installed,
      error: refused ? (installed ? 'Ollama instalado mas não está rodando (ollama serve)' : 'Ollama não instalado') : msg,
      models: [],
      pulling,
    }
  }
  const loaded = new Map((ps.models ?? []).map((m) => [m.name, m]))
  const list: OllamaModel[] = (tags.models ?? []).map((m) => {
    const l = loaded.get(m.name)
    return {
      name: m.name,
      size: m.size,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      contextLength: m.details?.context_length,
      capabilities: m.capabilities,
      modifiedAt: m.modified_at,
      loaded: Boolean(l),
      ...(l?.size_vram != null ? { vram: l.size_vram } : {}),
      ...(l?.expires_at ? { expiresAt: l.expires_at } : {}),
    }
  })
  list.sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.name.localeCompare(b.name))
  return { running: true, version, models: list, pulling }
}

function emitPull(p: PullProgress): void {
  broadcast('ops:pull-progress', p)
}

async function modelPull(nameArg: unknown): Promise<void> {
  const name = modelName(nameArg)
  if (pulls.has(name)) throw new Error(`${name} já está sendo baixado`)
  const ctl = new AbortController()
  pulls.set(name, ctl)
  emitPull({ name, status: 'iniciando' })
  // Não bloqueia o invoke: o progresso segue por broadcast.
  void (async () => {
    try {
      const res = await fetch(`${OLLAMA}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: name, stream: true }),
        signal: ctl.signal,
      })
      if (!res.ok || !res.body) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let lastEmit = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          const j = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string }
          if (j.error) throw new Error(j.error)
          const now = Date.now()
          if (now - lastEmit > 150 || j.status === 'success') {
            lastEmit = now
            emitPull({ name, status: j.status ?? '', completed: j.completed, total: j.total })
          }
        }
      }
      emitPull({ name, status: 'success', done: true })
    } catch (err) {
      const aborted = ctl.signal.aborted
      emitPull({ name, status: aborted ? 'cancelado' : 'erro', done: true, error: aborted ? 'cancelado' : err instanceof Error ? err.message : String(err) })
    } finally {
      pulls.delete(name)
    }
  })()
}

// ─── screenshot / sistema ───────────────────────────────────────────────────

async function screenshot(): Promise<Screenshot> {
  const access = IS_MAC ? systemPreferences.getMediaAccessStatus('screen') : 'granted' // sem permissão de tela fora do macOS
  const d = screen.getPrimaryDisplay()
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0]
  if (!src || src.thumbnail.isEmpty() || access === 'denied' || access === 'restricted') {
    if (!IS_MAC) throw new Error('não foi possível capturar a tela')
    throw new Error(
      'sem permissão de Gravação de Tela — habilite o Hermes Cockpit em Ajustes do Sistema › Privacidade e Segurança › Gravação de Tela e reabra o app',
    )
  }
  return { dataUrl: `data:image/jpeg;base64,${src.thumbnail.toJPEG(85).toString('base64')}` }
}

/**
 * Sistema: CPU (modelo, núcleos, uso total e por núcleo), RAM, volumes, GPU,
 * uptime e nome do SO. A coleta multiplataforma vive em ../metrics.ts (sem
 * Electron, com throttle e cache próprios).
 */
const system = (): Promise<SystemInfo> => systemInfo(HOME)

// ─── registro ───────────────────────────────────────────────────────────────

export function register(): void {
  handle('ops:ports', ports)
  handle('ops:kill', (pid: unknown, signal?: unknown) => killPid(pid, signal))
  handle('ops:processes', processes)
  handle('ops:apps', apps)
  handle('ops:quitApp', (name: unknown) => quitApp(name))
  handle('ops:repos', (opts?: unknown) => repos(opts))
  handle('ops:repo', (path: unknown) => repoDetail(path))
  handle('ops:open', (target: unknown) => openTarget(target))
  handle('ops:containers', containers)
  handle('ops:container', (action: unknown, id: unknown) => containerAction(action, id))
  handle('ops:models', models)
  handle('ops:modelPull', (name: unknown) => modelPull(name))
  handle('ops:modelPullCancel', (name: unknown) => {
    pulls.get(modelName(name))?.abort()
  })
  handle('ops:modelRm', async (name: unknown) => {
    await ollamaJson('/api/delete', { method: 'DELETE', body: { model: modelName(name) }, timeout: 20000 })
  })
  handle('ops:modelUnload', async (name: unknown) => {
    await ollamaJson('/api/generate', { method: 'POST', body: { model: modelName(name), keep_alive: 0 }, timeout: 20000 })
  })
  handle('ops:screenshot', screenshot)
  handle('ops:system', system)
}
