// Fronteiras de plataforma do swarm. O alvo primário é macOS/Linux; o Windows
// não tem sinais POSIX, grupos de processo, `ps -o args=`, nem spawn direto de
// .cmd/.bat. Tudo que depende disso mora aqui. Sem deps.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, join } from 'node:path'

export const IS_WIN = process.platform === 'win32'
const HOME = homedir()

/**
 * Raiz do Hermes (a pasta com `profiles/`). HERMES_HOME aponta para o perfil
 * ativo (`<raiz>/profiles/<nome>`), então o avô também é candidato; no Windows
 * a raiz oficial é %LOCALAPPDATA%\hermes, não ~/.hermes. Espelha
 * resolveHermesHome() de src/main/platform.ts.
 */
export function hermesHome(env = process.env, home = HOME, exists = existsSync) {
  const candidates = []
  if (env.HERMES_HOME) {
    candidates.push(env.HERMES_HOME)
    if (basename(dirname(env.HERMES_HOME)) === 'profiles') candidates.push(dirname(dirname(env.HERMES_HOME)))
  }
  if (env.HERMES_BIN) candidates.push(dirname(dirname(env.HERMES_BIN)))
  if (IS_WIN && env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'hermes'))
  candidates.push(join(home, '.hermes'))
  return candidates.find((d) => exists(join(d, 'profiles'))) ?? candidates[candidates.length - 1]
}

/** Ferramenta portátil do Hermes, em `<raiz>/tools/<prefixo>…/<rel>`. */
export function hermesToolDir(prefix, rel = '') {
  const dir = join(hermesHome(), 'tools')
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null // instalação sem tools/ (ex.: macOS via homebrew)
  }
  for (const name of names.sort().reverse()) {
    if (!name.startsWith(prefix)) continue
    const p = rel ? join(dir, name, rel) : join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Extensões de executável a tentar, `.exe` antes de `.cmd`/`.bat` de propósito:
 * spawn direto é mais seguro (e mais rápido) que passar por cmd.exe.
 */
export function exeExts() {
  if (!IS_WIN) return ['']
  const raw = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.'))
  const preferred = ['.exe', '.com', '.cmd', '.bat'].filter((e) => raw.includes(e))
  return [...preferred, ...raw.filter((e) => !preferred.includes(e))]
}

/** Diretórios do PATH de um env (a chave é "Path" no Windows). */
export function pathDirs(env = process.env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return (key ? env[key] || '' : '').split(delimiter).filter(Boolean)
}

function winBinDirs() {
  const local = process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local')
  const roaming = process.env.APPDATA || join(HOME, 'AppData', 'Roaming')
  const pf = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files'
  const sys = process.env.SystemRoot || 'C:\\Windows'
  return [
    join(HOME, '.local', 'bin'), // instalador nativo do Claude Code
    join(roaming, 'npm'), // npm -g (claude.cmd)
    join(local, 'Programs', 'claude'),
    join(local, 'Microsoft', 'WinGet', 'Links'),
    // node e git para o filho: o app empacotado herda um PATH mínimo
    hermesToolDir('node-'),
    hermesToolDir('git-', 'cmd'),
    join(pf, 'nodejs'),
    join(pf, 'Git', 'cmd'),
    join(sys, 'System32'),
  ].filter(Boolean)
}

/** Onde procurar CLIs e o que prepender ao PATH do filho (PATH mínimo na GUI). */
export const BIN_DIRS = IS_WIN
  ? winBinDirs()
  : [join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

/** Procura `name` nos diretórios dados, tentando as extensões da plataforma. */
export function findBin(name, dirs) {
  const exts = exeExts()
  const asIs = IS_WIN && exts.includes(extname(name).toLowerCase())
  for (const d of dirs) {
    if (!d) continue
    if (asIs) {
      const c = join(d, name)
      if (existsSync(c)) return c
      continue
    }
    for (const ext of exts) {
      const c = join(d, name + ext)
      if (existsSync(c)) return c
    }
  }
  return null
}

/**
 * Quoting de um argumento para o CommandLineToArgvW mantendo a PARIDADE de
 * aspas do cmd.exe: a aspas interna vai como `""` (e não `\\"`, que o cmd não
 * entende — ele fecharia a região citada e passaria a interpretar & | como
 * separadores). Barras invertidas antes de uma aspas são dobradas.
 * Validado com um shim .cmd no formato do npm: & | ( ) ^ % " espaços e
 * acentuação chegam idênticos; ver as ressalvas em spawnSpec().
 */
function cmdQuote(arg) {
  const s = String(arg).replace(/(\\*)"/g, '$1$1""').replace(/(\\*)$/, '$1$1')
  return `"${s}"`
}

/**
 * Shim do npm/yarn/pnpm (.cmd) → script JS que ele chama. O shim faz
 * `node "%dp0%\\node_modules\\...\\cli.js" %*`; achar esse caminho e invocar o node
 * direto dispensa o cmd.exe inteiro. Vale a pena: pela linha de comando do cmd
 * um argumento com QUEBRA DE LINHA é truncado e `%VAR%` é expandido — e o texto
 * de uma tarefa do swarm costuma ter as duas coisas.
 */
export function resolveShimTarget(file) {
  if (!IS_WIN || !/\.(cmd|bat)$/i.test(file)) return null
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const m = text.match(/"%~?dp0%?[\\/]*([^"]+\.(?:js|mjs|cjs))"/i)
  if (!m) return null
  const target = join(dirname(file), m[1])
  return existsSync(target) ? target : null
}

/**
 * Como spawnar `file` com `args`. No Windows um .cmd/.bat não pode ir direto ao
 * CreateProcess (Node recusa desde a CVE-2024-27980), então:
 *   1. se for um shim do npm, chama o node no script de destino (sem perdas);
 *   2. senão, vai por cmd.exe com os argumentos citados (ressalvas: `%VAR%` é
 *      expandido e um argumento com quebra de linha é truncado).
 * Fora disso (POSIX, ou .exe no Windows) é passagem direta.
 */
export function spawnSpec(file, args = []) {
  if (!IS_WIN || !/\.(cmd|bat)$/i.test(file)) return { file, args, options: {} }
  const target = resolveShimTarget(file)
  if (target) return { file: process.execPath, args: [target, ...args], options: { windowsHide: true } }
  const line = [cmdQuote(file), ...args.map(cmdQuote)].join(' ')
  const sys = process.env.SystemRoot || 'C:\\Windows'
  return {
    file: process.env.COMSPEC || join(sys, 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true, windowsHide: true },
  }
}

/**
 * Encerra o processo e seus descendentes. POSIX: sinal no grupo (-pid, exige
 * detached) com fallback no pid. Windows não tem sinais nem grupos: `taskkill
 * /T` derruba a árvore, e só existe a forma forçada (/F).
 */
export function killTree(pid, sig = 'SIGTERM') {
  if (!pid) return false
  if (IS_WIN) {
    try {
      execFileSync('taskkill', ['/pid', String(Number(pid)), '/T', '/F'], { stdio: 'ignore', timeout: 15_000, windowsHide: true })
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(-pid, sig)
    return true
  } catch {
    /* não é líder de grupo: tenta o pid direto */
  }
  try {
    process.kill(pid, sig)
    return true
  } catch {
    return false
  }
}

/** Linha de comando de um pid, ou '' quando não dá para saber. */
export function commandLineOf(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return ''
  try {
    if (!IS_WIN) return execFileSync('ps', ['-o', 'args=', '-p', String(n)], { encoding: 'utf8', timeout: 5000 })
    const sys = process.env.SystemRoot || 'C:\\Windows'
    const ps = join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return execFileSync(
      existsSync(ps) ? ps : 'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${n}").CommandLine`],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true },
    )
  } catch {
    return ''
  }
}
