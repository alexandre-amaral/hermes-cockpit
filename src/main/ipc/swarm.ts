// Domínio "swarm" — swarm de Claude Code: runs, eventos, aprovações, cancelar/spawn manual (ver docs/SWARM-SPEC.md).
// Leituras e decisões vão direto ao estado em disco (~/.hermes/cockpit/swarm);
// spawn/send/cleanup delegam ao CLI instalado (~/.hermes/cockpit/swarm-bin/cli.mjs),
// que spawna runners detached com o node real (nunca o binário do Electron).
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { homedir } from 'node:os'
import { exeNames, extraBinDirs, IS_MAC, IS_WIN, killPidTree, resolveHermesHome } from '../platform'
import { delimiter, join } from 'node:path'
import { broadcast, handle } from './index'
import { withUsage, type TokenUsage } from '../../../swarm/lib/usage.mjs'

const HOME = homedir()
const COCKPIT_DIR = join(HOME, '.hermes', 'cockpit')
const STATE_DIR = join(COCKPIT_DIR, 'swarm')
const RUNS_DIR = join(STATE_DIR, 'runs')
const APPROVALS_DIR = join(STATE_DIR, 'approvals')
const BIN_DIR = join(COCKPIT_DIR, 'swarm-bin')
const CLI = join(BIN_DIR, 'cli.mjs')
// Os profiles não ficam sob ~/.hermes em toda plataforma (no Windows a raiz é
// %LOCALAPPDATA%\hermes); mesma resolução que o swarm/install.mjs usa.
const PROFILES_DIR = join(resolveHermesHome(), 'profiles')
const BIN_DIRS = extraBinDirs()
const NODE_CANDIDATES = BIN_DIRS.flatMap((d) => exeNames('node').map((n) => join(d, n)))

export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'done' | 'error' | 'cancelled'

export interface RunMeta {
  id: string
  groupId?: string
  title: string
  task: string
  repo: string
  cwd: string
  branch?: string
  model?: string
  status: RunStatus
  pid?: number
  claudePid?: number
  claudeSessionId?: string
  requestedBy?: { profile?: string; sessionId?: string; via: 'mcp' | 'cockpit' }
  createdAt: string
  startedAt?: string
  endedAt?: string
  numTurns?: number
  /** Interno (não exibido como consumo): US$ reportado pelo claude. */
  costUsd?: number
  /** Soma real de input+output+cache_creation+cache_read do último result. */
  tokensTotal?: number
  tokenUsage?: TokenUsage
  durationMs?: number
  resultText?: string
  error?: string
  exitCode?: number
  isolation?: 'worktree' | 'none'
  repoRoot?: string
  worktree?: string
  baseCommit?: string
  parentRunId?: string
  resumeSessionId?: string
  note?: string
}

export interface Approval {
  id: string
  runId: string
  toolName: string
  input: unknown
  toolUseId?: string
  status: 'pending' | 'allow' | 'deny'
  createdAt: string
  decidedAt?: string
  reason?: string
  updatedInput?: unknown
}

export interface SwarmStatus {
  installed: boolean
  binDir: string
  stateDir: string
  claudeVersion?: string
  profilesRegistered: string[]
  error?: string
}

const TERMINAL = new Set<RunStatus>(['done', 'error', 'cancelled'])
const ID_RE = /^[rga]-\d{8}-\d{6}-[0-9a-f]{4,6}$/
const MAX_EVENT_LINES = 2000

function assertId(id: unknown, kind: string): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`${kind} inválido: ${String(id)}`)
  return id
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, file)
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Mesma derivação de lib/state.mjs::effective — runner morto não fica "running" para sempre. */
function effective(m: RunMeta): RunMeta {
  if (!TERMINAL.has(m.status) && m.status !== 'queued' && m.pid && !pidAlive(m.pid)) {
    return { ...m, status: 'error', error: m.error || 'runner encerrou sem finalizar a run (processo morto)' }
  }
  if (m.status === 'queued' && Date.now() - Date.parse(m.createdAt) > 60_000) {
    return { ...m, status: 'error', error: m.error || 'runner não iniciou em 60s' }
  }
  return m
}

function metaPath(runId: string): string {
  return join(RUNS_DIR, assertId(runId, 'runId'), 'meta.json')
}

function listRuns(limit: number): RunMeta[] {
  if (!existsSync(RUNS_DIR)) return []
  const out: RunMeta[] = []
  for (const name of readdirSync(RUNS_DIR)) {
    if (!ID_RE.test(name)) continue
    try {
      out.push(effective(readJson<RunMeta>(join(RUNS_DIR, name, 'meta.json'))))
    } catch {
      /* meta em escrita/corrompido */
    }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  // Tokens: meta (runner novo) ou backfill lazy do último result, com cache por run
  // (usage.json + memória, invalidado por tamanho/mtime de events.jsonl).
  return out
    .slice(0, limit)
    .map((m) => (ID_RE.test(m.id) ? withUsage(m, join(RUNS_DIR, m.id), { terminal: TERMINAL.has(m.status) }) : m))
}

function readEvents(runId: string, fromLine: number): { lines: { ts: string; ev: unknown }[]; next: number } {
  const file = join(RUNS_DIR, assertId(runId, 'runId'), 'events.jsonl')
  if (!existsSync(file)) return { lines: [], next: 0 }
  const text = readFileSync(file, 'utf8')
  // Só linhas completas (o runner pode estar no meio de um append).
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1)
  const all = complete ? complete.slice(0, -1).split('\n') : []
  const from = Math.max(0, Math.floor(Number(fromLine) || 0))
  const slice = all.slice(from, from + MAX_EVENT_LINES)
  const lines: { ts: string; ev: unknown }[] = []
  for (const l of slice) {
    try {
      lines.push(JSON.parse(l) as { ts: string; ev: unknown })
    } catch {
      lines.push({ ts: '', ev: { type: 'raw', line: l } })
    }
  }
  return { lines, next: from + slice.length }
}

function listApprovals(status?: Approval['status']): Approval[] {
  if (!existsSync(APPROVALS_DIR)) return []
  const out: Approval[] = []
  for (const name of readdirSync(APPROVALS_DIR)) {
    if (!name.endsWith('.json')) continue
    try {
      const a = readJson<Approval>(join(APPROVALS_DIR, name))
      if (!status || a.status === status) out.push(a)
    } catch {
      /* em escrita */
    }
  }
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  return out
}

function decide(approvalId: string, decision: 'allow' | 'deny', reason?: string, updatedInput?: unknown): void {
  if (decision !== 'allow' && decision !== 'deny') throw new Error(`decisão inválida: ${String(decision)}`)
  const file = join(APPROVALS_DIR, `${assertId(approvalId, 'approvalId')}.json`)
  if (!existsSync(file)) throw new Error(`aprovação não encontrada: ${approvalId}`)
  const a = readJson<Approval>(file)
  if (a.status !== 'pending') throw new Error(`aprovação já decidida (${a.status})`)
  const next: Approval = { ...a, status: decision, decidedAt: new Date().toISOString() }
  if (reason) next.reason = String(reason)
  if (decision === 'allow' && updatedInput !== undefined) next.updatedInput = updatedInput
  writeJsonAtomic(file, next)
}

/**
 * Pid ainda é o runner desta run? (após crash/reboot o pid pode ter sido
 * reciclado). Confirmar importa: cancel() derruba a ÁRVORE do pid, e acertar o
 * processo errado mataria algo do usuário. POSIX: `ps -o args=`; Windows: não
 * há `ps`, mas Win32_Process.CommandLine via powershell resolve (espelho de
 * commandLineOf() em swarm/lib/platform.mjs).
 */
function isRunnerPid(pid: number, runId: string): boolean {
  if (!pidAlive(pid)) return false
  try {
    const args = IS_WIN
      ? execFileSync(
          join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
          { encoding: 'utf8', timeout: 20_000, windowsHide: true },
        )
      : execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 })
    return args.includes('run.mjs') && args.includes(runId)
  } catch {
    return false
  }
}

/** aspas simples seguras para /bin/zsh -lc */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Abre uma janela de terminal de verdade (Ghostty se instalado, senão Terminal.app):
 * - watch: segue a run ao vivo (swarm-bin/watch.mjs)
 * - resume: claude --resume <sessão> interativo no worktree da run (só run terminada)
 */
function terminalCommand(runId: string, mode: 'watch' | 'resume'): { cwd: string; cmd: string; title: string } {
  const file = metaPath(runId)
  if (!existsSync(file)) throw new Error(`run não encontrada: ${runId}`)
  const m = readJson<RunMeta & { claudeSessionId?: string; worktree?: string }>(file)
  const cwd = m.cwd && existsSync(m.cwd) ? m.cwd : HOME
  let cmd: string
  if (mode === 'resume') {
    if (!TERMINAL.has(m.status)) throw new Error('run ainda ativa — use "assistir"; retomar só depois que terminar')
    if (!m.claudeSessionId || !/^[\w-]+$/.test(m.claudeSessionId)) throw new Error('run sem sessão do Claude Code para retomar')
    cmd = `cd ${sq(cwd)} && claude --resume ${m.claudeSessionId}; exec /bin/zsh -l`
  } else {
    cmd = `${sq(nodeBin())} ${sq(join(BIN_DIR, 'watch.mjs'))} ${runId}; exec /bin/zsh -l`
  }
  return { cwd, cmd, title: `${mode === 'resume' ? 'claude' : 'watch'} · ${(m.title || runId).slice(0, 40)}` }
}

async function openTerminal(runId: string, mode: 'watch' | 'resume'): Promise<void> {
  if (IS_WIN) return openTerminalWin(runId, mode)
  if (!IS_MAC) throw new Error('abrir terminal externo só é suportado no macOS e no Windows')
  const { cwd, cmd } = terminalCommand(runId, mode)
  const ghostty = ['/Applications/Ghostty.app', join(HOME, 'Applications', 'Ghostty.app')].find((p) => existsSync(p))
  await new Promise<void>((resolve, reject) => {
    const done = (err: Error | null) => (err ? reject(new Error(err.message.slice(0, 240))) : resolve())
    if (ghostty) {
      execFile('/usr/bin/open', ['-na', ghostty, '--args', `--working-directory=${cwd}`, '-e', '/bin/zsh', '-lc', cmd], (e) => done(e))
    } else {
      const esc = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      execFile('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script "${esc}"`, '-e', 'tell application "Terminal" to activate'], (e) => done(e))
    }
  })
}

/** Windows: janela do PowerShell via `cmd /c start` (não testado em hardware Windows). */
function openTerminalWin(runId: string, mode: 'watch' | 'resume'): Promise<void> {
  const file = metaPath(runId)
  if (!existsSync(file)) return Promise.reject(new Error(`run não encontrada: ${runId}`))
  const m = readJson<RunMeta>(file)
  const cwd = m.cwd && existsSync(m.cwd) ? m.cwd : HOME
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`
  let ps: string
  if (mode === 'resume') {
    if (!TERMINAL.has(m.status)) return Promise.reject(new Error('run ainda ativa — use "assistir"; retomar só depois que terminar'))
    if (!m.claudeSessionId || !/^[\w-]+$/.test(m.claudeSessionId)) return Promise.reject(new Error('run sem sessão do Claude Code para retomar'))
    ps = `Set-Location -LiteralPath ${q(cwd)}; claude --resume ${m.claudeSessionId}`
  } else {
    ps = `& ${q(nodeBin())} ${q(join(BIN_DIR, 'watch.mjs'))} ${runId}`
  }
  return new Promise<void>((resolve, reject) => {
    execFile('cmd.exe', ['/c', 'start', '', '/D', cwd, 'powershell.exe', '-NoExit', '-Command', ps], { windowsHide: true }, (e) =>
      e ? reject(new Error(e.message.slice(0, 240))) : resolve(),
    )
  })
}

function cancel(runId: string): void {
  const file = metaPath(runId)
  if (!existsSync(file)) throw new Error(`run não encontrada: ${runId}`)
  const m = readJson<RunMeta>(file)
  if (TERMINAL.has(m.status)) return
  if (m.pid && isRunnerPid(m.pid, runId)) {
    if (!IS_WIN) {
      process.kill(m.pid, 'SIGTERM') // runner mata o claude e grava cancelled
      return
    }
    // Windows não entrega SIGTERM: o handler do runner nunca roda. Derruba a
    // árvore (runner + claude + netos) e grava a meta aqui — mesmo contrato do
    // cancelRun() de swarm/lib/runs.mjs.
    killPidTree(m.pid)
    if (m.claudePid) killPidTree(m.claudePid)
    writeJsonAtomic(file, { ...m, status: 'cancelled', endedAt: new Date().toISOString() })
    return
  }
  // Runner morto: ninguém mais escreve a meta.
  writeJsonAtomic(file, {
    ...m,
    status: 'cancelled',
    endedAt: new Date().toISOString(),
    error: m.error || 'cancelado (runner já não estava vivo)',
  })
}

function nodeBin(): string {
  for (const c of NODE_CANDIDATES) if (existsSync(c)) return c
  return 'node'
}

function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k] // Windows: "Path"
  env.PATH = [...BIN_DIRS, process.env.PATH ?? ''].join(delimiter)
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function runCli<T>(args: string[], timeoutMs = 30_000): Promise<T> {
  if (!existsSync(CLI)) {
    return Promise.reject(new Error(`swarm não instalado (${CLI} ausente) — rode npm run swarm:install`))
  }
  return new Promise((resolve, reject) => {
    execFile(nodeBin(), [CLI, ...args], { env: cliEnv(), timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const line = String(stdout).trim().split('\n').pop() ?? ''
      try {
        const parsed = JSON.parse(line) as { ok: boolean; data?: T; error?: string }
        if (parsed.ok) resolve(parsed.data as T)
        else reject(new Error(parsed.error || 'falha no swarm cli'))
      } catch {
        reject(new Error(err?.message || String(stderr).trim() || 'saída inválida do swarm cli'))
      }
    })
  })
}

let versionCache: { at: number; value?: string } | null = null

async function claudeVersion(): Promise<string | undefined> {
  if (versionCache && Date.now() - versionCache.at < 5 * 60_000) return versionCache.value
  try {
    const r = await runCli<{ claudeVersion: string | null }>(['version'], 15_000)
    versionCache = { at: Date.now(), value: r.claudeVersion ?? undefined }
  } catch {
    versionCache = { at: Date.now(), value: undefined }
  }
  return versionCache.value
}

function profilesRegistered(): string[] {
  if (!existsSync(PROFILES_DIR)) return []
  const out: string[] = []
  for (const p of readdirSync(PROFILES_DIR)) {
    const cfg = join(PROFILES_DIR, p, 'config.yaml')
    if (!existsSync(cfg)) continue
    try {
      const text = readFileSync(cfg, 'utf8')
      const i = text.search(/^mcp_servers\s*:/m)
      if (i === -1) continue
      const rest = text.slice(i).split('\n')
      let end = 1
      while (end < rest.length && !/^[^\s#]/.test(rest[end])) end++
      if (rest.slice(1, end).some((l) => /^\s{2}claude_swarm\s*:/.test(l))) out.push(p)
    } catch {
      /* ilegível */
    }
  }
  return out.sort()
}

async function status(): Promise<SwarmStatus> {
  const installed = ['cli.mjs', 'run.mjs', 'server.mjs', 'perm.mjs'].every((f) => existsSync(join(BIN_DIR, f)))
  return {
    installed,
    binDir: BIN_DIR,
    stateDir: STATE_DIR,
    claudeVersion: installed ? await claudeVersion() : undefined,
    profilesRegistered: profilesRegistered(),
    ...(installed ? {} : { error: 'swarm-bin ausente — rode npm run swarm:install' }),
  }
}

// --- swarm:changed via fs.watch (debounce ~150ms) ---------------------------
let watchers: FSWatcher[] = []
let flushTimer: NodeJS.Timeout | null = null
const dirtyRuns = new Set<string>()
let dirtyGlobal = false

function markDirty(runId?: string): void {
  if (runId) dirtyRuns.add(runId)
  else dirtyGlobal = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const runs = [...dirtyRuns]
    dirtyRuns.clear()
    const global = dirtyGlobal
    dirtyGlobal = false
    for (const runId of runs) broadcast('swarm:changed', { runId })
    if (global || runs.length === 0) broadcast('swarm:changed', {})
  }, 150)
}

function startWatch(): void {
  try {
    mkdirSync(RUNS_DIR, { recursive: true })
    mkdirSync(APPROVALS_DIR, { recursive: true })
  } catch {
    return // sem estado gravável: a UI mostra erro via swarm:status
  }
  try {
    watchers.push(
      watch(RUNS_DIR, { recursive: true }, (_e, name) => {
        const runId = name ? String(name).split(/[\\/]/)[0] : undefined
        markDirty(runId && ID_RE.test(runId) ? runId : undefined)
      }),
    )
  } catch {
    /* fs.watch indisponível: UI pode pollar */
  }
  try {
    watchers.push(
      watch(APPROVALS_DIR, (_e, name) => {
        if (name && String(name).endsWith('.tmp')) return
        markDirty()
      }),
    )
  } catch {
    /* idem */
  }
}

export function stopSwarmWatch(): void {
  for (const w of watchers) w.close()
  watchers = []
}

export function register(): void {
  handle('swarm:list', (opts?: { limit?: number }) => listRuns(Math.min(Math.max(Number(opts?.limit) || 50, 1), 1000)))
  handle('swarm:events', (runId: string, fromLine: number) => readEvents(runId, fromLine))
  handle('swarm:approvals', () => listApprovals('pending'))
  handle('swarm:decide', (approvalId: string, decision: 'allow' | 'deny', reason?: string, updatedInput?: unknown) =>
    decide(approvalId, decision, reason, updatedInput),
  )
  handle('swarm:cancel', (runId: string) => cancel(runId))
  handle('swarm:terminalCommand', (runId: string, mode: 'watch' | 'resume') =>
    terminalCommand(assertId(runId, 'runId'), mode === 'resume' ? 'resume' : 'watch'),
  )
  handle('swarm:openTerminal', (runId: string, mode: 'watch' | 'resume') =>
    openTerminal(assertId(runId, 'runId'), mode === 'resume' ? 'resume' : 'watch'),
  )
  handle('swarm:config', () => runCli<{ defaultPermissionMode: string }>(['config-get']))
  handle('swarm:setConfig', (patch: { defaultPermissionMode?: string }) =>
    runCli<{ defaultPermissionMode: string }>(['config-set', JSON.stringify({ defaultPermissionMode: patch?.defaultPermissionMode })]),
  )
  handle('swarm:spawn', (opts: { task: string; cwd: string; title?: string; model?: string; groupId?: string; permissionMode?: string }) => {
    if (!opts || typeof opts.task !== 'string' || typeof opts.cwd !== 'string') throw new Error('task e cwd obrigatórios')
    return runCli<RunMeta>(['spawn', JSON.stringify(opts)])
  })
  handle('swarm:send', (runId: string, message: string) => runCli<RunMeta>(['send', assertId(runId, 'runId'), String(message)]))
  handle('swarm:cleanup', async (runId: string) => {
    await runCli<unknown>(['cleanup', assertId(runId, 'runId')], 60_000)
  })
  handle('swarm:status', () => status())
  startWatch()
}
