import type { MenuItemConstructorOptions } from 'electron'

// Menu Edit. Fica separado do resto do menu (src/main/index.ts) porque é a
// peça que decide quem recebe Ctrl+C/Ctrl+V/Ctrl+A no Windows/Linux — e por
// isso tem teste (menu.test.ts). Só importa TIPO do electron: dá para testar
// com node --test, fora do Electron.
//
// Windows/Linux: os aceleradores do menu são registrados NO SISTEMA e chegam
// antes do renderer. Com `role: 'editMenu'` cru, Ctrl+C no terminal viraria
// sempre webContents.copy() (o PTY nunca receberia \x03) e Ctrl+A chamaria
// selectAll() do Chromium em vez de ir ao shell. `registerAccelerator: false`
// mantém o item e o rótulo da tecla no menu, mas devolve a tecla à página: o
// Chromium continua tratando copiar/colar/desfazer/selecionar nativamente em
// inputs, e o terminal decide o que fazer (renderer lib/term-keys.ts).
//
// macOS: menu nativo intacto (`role: 'editMenu'`) — ⌘C/⌘V/⌘A pelo sistema,
// incluindo o submenu de ditado/emoji que o papel traz.

/** Papéis de edição cujo acelerador o Chromium já implementa sozinho. */
const EDIT_ROLES = ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll'] as const

export function editMenu(platform: string = process.platform): MenuItemConstructorOptions {
  if (platform === 'darwin') return { role: 'editMenu' }
  const items: MenuItemConstructorOptions[] = []
  for (const role of EDIT_ROLES) {
    if (role === 'cut' || role === 'selectAll') items.push({ type: 'separator' })
    items.push({ role, registerAccelerator: false })
  }
  return { label: 'Edit', submenu: items }
}
