/// <reference types="vite/client" />

export interface BackendInfo {
  baseUrl: string
  /**
   * No Electron: `ws://127.0.0.1:<port>/api/ws` SEM token (marcador — o main
   * anexa o token no proxy). No modo dev:web: URL completa com `?token=`.
   */
  wsUrl: string
  /** Vazio ('') no Electron: o token fica só no main process. */
  token: string
  pid?: number
}

export type WsProxyState = 'connecting' | 'open' | 'error' | 'closed'

export interface WsProxyStateInfo {
  state: WsProxyState
  code?: number
  reason?: string
  message?: string
}

export interface WsOpenResult {
  ok: boolean
  error?: string
}

/** Frames do proxy: texto (JSON-RPC) ou binário (ex.: PTY). */
export type WsProxyData = string | ArrayBuffer

/**
 * Proxy WebSocket pelo main (src/main/wsproxy.ts). Conexões identificadas por
 * `id` escolhido pelo renderer; `path` é uma rota `/api/...` do serve
 * (padrão `/api/ws`; query string permitida, token é ignorado). O evento
 * `closed` é sempre o último de um id.
 */
export interface HermesWsBridge {
  open(id: string, path?: string): Promise<WsOpenResult>
  send(id: string, data: string | ArrayBuffer | Uint8Array): void
  close(id: string, code?: number, reason?: string): void
  onFrame(fn: (id: string, data: WsProxyData) => void): () => void
  onState(fn: (id: string, info: WsProxyStateInfo) => void): () => void
}

export interface ApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** serializado como JSON pelo main */
  body?: unknown
}

export interface HermesBridge {
  /** process.platform do Electron; ausente no modo dev:web */
  platform?: string
  backend(): Promise<BackendInfo>
  /** REST do serve via proxy no main (token fica no main). */
  api(path: string, init?: ApiInit): Promise<unknown>
  ws: HermesWsBridge
  /** força o flush do localStorage para o disco (fire-and-forget) */
  flushStorage?(): void
  /** caminho local de um File (drop/seletor); '' quando indisponível */
  pathForFile?(file: File): string
  /** IPC de domínio: canais `swarm:*`, `ops:*`, `storage:*`, `transcriber:*`, `quota:*`. */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  /** Eventos main→renderer dos mesmos domínios; retorna unsubscribe. */
  on(channel: string, fn: (payload: unknown) => void): () => void
}

declare global {
  interface Window {
    hermes?: HermesBridge
  }
}
