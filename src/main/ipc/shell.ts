import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { app, ipcMain, type WebContents } from 'electron'
import { IS_WIN, findHermesTool, killTree, resolvePython } from '../platform'

// Shell de verdade para o Terminal do dock (o /api/pty do serve só roda
// `hermes --tui`). Sem dependência nativa: um relay de PTY em Python stdlib
// faz a ponte stdin/stdout ↔ shell e entende o mesmo frame de resize do
// Hermes: "\x1b[RESIZE:<cols>;<rows>]". Dois backends, mesmo contrato:
//   - POSIX: pty.fork + select (RELAY_POSIX), shell = $SHELL.
//   - Windows: ConPTY via ctypes (RELAY_WIN), shell resolvido aqui.
//
// Canais (domínio ops — o preload só aceita swarm|ops|storage|transcriber):
//   ops:shell.open(id, {cwd?, cols, rows}) · ops:shell.write(id, data)
//   ops:shell.resize(id, cols, rows) · ops:shell.close(id)
// Eventos para o webContents dono: ops:shell.data {id, data: Uint8Array}
//   e ops:shell.exit {id, code}.

const RELAY_POSIX = String.raw`
import os, pty, re, select, signal, struct, sys, fcntl, termios
cols, rows, cwd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
cmd = sys.argv[4] if len(sys.argv) > 4 else ''
shell = os.environ.get('SHELL') or '/bin/zsh'
pid, fd = pty.fork()
if pid == 0:
    try:
        os.chdir(cwd)
    except Exception:
        pass
    os.environ['TERM'] = 'xterm-256color'
    if cmd:
        os.execvp(shell, [shell, '-lc', cmd])
    os.execvp(shell, [shell, '-l'])
def setsize(c, r):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass
setsize(cols, rows)
RES = re.compile(rb'\x1b\[RESIZE:(\d+);(\d+)\]')
out = sys.stdout.fileno()
while True:
    try:
        r, _, _ = select.select([fd, 0], [], [])
    except InterruptedError:
        continue
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(out, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            break
        def _res(m):
            setsize(int(m.group(1)), int(m.group(2)))
            return b''
        data = RES.sub(_res, data)
        if data:
            os.write(fd, data)
try:
    os.kill(pid, signal.SIGHUP)
except Exception:
    pass
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0)
`

// Windows: ConPTY (CreatePseudoConsole, Win10 1809+) por ctypes — mesmo
// mecanismo do node-pty, sem módulo nativo para recompilar por ABI do Electron.
// Recebe o argv do shell já resolvido: <cols> <rows> <cwd> <exe> [args...].
const RELAY_WIN = String.raw`
import ctypes, msvcrt, os, re, subprocess, sys, threading
from ctypes import wintypes as w
cols, rows, cwd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
argv = sys.argv[4:]
k32 = ctypes.WinDLL('kernel32', use_last_error=True)
def die(msg):
    os.write(2, ('\r\n' + msg + '\r\n').encode('utf-8', 'replace'))
    sys.exit(1)
class COORD(ctypes.Structure):
    _fields_ = [('X', ctypes.c_short), ('Y', ctypes.c_short)]
class STARTUPINFOW(ctypes.Structure):
    _fields_ = [('cb', w.DWORD), ('lpReserved', w.LPWSTR), ('lpDesktop', w.LPWSTR), ('lpTitle', w.LPWSTR),
                ('dwX', w.DWORD), ('dwY', w.DWORD), ('dwXSize', w.DWORD), ('dwYSize', w.DWORD),
                ('dwXCountChars', w.DWORD), ('dwYCountChars', w.DWORD), ('dwFillAttribute', w.DWORD),
                ('dwFlags', w.DWORD), ('wShowWindow', w.WORD), ('cbReserved2', w.WORD),
                ('lpReserved2', ctypes.POINTER(ctypes.c_byte)),
                ('hStdInput', w.HANDLE), ('hStdOutput', w.HANDLE), ('hStdError', w.HANDLE)]
class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [('StartupInfo', STARTUPINFOW), ('lpAttributeList', ctypes.c_void_p)]
class PROCINFO(ctypes.Structure):
    _fields_ = [('hProcess', w.HANDLE), ('hThread', w.HANDLE), ('dwProcessId', w.DWORD), ('dwThreadId', w.DWORD)]
try:
    create_pc = k32.CreatePseudoConsole
except AttributeError:
    die('terminal indisponivel: ConPTY exige Windows 10 1809 ou mais novo')
create_pc.argtypes = [COORD, w.HANDLE, w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
create_pc.restype = ctypes.c_long
k32.ResizePseudoConsole.argtypes = [w.HANDLE, COORD]
k32.ResizePseudoConsole.restype = ctypes.c_long
k32.ClosePseudoConsole.argtypes = [w.HANDLE]
k32.CreatePipe.argtypes = [ctypes.POINTER(w.HANDLE), ctypes.POINTER(w.HANDLE), ctypes.c_void_p, w.DWORD]
k32.CreatePipe.restype = w.BOOL
k32.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
k32.InitializeProcThreadAttributeList.restype = w.BOOL
k32.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
k32.UpdateProcThreadAttribute.restype = w.BOOL
k32.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(PROCINFO)]
k32.CreateProcessW.restype = w.BOOL
k32.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
k32.CreateFileW.restype = w.HANDLE
k32.SetStdHandle.argtypes = [w.DWORD, w.HANDLE]
k32.GetStdHandle.argtypes = [w.DWORD]
k32.GetStdHandle.restype = w.HANDLE
k32.ReadFile.argtypes = [w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p]
k32.ReadFile.restype = w.BOOL
k32.WriteFile.argtypes = [w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p]
k32.WriteFile.restype = w.BOOL
k32.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
k32.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
inR, inW, outR, outW = w.HANDLE(), w.HANDLE(), w.HANDLE(), w.HANDLE()
if not k32.CreatePipe(ctypes.byref(inR), ctypes.byref(inW), None, 0):
    die('CreatePipe falhou (%d)' % ctypes.get_last_error())
if not k32.CreatePipe(ctypes.byref(outR), ctypes.byref(outW), None, 0):
    die('CreatePipe falhou (%d)' % ctypes.get_last_error())
hpc = w.HANDLE()
hr = create_pc(COORD(cols, rows), inR, outW, 0, ctypes.byref(hpc))
if hr != 0:
    die('CreatePseudoConsole falhou (HRESULT 0x%08x)' % (hr & 0xFFFFFFFF))
size = ctypes.c_size_t(0)
k32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))  # 1a chamada: so mede
attrs = ctypes.create_string_buffer(size.value)
if not k32.InitializeProcThreadAttributeList(attrs, 1, 0, ctypes.byref(size)):
    die('InitializeProcThreadAttributeList falhou (%d)' % ctypes.get_last_error())
if not k32.UpdateProcThreadAttribute(attrs, 0, 0x00020016, hpc, ctypes.sizeof(w.HANDLE), None, None):
    die('UpdateProcThreadAttribute falhou (%d)' % ctypes.get_last_error())
# O filho herda os VALORES dos std handles deste processo. Aqui eles sao os
# pipes do Electron, entao um app de console (cmd, bash do MSYS) escreve/le nos
# pipes do pai e nunca usa o pseudoconsole — o MSYS trava na inicializacao.
# Trocando-os pelos handles do console proprio antes do spawn, o subsistema de
# console os reescreve para o pseudoconsole no filho. Sem console: degrada para
# o comportamento anterior (apps nativos continuam funcionando).
saved = []
hin = k32.CreateFileW('CONIN$', 0xC0000000, 3, None, 3, 0, None)
hout = k32.CreateFileW('CONOUT$', 0xC0000000, 3, None, 3, 0, None)
INVALID = ctypes.c_void_p(-1).value
if hin not in (None, 0, INVALID) and hout not in (None, 0, INVALID):
    for std, h in ((0xFFFFFFF6, hin), (0xFFFFFFF5, hout), (0xFFFFFFF4, hout)):
        saved.append((std, k32.GetStdHandle(std)))
        k32.SetStdHandle(std, h)
si = STARTUPINFOEXW()
si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
si.lpAttributeList = ctypes.cast(attrs, ctypes.c_void_p)
pi = PROCINFO()
os.environ['TERM'] = 'xterm-256color'
started = k32.CreateProcessW(None, ctypes.create_unicode_buffer(subprocess.list2cmdline(argv)), None, None, False,
                             0x00080000, None, cwd or None, ctypes.byref(si), ctypes.byref(pi))
err = ctypes.get_last_error()
for std, h in saved:
    k32.SetStdHandle(std, h)
if not started:
    die('nao foi possivel iniciar %s (erro %d)' % (argv[0], err))
k32.CloseHandle(inR)
k32.CloseHandle(outW)
msvcrt.setmode(0, os.O_BINARY)
msvcrt.setmode(1, os.O_BINARY)
def pump_out():
    buf = ctypes.create_string_buffer(65536)
    n = w.DWORD(0)
    while True:
        if not k32.ReadFile(outR, buf, 65536, ctypes.byref(n), None) or n.value == 0:
            break
        try:
            os.write(1, buf.raw[:n.value])
        except OSError:
            break
RES = re.compile(rb'\x1b\[RESIZE:(\d+);(\d+)\]')
def pump_in():
    n = w.DWORD(0)
    while True:
        try:
            data = os.read(0, 65536)
        except OSError:
            break
        if not data:
            break
        def _res(m):
            k32.ResizePseudoConsole(hpc, COORD(int(m.group(1)), int(m.group(2))))
            return b''
        data = RES.sub(_res, data)
        if data and not k32.WriteFile(inW, data, len(data), ctypes.byref(n), None):
            break
reader = threading.Thread(target=pump_out, daemon=True)
reader.start()
threading.Thread(target=pump_in, daemon=True).start()
k32.WaitForSingleObject(pi.hProcess, 0xFFFFFFFF)
code = w.DWORD(0)
k32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
k32.ClosePseudoConsole(hpc)  # drena o que o shell deixou no buffer
reader.join(2)
sys.exit(code.value & 0xFF)
`

const MAX_SESSIONS = 12
const ID_RE = /^[\w.:-]{1,80}$/

interface Sess {
  child: ChildProcess
  owner: WebContents
}
const sessions = new Map<string, Sess>()
let relayPath: string | null = null

function ensureRelay(): string {
  if (relayPath && existsSync(relayPath)) return relayPath
  const dir = join(app.getPath('userData'), 'shell')
  mkdirSync(dir, { recursive: true })
  relayPath = join(dir, IS_WIN ? 'pty-relay-win.py' : 'pty-relay.py')
  writeFileSync(relayPath, IS_WIN ? RELAY_WIN : RELAY_POSIX, { mode: 0o600 })
  return relayPath
}

function python(): string {
  const py = resolvePython()
  if (!py) throw new Error('python3 não encontrado (necessário para o shell do terminal)')
  return py
}

/** git-bash: Git for Windows instalado ou o git portátil que vem com o Hermes. */
function gitBash(): string | null {
  const dirs = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], join(homedir(), 'AppData', 'Local', 'Programs')]
  for (const d of dirs) {
    if (!d) continue
    const p = join(d, 'Git', 'bin', 'bash.exe')
    if (existsSync(p)) return p
  }
  return findHermesTool('git-', join('bin', 'bash.exe'))
}

/** powershell.exe do sistema; cai no cmd.exe se não existir. */
function powershell(): string {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const candidates = [join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), process.env.COMSPEC, join(root, 'System32', 'cmd.exe')]
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? 'powershell.exe'
}

/**
 * argv do shell no Windows (no POSIX o relay usa `$SHELL -l`): git-bash se
 * houver — é o shell que o resto do cockpit/swarm assume — senão powershell.
 * HERMES_COCKPIT_SHELL sobrepõe com o caminho de um executável.
 */
function winShellArgv(cmd: string): string[] {
  const exe = process.env.HERMES_COCKPIT_SHELL?.trim() || gitBash() || powershell()
  const name = basename(exe).toLowerCase().replace(/\.exe$/, '')
  if (/^(bash|sh|zsh|fish|dash)$/.test(name)) return cmd ? [exe, '-l', '-c', cmd] : [exe, '-l', '-i']
  if (/^(powershell|pwsh)$/.test(name)) return cmd ? [exe, '-NoLogo', '-Command', cmd] : [exe, '-NoLogo']
  if (name === 'cmd') return cmd ? [exe, '/c', cmd] : [exe]
  return cmd ? [exe, '-c', cmd] : [exe]
}

function safeCwd(cwd: unknown): string {
  if (typeof cwd === 'string' && isAbsolute(cwd)) {
    try {
      if (statSync(cwd).isDirectory()) return cwd
    } catch {
      /* cai no home */
    }
  }
  return homedir()
}

const clampDim = (n: unknown, lo: number, hi: number, dflt: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt

function kill(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.child.stdin?.end()
    // Windows: matar só o python deixaria shell e conhost órfãos.
    if (IS_WIN) killTree(s.child)
    else s.child.kill('SIGTERM')
  } catch {
    /* já morto */
  }
}

export function stopAllShells(): void {
  for (const id of [...sessions.keys()]) kill(id)
}

export function register(): void {
  ipcMain.handle('ops:shell.open', (e, id: unknown, opts: { cwd?: unknown; cols?: unknown; rows?: unknown; cmd?: unknown } = {}) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('id de shell inválido')
    if (sessions.has(id)) kill(id)
    if (sessions.size >= MAX_SESSIONS) throw new Error(`limite de ${MAX_SESSIONS} shells abertos`)
    const cols = clampDim(opts.cols, 10, 500, 80)
    const rows = clampDim(opts.rows, 3, 300, 24)
    const env: NodeJS.ProcessEnv = { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' }
    delete env.ELECTRON_RUN_AS_NODE
    // cmd opcional: roda via `$SHELL -lc` (ex.: acompanhar/retomar uma instância do swarm)
    const cmd = typeof opts.cmd === 'string' ? opts.cmd.slice(0, 4000) : ''
    // POSIX: o relay escolhe o shell ($SHELL) e recebe só o cmd; Windows: argv pronto.
    const tail = IS_WIN ? winShellArgv(cmd) : cmd ? [cmd] : []
    const child = spawn(python(), [ensureRelay(), String(cols), String(rows), safeCwd(opts.cwd), ...tail], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, // sem isso o python do relay abriria um console visível
    })
    const owner = e.sender
    sessions.set(id, { child, owner })
    const send = (ch: string, payload: unknown) => {
      if (!owner.isDestroyed()) owner.send(ch, payload)
    }
    child.stdout?.on('data', (b: Buffer) => send('ops:shell.data', { id, data: new Uint8Array(b) }))
    child.stderr?.on('data', (b: Buffer) => send('ops:shell.data', { id, data: new Uint8Array(b) }))
    child.once('exit', (code) => {
      if (sessions.get(id)?.child === child) sessions.delete(id)
      send('ops:shell.exit', { id, code })
    })
    child.once('error', (err) => send('ops:shell.data', { id, data: new TextEncoder().encode(`\r\n${err.message}\r\n`) }))
    owner.once('destroyed', () => kill(id))
    // shell resolvido: a UI mostra no rodapé qual terminal de fato abriu.
    return { ok: true, shell: basename(IS_WIN ? tail[0] : process.env.SHELL || '/bin/zsh').replace(/\.exe$/i, '') }
  })
  ipcMain.handle('ops:shell.write', (_e, id: unknown, data: unknown) => {
    const s = typeof id === 'string' ? sessions.get(id) : undefined
    if (!s || typeof data !== 'string') return
    s.child.stdin?.write(data)
  })
  ipcMain.handle('ops:shell.resize', (_e, id: unknown, cols: unknown, rows: unknown) => {
    const s = typeof id === 'string' ? sessions.get(id) : undefined
    if (!s) return
    s.child.stdin?.write(`\x1b[RESIZE:${clampDim(cols, 10, 500, 80)};${clampDim(rows, 3, 300, 24)}]`)
  })
  ipcMain.handle('ops:shell.close', (_e, id: unknown) => {
    if (typeof id === 'string') kill(id)
  })
}
