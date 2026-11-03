// Fronteiras de plataforma do main process. macOS é o alvo primário; Windows é
// suportado com degradação honesta onde a feature depende de POSIX/macOS
// (PTY, ps/lsof, osascript, captura de áudio do sistema).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

export const IS_WIN = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

/** Diretórios extras onde CLIs de usuário costumam morar (app aberto pela GUI tem PATH mínimo). */
export function extraBinDirs(): string[] {
  const home = homedir()
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [join(home, '.local', 'bin'), join(roaming, 'npm'), join(local, 'Programs'), join(local, 'Microsoft', 'WinGet', 'Links')]
  }
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
}

/** Nomes de arquivo possíveis de um executável na plataforma. */
export function exeNames(bin: string): string[] {
  return IS_WIN ? [`${bin}.exe`, `${bin}.cmd`, `${bin}.bat`] : [bin]
}

/** Procura `bin` nos diretórios dados; devolve o caminho absoluto ou null. */
export function findExecutable(bin: string, dirs: string[] = extraBinDirs()): string | null {
  for (const dir of dirs) {
    for (const name of exeNames(bin)) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

/** Procura `bin` nos diretórios do PATH do processo (chave "Path" no Windows). */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const dirs = (key ? env[key] : '')?.split(IS_WIN ? ';' : ':').filter(Boolean) ?? []
  return findExecutable(bin, dirs)
}

/** `.cmd`/`.bat` só executam via shell no Windows (Node recusa spawn direto). */
export const needsShell = (file: string): boolean => IS_WIN && /\.(cmd|bat)$/i.test(file)

/** Python de um venv (`bin/python` vs `Scripts/python.exe`). */
export function venvPython(venvDir: string): string {
  return IS_WIN ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
}

/**
 * Instalação do Hermes Agent, independente do perfil ativo: HERMES_AGENT_DIR →
 * `$HERMES_HOME/hermes-agent` → instalação inferida de HERMES_BIN → diretório
 * oficial em LOCALAPPDATA no Windows → `~/.hermes/hermes-agent`. Só vale
 * candidato cujo python do venv existe. Sem nenhum válido, devolve o primeiro
 * (erro explícito depois).
 */
export function resolveHermesAgent(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync,
): { agentDir: string; python: string } {
  const binHome = env.HERMES_BIN ? dirname(dirname(env.HERMES_BIN)) : undefined
  const candidates = [
    env.HERMES_AGENT_DIR,
    env.HERMES_HOME ? join(env.HERMES_HOME, 'hermes-agent') : undefined,
    binHome ? join(binHome, 'hermes-agent') : undefined,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'hermes', 'hermes-agent') : undefined,
    join(home, '.hermes', 'hermes-agent'),
  ].filter((d): d is string => !!d)
  const agentDir = candidates.find((d) => exists(venvPython(join(d, 'venv')))) ?? candidates[0]
  return { agentDir, python: venvPython(join(agentDir, 'venv')) }
}

/**
 * Raiz do Hermes (a pasta que contém `profiles/`), independente do perfil
 * ativo: HERMES_HOME normalmente aponta para `<raiz>/profiles/<nome>`, então o
 * avô também é candidato. Depois: instalação inferida de HERMES_BIN →
 * `%LOCALAPPDATA%\hermes` no Windows → `~/.hermes`. Sem nenhum candidato com
 * `profiles/`, devolve o último (o default histórico).
 */
export function resolveHermesHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync,
): string {
  const candidates: string[] = []
  if (env.HERMES_HOME) {
    candidates.push(env.HERMES_HOME)
    if (basename(dirname(env.HERMES_HOME)) === 'profiles') candidates.push(dirname(dirname(env.HERMES_HOME)))
  }
  if (env.HERMES_BIN) candidates.push(dirname(dirname(env.HERMES_BIN)))
  if (IS_WIN && env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'hermes'))
  candidates.push(join(home, '.hermes'))
  return candidates.find((d) => exists(join(d, 'profiles'))) ?? candidates[candidates.length - 1]
}

/**
 * Ferramenta portátil instalada pelo Hermes, em `<raiz>/tools/<prefixo>…/<rel>`
 * (ex.: `python-3.14…/python.exe`, `git-2.53…/bin/bash.exe`). Útil no app
 * empacotado, onde o PATH é mínimo mas o Hermes traz tudo que precisa.
 */
export function findHermesTool(prefix: string, rel: string): string | null {
  const dir = join(resolveHermesHome(), 'tools')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null // instalação sem tools/ (ex.: macOS via homebrew)
  }
  for (const name of names.sort().reverse()) {
    if (!name.startsWith(prefix)) continue
    const p = join(dir, name, rel)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * python3 utilizável (o relay de PTY do terminal depende dele). macOS/Linux:
 * caminhos usuais e PATH. Windows: venv do Hermes → python portátil de
 * `<raiz>/tools` → PATH, ignorando o stub da Microsoft Store (que abre a loja
 * em vez de executar). null quando não há nenhum.
 */
export function resolvePython(): string | null {
  if (!IS_WIN) {
    const posix = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']
    return posix.find((p) => existsSync(p)) ?? findOnPath('python3')
  }
  const venv = resolveHermesAgent().python
  if (existsSync(venv)) return venv
  const tool = findHermesTool('python-', 'python.exe')
  if (tool) return tool
  for (const bin of ['python3', 'python', 'py']) {
    const p = findOnPath(bin)
    if (p && !/[\\/]WindowsApps[\\/]/i.test(p)) return p
  }
  return null
}

/** `p` é `root` ou está dentro dele (separador da plataforma; case-insensitive no Windows). */
export function isInside(root: string, p: string): boolean {
  const norm = (s: string) => (IS_WIN ? s.toLowerCase() : s)
  const r = norm(root)
  const q = norm(p)
  return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Como killTree, mas por pid solto — processo que não é filho deste (ex.: o
 * runner do swarm, lido do meta.json). Windows: `taskkill /T /F`; POSIX: sinal
 * no grupo e depois no pid.
 */
export function killPidTree(pid: number, sig: NodeJS.Signals = 'SIGTERM'): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (IS_WIN) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* já morto */
    }
    return
  }
  try {
    process.kill(-pid, sig)
    return
  } catch {
    /* não é líder de grupo: tenta o pid direto */
  }
  try {
    process.kill(pid, sig)
  } catch {
    /* já morto */
  }
}

/**
 * Encerra o processo e seus descendentes. POSIX: sinal no grupo (-pid, requer
 * detached) com fallback no pid. Windows não tem sinais nem grupos: `taskkill /T`
 * derruba a árvore; só existe encerramento forçado (/F), sem fase graciosa.
 */
export function killTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid
  if (!pid) return
  if (IS_WIN) {
    try {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      k.on('error', () => {
        try {
          child.kill()
        } catch {
          /* já morto */
        }
      })
    } catch {
      /* já morto */
    }
    return
  }
  try {
    process.kill(-pid, sig)
    return
  } catch {
    /* grupo já sumiu ou não é líder — tenta o pid direto */
  }
  try {
    child.kill(sig)
  } catch {
    /* já morto */
  }
}
