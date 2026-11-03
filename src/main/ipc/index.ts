import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { register as registerClipboard } from './clipboard'
import { register as registerFlows } from './flows'
import { register as registerNotion } from './notion'
import { register as registerOps } from './ops'
import { register as registerQuota } from './quota'
import { register as registerShell } from './shell'
import { register as registerWindows } from './windows'
import { register as registerStorage } from './storage'
import { register as registerSwarm } from './swarm'
import { register as registerTranscriber } from './transcriber'

// Registro dos domínios de IPC do cockpit. CONTRATO (fixo):
// - canais renderer→main: `<domínio>:<ação>` via ipcRenderer.invoke, expostos
//   no preload como window.hermes.invoke(channel, ...args). Domínios permitidos
//   = DOMAINS abaixo (o preload recusa qualquer outro prefixo).
// - eventos main→renderer: `<domínio>:<evento>` via broadcast(); o renderer
//   assina com window.hermes.on(channel, fn).
// Cada domínio vive em ./<domínio>.ts e exporta register(): void, usando
// handle() daqui (que valida o prefixo e serializa erros como Error simples).

export const DOMAINS = ['swarm', 'ops', 'storage', 'transcriber', 'notion', 'flows', 'quota'] as const
export type Domain = (typeof DOMAINS)[number]

export function handle<A extends unknown[], R>(
  channel: `${Domain}:${string}`,
  fn: (...args: A) => R | Promise<R>,
): void {
  ipcMain.handle(channel, async (_e: IpcMainInvokeEvent, ...args: unknown[]) => {
    try {
      return await fn(...(args as A))
    } catch (err) {
      // Error atravessa o IPC só com a mensagem; mantenha-a útil para a UI.
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })
}

/** Evento main→renderer para todas as janelas vivas. */
export function broadcast(channel: `${Domain}:${string}`, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

export function registerDomainIpc(): void {
  registerSwarm()
  registerOps()
  registerStorage()
  registerTranscriber()
  registerNotion()
  registerFlows()
  registerQuota()
  registerShell()
  registerClipboard()
  registerWindows()
}
