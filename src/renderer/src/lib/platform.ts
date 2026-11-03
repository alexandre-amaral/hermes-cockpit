// Plataforma do host, vista pelo renderer. Vem do preload (process.platform do
// main); no modo dev:web não existe e tudo cai no neutro.
//
// Serve para rotular a UI sem dizer "Mac" em máquina Windows/Linux e para
// esconder instruções que só valem no macOS (permissões do sistema, etc.).

export const PLATFORM: string = (typeof window !== 'undefined' && window.hermes?.platform) || ''

export const IS_MAC = PLATFORM === 'darwin'
export const IS_WIN = PLATFORM === 'win32'
export const IS_LINUX = PLATFORM === 'linux'

/** Nome curto do host para rótulos: "Mac" | "Windows" | "Linux" | "sistema". */
export const HOST_LABEL = IS_MAC ? 'Mac' : IS_WIN ? 'Windows' : IS_LINUX ? 'Linux' : 'sistema'

/** "deste Mac" / "deste Windows" / "deste sistema" — para frases. */
export const HOST_THIS = IS_MAC ? 'deste Mac' : IS_WIN ? 'deste Windows' : IS_LINUX ? 'deste Linux' : 'deste sistema'
