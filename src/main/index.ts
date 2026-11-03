import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, session, shell, type MenuItemConstructorOptions } from 'electron'
import { apiFetch, type ApiInit, ensureBackend, hasBackend, stopBackend, stopBackendGracefully } from './backend'
import { registerDomainIpc } from './ipc'
import { editMenu } from './menu'
import { stopAllShells } from './ipc/shell'
import { setWindowFactory } from './ipc/windows'
import { stopSwarmWatch } from './ipc/swarm'
import { stopTranscriber } from './ipc/transcriber'
import { closeAllWs, registerWsProxy } from './wsproxy'

// Topbar do renderer assumida com ~44px de altura: os traffic lights (12px)
// ficam centrados verticalmente nela (y=15) e a 14px da borda esquerda. O
// renderer deve reservar ~80px à esquerda da topbar para não colidir.
const TRAFFIC_LIGHTS = { x: 14, y: 15 }

/** Grava no disco o localStorage pendente (prefs/painéis/tamanhos). Nunca lança. */
function flushRendererStorage(): void {
  try {
    session.defaultSession.flushStorageData()
  } catch {
    /* app ainda iniciando ou já encerrando */
  }
}

function createWindow(query: Record<string, string> = {}): void {
  const chat = query.window === 'chat'
  const win = new BrowserWindow({
    width: chat ? 760 : 1480,
    height: chat ? 860 : 920,
    // Abaixo de 1100px lógicos o renderer entra no modo estreito (rail/dock em
    // gavetas, strip com scroll) — a janela precisa poder chegar lá.
    minWidth: chat ? 420 : 720,
    minHeight: chat ? 480 : 700,
    backgroundColor: '#0b0d10',
    title: 'Hermes Cockpit',
    // macOS: barra transparente com traffic lights sobre a topbar do renderer.
    // Windows/Linux: moldura nativa (controles de janela do sistema).
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: TRAFFIC_LIGHTS } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // localStorage do Chromium só vai ao disco a cada ~5s ou no shutdown limpo;
  // fechar a janela é um ponto seguro para forçar o flush do layout salvo.
  win.on('close', flushRendererStorage)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    const u = new URL(process.env.ELECTRON_RENDERER_URL)
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
    void win.loadURL(u.toString())
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { query })
  }
}

// Menu da aplicação sem os papéis de zoom do Chromium (zoomIn/zoomOut/
// resetZoom): ⌘= / ⌘- / ⌘0 ficam com o renderer, que aplica a escala da UI
// via CSS zoom em #root (ver renderer lib/theme.ts). Mantém Edit (copiar/colar) e Window.
function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Nova janela de chat', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow({ window: 'chat' }) },
        { label: 'Nova janela do cockpit', accelerator: 'CmdOrCtrl+Alt+N', click: () => createWindow() },
        { type: 'separator' },
        ...(process.platform === 'darwin' ? [{ role: 'close' as const }] : [{ role: 'quit' as const }]),
      ],
    },
    editMenu(),
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Origem do próprio renderer (empacotado: file://; dev: servidor do electron-vite). */
function isOwnOrigin(url: string): boolean {
  if (url.startsWith('file://')) return true
  const dev = process.env.ELECTRON_RENDERER_URL
  return Boolean(dev && url.startsWith(new URL(dev).origin))
}

void app.whenReady().then(() => {
  installMenu()
  // Microfone (ditado/transcriber) só para a página do próprio cockpit; iframes
  // de preview (localhost:<porta>) e qualquer outra origem não ganham mídia.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const origin = details.requestingUrl || wc.getURL()
    cb(permission === 'media' && isOwnOrigin(origin))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && isOwnOrigin(origin))
  // O renderer recebe a info do backend MASCARADA: sem token, wsUrl sem
  // ?token=. WS e REST passam pelo main (wsproxy / hermes:api), que conhece o
  // token. O wsUrl continua servindo de marcador para HermesRpc.connect().
  ipcMain.handle('hermes:backend', async () => {
    const info = await ensureBackend()
    const ws = new URL(info.wsUrl)
    ws.searchParams.delete('token')
    return { baseUrl: info.baseUrl, wsUrl: ws.toString(), token: '', pid: info.pid }
  })
  ipcMain.on('hermes:flush-storage', flushRendererStorage)
  ipcMain.handle('hermes:api', (_event, path: string, init?: ApiInit) => apiFetch(path, init ?? {}))
  registerWsProxy()
  setWindowFactory(createWindow)
  registerDomainIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Lifecycle: o serve morre com o app ──────────────────────────────────────
// Camadas (da mais graciosa à última trincheira):
//   1. before-quit: adia o quit, fecha WS, SIGTERM no grupo do serve, espera
//      até 2.5s (flush de transcripts), SIGKILL se preciso, e então sai.
//   2. will-quit: SIGTERM síncrono (idempotente) caso o 1 não tenha rodado.
//   3. process 'exit': SIGKILL síncrono em qualquer filho ainda vivo.
//   4. SIGTERM/SIGINT/SIGHUP no main → app.quit() (cai no 1), com timeout.
//   5. Main morto por SIGKILL/crash: o watchdog do próprio serve
//      (HERMES_PARENT_PID, ver backend.ts) encerra o serve em ~2s.
let quitReady = false
let quitting = false

/** Filhos dos domínios (transcriber server.py, WS ao vivo). Nunca lança: o quit segue. */
function stopDomainChildren(): void {
  try {
    stopTranscriber()
  } catch (err) {
    console.error('[cockpit] stopTranscriber falhou no quit:', err)
  }
  try {
    stopAllShells()
    stopSwarmWatch() // só o fs.watch; runs do swarm são detached e seguem vivas
  } catch (err) {
    console.error('[cockpit] stopSwarmWatch falhou no quit:', err)
  }
}

app.on('before-quit', (event) => {
  flushRendererStorage()
  if (quitReady) return
  stopDomainChildren()
  closeAllWs()
  if (!hasBackend()) {
    stopBackend() // marca shuttingDown — nenhum spawn novo durante o quit
    quitReady = true
    return
  }
  event.preventDefault()
  if (quitting) return
  quitting = true
  void stopBackendGracefully(2500).finally(() => {
    quitReady = true
    app.quit()
  })
})

app.on('will-quit', () => {
  flushRendererStorage()
  stopDomainChildren()
  closeAllWs()
  stopBackend()
})

process.on('exit', () => {
  stopBackend('SIGKILL')
})

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    // Fallback se o quit gracioso travar: mata o grupo e sai mesmo assim.
    setTimeout(() => {
      stopBackend('SIGKILL')
      process.exit(0)
    }, 5000).unref()
    if (app.isReady()) app.quit()
    else {
      stopBackend('SIGKILL')
      process.exit(0)
    }
  })
}
