import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

// Espelho dos tipos de src/main/wsproxy.ts e src/renderer/src/env.d.ts —
// o preload é empacotado à parte e não importa do main nem do renderer.
type WsProxyState = 'connecting' | 'open' | 'error' | 'closed'
interface WsProxyStateInfo {
  state: WsProxyState
  code?: number
  reason?: string
  message?: string
}
interface WsOpenResult {
  ok: boolean
  error?: string
}
type WsData = string | ArrayBuffer

const ws = {
  open: (id: string, path?: string): Promise<WsOpenResult> => ipcRenderer.invoke('hermes:ws:open', id, path),
  send: (id: string, data: string | ArrayBuffer | Uint8Array): void => ipcRenderer.send('hermes:ws:send', id, data),
  close: (id: string, code?: number, reason?: string): void => ipcRenderer.send('hermes:ws:close', id, code, reason),
  onFrame: (fn: (id: string, data: WsData) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, data: WsData) => fn(id, data)
    ipcRenderer.on('hermes:ws:frame', listener)
    return () => {
      ipcRenderer.removeListener('hermes:ws:frame', listener)
    }
  },
  onState: (fn: (id: string, info: WsProxyStateInfo) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, info: WsProxyStateInfo) => fn(id, info)
    ipcRenderer.on('hermes:ws:state', listener)
    return () => {
      ipcRenderer.removeListener('hermes:ws:state', listener)
    }
  },
}

// Domínios de IPC do cockpit (espelho de DOMAINS em src/main/ipc/index.ts).
const DOMAIN_RE = /^(swarm|ops|storage|transcriber|notion|flows|quota):[\w.:-]+$/

interface ApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
}

const bridge = {
  /** process.platform do main ('darwin' | 'win32' | 'linux') — o renderer ajusta o chrome da janela */
  platform: process.platform as string,
  backend: () => ipcRenderer.invoke('hermes:backend'),
  api: (path: string, init?: ApiInit) => ipcRenderer.invoke('hermes:api', path, init),
  ws,
  /** pede ao main para gravar o localStorage em disco já (layout/prefs sobrevivem a kill/crash) */
  flushStorage: (): void => ipcRenderer.send('hermes:flush-storage'),
  /** caminho local de um File (drop/seletor); '' quando não há (ex.: imagem colada) */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (!DOMAIN_RE.test(channel)) return Promise.reject(new Error(`canal IPC não permitido: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: string, fn: (payload: unknown) => void): (() => void) => {
    if (!DOMAIN_RE.test(channel)) throw new Error(`canal IPC não permitido: ${channel}`)
    const listener = (_e: IpcRendererEvent, payload: unknown) => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
}

contextBridge.exposeInMainWorld('hermes', bridge)

export type HermesBridge = typeof bridge
