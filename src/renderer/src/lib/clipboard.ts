import { hasMain, invoke } from './ipc'

// Clipboard do app. No Electron passa pelo main (ops:clipboard.*, ver
// src/main/ipc/clipboard.ts): navigator.clipboard.readText() é negado pelo
// setPermissionCheckHandler, que só libera 'media'. No dev:web cai no
// navigator.clipboard (readText depende de permissão do navegador).

export async function writeClipboard(text: string): Promise<void> {
  if (!text) return
  if (hasMain()) {
    await invoke('ops:clipboard.write', text)
    return
  }
  await navigator.clipboard.writeText(text)
}

export async function readClipboard(): Promise<string> {
  if (hasMain()) return (await invoke<string>('ops:clipboard.read')) ?? ''
  try {
    return await navigator.clipboard.readText()
  } catch {
    return '' // sem permissão no navegador: colar vira no-op em vez de erro
  }
}
