import { clipboard } from 'electron'
import { handle } from './index'

// Clipboard pelo main (domínio ops — o preload só aceita os prefixos de DOMAINS).
//
// Por que não navigator.clipboard: setPermissionCheckHandler em
// src/main/index.ts só libera 'media', então readText() do renderer é negado.
// Escrever funcionaria, mas usar o mesmo caminho nos dois lados mantém o
// comportamento igual em qualquer foco/janela (e no terminal, onde o "copiar"
// não vem de uma seleção do DOM).
//
//   ops:clipboard.read() → string      ops:clipboard.write(text) → void
const MAX = 2 * 1024 * 1024 // 2 MiB: colar um arquivo inteiro no PTY não é caso de uso

export function register(): void {
  handle('ops:clipboard.read', () => clipboard.readText().slice(0, MAX))
  handle('ops:clipboard.write', (text: unknown) => {
    if (typeof text !== 'string') throw new Error('clipboard: texto inválido')
    if (text) clipboard.writeText(text.slice(0, MAX))
  })
}
