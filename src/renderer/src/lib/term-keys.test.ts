import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, keyAction, nextFontSize, terminalOwnsKey, type TermKeyEvent } from './term-keys.ts'

/** Evento mínimo: sem modificadores, sem seleção, Windows. */
function ev(key: string, over: Partial<TermKeyEvent> = {}): TermKeyEvent {
  return { key, ctrl: false, shift: false, meta: false, hasSelection: false, platform: 'win32', ...over }
}
const win = (key: string, over: Partial<TermKeyEvent> = {}) => ev(key, over)
const mac = (key: string, over: Partial<TermKeyEvent> = {}) => ev(key, { platform: 'darwin', ...over })

test('Ctrl+C: com seleção copia, sem seleção interrompe', () => {
  assert.equal(keyAction(win('c', { ctrl: true, hasSelection: true })), 'copy')
  assert.equal(keyAction(win('c', { ctrl: true })), 'sigint')
  // maiúscula (layout com CapsLock) não muda nada
  assert.equal(keyAction(win('C', { ctrl: true, hasSelection: true })), 'copy')
})

test('Ctrl+Shift+C copia e nunca interrompe (mesmo sem seleção)', () => {
  assert.equal(keyAction(win('C', { ctrl: true, shift: true, hasSelection: true })), 'copy')
  assert.equal(keyAction(win('C', { ctrl: true, shift: true })), 'copy')
})

test('colar: Ctrl+V, Ctrl+Shift+V e Shift+Insert', () => {
  assert.equal(keyAction(win('v', { ctrl: true })), 'paste')
  assert.equal(keyAction(win('V', { ctrl: true, shift: true })), 'paste')
  assert.equal(keyAction(win('Insert', { shift: true })), 'paste')
})

test('Ctrl+Insert copia; Insert sozinho vai para o shell', () => {
  assert.equal(keyAction(win('Insert', { ctrl: true, hasSelection: true })), 'copy')
  assert.equal(keyAction(win('Insert', { ctrl: true })), 'copy')
  assert.equal(keyAction(win('Insert')), 'pass')
  assert.equal(keyAction(win('Insert', { ctrl: true, shift: true })), 'pass')
})

test('Ctrl+A vai para o shell no Windows/Linux; Ctrl+Shift+A seleciona tudo', () => {
  assert.equal(keyAction(win('a', { ctrl: true })), 'pass')
  assert.equal(keyAction(ev('a', { ctrl: true, platform: 'linux' })), 'pass')
  assert.equal(keyAction(win('A', { ctrl: true, shift: true })), 'select-all')
})

test('macOS: ⌘ é clipboard, Ctrl+C é sempre SIGINT', () => {
  assert.equal(keyAction(mac('c', { ctrl: true, hasSelection: true })), 'sigint')
  assert.equal(keyAction(mac('c', { ctrl: true })), 'sigint')
  assert.equal(keyAction(mac('c', { meta: true, hasSelection: true })), 'copy')
  // ⌘C sem seleção não é SIGINT nem engole a tecla (menu Edit continua valendo)
  assert.equal(keyAction(mac('c', { meta: true })), 'pass')
  assert.equal(keyAction(mac('v', { meta: true })), 'paste')
  assert.equal(keyAction(mac('a', { meta: true })), 'select-all')
  // Ctrl+V no mac é controle de terminal (\x16), não colar
  assert.equal(keyAction(mac('v', { ctrl: true })), 'pass')
  assert.equal(keyAction(mac('a', { ctrl: true })), 'pass')
})

test('Windows/Linux: tecla Win/Super não é clipboard', () => {
  assert.equal(keyAction(win('c', { meta: true, hasSelection: true })), 'pass')
  assert.equal(keyAction(win('v', { meta: true })), 'pass')
})

test('Alt (e AltGr = ctrl+alt) sempre passa para o shell', () => {
  assert.equal(keyAction(win('c', { ctrl: true, alt: true, hasSelection: true })), 'pass')
  assert.equal(keyAction(win('v', { ctrl: true, alt: true })), 'pass')
  assert.equal(keyAction(win('v', { alt: true })), 'pass')
})

test('zoom da fonte do terminal', () => {
  assert.equal(keyAction(win('=', { ctrl: true })), 'zoom-in')
  assert.equal(keyAction(win('+', { ctrl: true, shift: true })), 'zoom-in')
  assert.equal(keyAction(win('-', { ctrl: true })), 'zoom-out')
  assert.equal(keyAction(win('_', { ctrl: true, shift: true })), 'zoom-out')
  assert.equal(keyAction(win('0', { ctrl: true })), 'zoom-reset')
  assert.equal(keyAction(mac('=', { meta: true })), 'zoom-in')
})

test('teclas que o terminal não reivindica (atalhos globais do app seguem valendo)', () => {
  for (const k of ['k', 'b', 'j', 't', '.', ',', '1', '9', 'f', 'x', 'l', 'd', 'Enter', 'Tab', 'ArrowUp']) {
    assert.equal(keyAction(win(k, { ctrl: true })), 'pass', `Ctrl+${k} deveria passar`)
    assert.equal(terminalOwnsKey(win(k, { ctrl: true })), false, `Ctrl+${k} não é do terminal`)
  }
  // ⌘⇧1/2/3 (espaços) chegam como !/@/# — não são do terminal
  for (const k of ['!', '@', '#']) assert.equal(keyAction(win(k, { ctrl: true, shift: true })), 'pass')
  // Ctrl+Shift+V é do terminal (colar) e tem de vencer o atalho de voz do app
  assert.equal(terminalOwnsKey(win('v', { ctrl: true, shift: true })), true)
  // letra sem modificador nunca é do terminal
  assert.equal(keyAction(win('c')), 'pass')
  assert.equal(terminalOwnsKey(win('a')), false)
})

test('nextFontSize respeita limites e reset', () => {
  assert.equal(nextFontSize(12, 'zoom-in'), 13)
  assert.equal(nextFontSize(12, 'zoom-out'), 11)
  assert.equal(nextFontSize(20, 'zoom-reset'), FONT_SIZE_DEFAULT)
  assert.equal(nextFontSize(FONT_SIZE_MAX, 'zoom-in'), FONT_SIZE_MAX)
  assert.equal(nextFontSize(FONT_SIZE_MIN, 'zoom-out'), FONT_SIZE_MIN)
  assert.equal(nextFontSize(Number.NaN, 'zoom-in'), FONT_SIZE_DEFAULT + 1)
})
