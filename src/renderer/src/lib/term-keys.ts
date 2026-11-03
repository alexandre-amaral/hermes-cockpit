// Decisão PURA de atalho do terminal integrado (sem DOM, sem xterm) — é o que
// o XtermView consulta no attachCustomKeyEventHandler e o App.tsx usa para não
// roubar as teclas do terminal com os atalhos globais. Testado em term-keys.test.ts.
//
// Padrão copiado do Windows Terminal / VS Code:
//   Ctrl+C  → com seleção copia e limpa; sem seleção manda \x03 (SIGINT).
//   Ctrl+V · Ctrl+Shift+V · Shift+Insert → cola (term.paste: respeita bracketed paste).
//   Ctrl+Shift+C · Ctrl+Insert → copia.
//   Ctrl+A  → vai para o shell (início da linha), NÃO seleciona a página.
//   Ctrl+= / Ctrl+- / Ctrl+0 → fonte do terminal (não a escala da UI).
// No macOS o modificador de clipboard é ⌘; Ctrl+C lá é SEMPRE \x03.

/** Marca o container de um terminal: o App usa para saber que o foco está no PTY. */
export const TERM_HOST_ATTR = 'data-term-host'

/** Plataforma do host (main process; no dev:web, chute pelo navigator). */
export const HOST_PLATFORM: string =
  (typeof window !== 'undefined' ? window.hermes?.platform : undefined) ??
  (typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
    ? 'darwin'
    : typeof navigator !== 'undefined' && /win/i.test(navigator.platform)
      ? 'win32'
      : 'linux')

export type TermKeyAction =
  | 'copy'
  | 'paste'
  | 'sigint'
  | 'select-all'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  /** nada a fazer: xterm processa (manda ao shell) e os atalhos globais seguem valendo */
  | 'pass'

export interface TermKeyEvent {
  /** KeyboardEvent.key (case-insensitive aqui) */
  key: string
  ctrl: boolean
  shift: boolean
  meta: boolean
  alt?: boolean
  /** term.hasSelection() no momento da tecla */
  hasSelection: boolean
  /** process.platform ('darwin' | 'win32' | 'linux'); desconhecido = não-mac */
  platform: string
}

export function keyAction(e: TermKeyEvent): TermKeyAction {
  // Alt nunca é clipboard. No Windows AltGr chega como ctrl+alt: tem de passar
  // inteiro para o shell, senão teclado ABNT2/latino perde caracteres.
  if (e.alt) return 'pass'

  const isMac = e.platform === 'darwin'
  const k = e.key.toLowerCase()

  // Insert é igual nos três sistemas (e não tem equivalente de ⌘).
  if (k === 'insert') {
    if (e.shift && !e.ctrl && !e.meta) return 'paste'
    if (e.ctrl && !e.shift && !e.meta) return 'copy'
    return 'pass'
  }

  // mac: Ctrl é controle de terminal, não clipboard. Ctrl+C = \x03 sempre.
  if (isMac && e.ctrl) return e.meta ? 'pass' : k === 'c' ? 'sigint' : 'pass'
  // Windows/Linux: tecla Win/Super é do sistema operacional.
  if (!isMac && e.meta) return 'pass'

  const mod = isMac ? e.meta : e.ctrl
  if (!mod) return 'pass'

  switch (k) {
    case 'c':
      if (e.shift) return 'copy' // Ctrl+Shift+C / ⌘⇧C: copiar e nunca interromper
      if (e.hasSelection) return 'copy'
      return isMac ? 'pass' : 'sigint'
    case 'v':
      return 'paste' // cobre Ctrl+V, Ctrl+Shift+V e ⌘V
    case 'a':
      // Ctrl+A tem de chegar ao shell (readline: início da linha). ⌘A no mac e
      // Ctrl+Shift+A selecionam o buffer do terminal.
      return isMac || e.shift ? 'select-all' : 'pass'
    case '=':
    case '+':
      return 'zoom-in'
    case '-':
    case '_':
      return 'zoom-out'
    case '0':
      return 'zoom-reset'
    default:
      return 'pass'
  }
}

/** Ações que o terminal consome: os atalhos globais do App devem ignorá-las. */
export function terminalOwnsKey(e: TermKeyEvent): boolean {
  return keyAction(e) !== 'pass'
}

/** O evento nasceu dentro de um terminal? (só faz sentido no renderer) */
export function isInTerminal(node: EventTarget | null): boolean {
  const el = node && typeof Element !== 'undefined' && node instanceof Element ? node : null
  return Boolean(el?.closest(`[${TERM_HOST_ATTR}]`))
}

/**
 * Atalho global do app que deve ceder ao terminal focado: o terminal reivindica
 * a tecla E o foco está dentro de um terminal. Sem seleção na conta — Ctrl+C
 * com seleção (copiar) ou sem (SIGINT) é sempre do terminal, nunca do app.
 */
export function terminalWantsEvent(e: KeyboardEvent): boolean {
  if (!isInTerminal(e.target)) return false
  return terminalOwnsKey({
    key: e.key,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    meta: e.metaKey,
    alt: e.altKey,
    hasSelection: true,
    platform: HOST_PLATFORM,
  })
}

export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 28
export const FONT_SIZE_DEFAULT = 12

/** Novo corpo da fonte para uma ação de zoom (clamp; 'zoom-reset' volta ao padrão). */
export function nextFontSize(current: number, action: TermKeyAction): number {
  const base = Number.isFinite(current) ? current : FONT_SIZE_DEFAULT
  const next = action === 'zoom-in' ? base + 1 : action === 'zoom-out' ? base - 1 : FONT_SIZE_DEFAULT
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, next))
}
