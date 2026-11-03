import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { readClipboard, writeClipboard } from '../../lib/clipboard'
import { apiPath, errMsg } from '../../lib/devtools'
import { invoke, onMain } from '../../lib/ipc'
import { FONT_SIZE_DEFAULT, HOST_PLATFORM, keyAction, nextFontSize, TERM_HOST_ATTR } from '../../lib/term-keys'

// Um terminal xterm.js sobre o WS /api/pty do serve (proxy no main via
// window.hermes.ws). Contrato do backend (hermes_cli/web_routers/chat_ws.py):
//   - query: profile (opcional), resume, channel, attach, fresh — sem cwd;
//   - saída: frames binários (bytes do PTY); texto só em erro de start ou
//     JSON {"type":"resume"} quando há channel;
//   - entrada: bytes/texto; resize = frame exato "\x1b[RESIZE:<cols>;<rows>]".
// Sem `attach` o PTY é 1:1 com o socket e morre ao desconectar.

export type PtyStatus = 'connecting' | 'open' | 'closed' | 'error'

// Tema grafite (tokens de index.css) — ANSI ajustado para fundo void.
const THEME: ITheme = {
  background: '#0b0d10',
  foreground: '#d6dae2',
  cursor: '#e8a33d',
  cursorAccent: '#0b0d10',
  selectionBackground: 'rgba(232, 163, 61, 0.28)',
  selectionInactiveBackground: 'rgba(138, 145, 157, 0.22)',
  black: '#1e242e',
  red: '#e5534b',
  green: '#7ee787',
  yellow: '#e8a33d',
  blue: '#6cb6ff',
  magenta: '#c297ff',
  cyan: '#56d4dd',
  white: '#d6dae2',
  brightBlack: '#525a68',
  brightRed: '#ff7b72',
  brightGreen: '#a5f3a9',
  brightYellow: '#f2c46d',
  brightBlue: '#96ccff',
  brightMagenta: '#dbb7ff',
  brightCyan: '#8ae6ec',
  brightWhite: '#f0f3f6',
}

interface Props {
  id: string
  /** 'shell' = shell real via relay de PTY no main (ops:shell.*); 'hermes' = /api/pty (hermes --tui) */
  kind?: 'shell' | 'hermes'
  /** cwd inicial do shell */
  cwd?: string | null
  /** comando inicial do shell (roda via $SHELL -lc) */
  cmd?: string
  profile?: string
  /** aba visível: refaz fit e foca */
  active: boolean
  /** incrementar para reconectar (novo PTY) */
  generation: number
  onStatus: (s: PtyStatus, detail?: string) => void
}

export function XtermView({ id, kind = 'hermes', cwd, cmd, profile, active, generation, onStatus }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const openRef = useRef(false)
  const sockId = `${id}:${generation}`
  const sockRef = useRef(sockId)
  sockRef.current = sockId
  const statusRef = useRef(onStatus)
  statusRef.current = onStatus
  const [unsupported, setUnsupported] = useState<string | null>(null)
  const fitFn = useRef<() => void>(() => {})
  // transporte da conexão atual (shell via IPC de domínio, hermes via proxy WS)
  const writeFn = useRef<(d: string) => void>(() => {})
  const resizeFn = useRef<() => void>(() => {})

  // Terminal: um por instância, vive enquanto o componente viver.
  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      theme: THEME,
      fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    fitRef.current = fit

    const sendResize = () => {
      if (!openRef.current) return
      writeFn.current(`\x1b[RESIZE:${term.cols};${term.rows}]`)
    }
    const doFit = () => {
      if (!el.offsetWidth || !el.offsetHeight) return // aba oculta
      try {
        const before = `${term.cols}x${term.rows}`
        fit.fit()
        if (`${term.cols}x${term.rows}` !== before) sendResize()
      } catch {
        /* fit antes do layout: ignora */
      }
    }
    const ro = new ResizeObserver(() => doFit())
    ro.observe(el)
    doFit()

    // ── clipboard e atalhos (ver lib/term-keys.ts para o mapa) ───────────────
    // Copiar usa term.getSelection(), que já vem com as linhas sem espaço à
    // direita e CRLF no Windows; colar usa term.paste(), que normaliza
    // CRLF→CR e respeita bracketed paste do programa em primeiro plano.
    const copySelection = () => {
      const sel = term.getSelection()
      if (!sel) return
      void writeClipboard(sel).catch(() => {})
      term.clearSelection()
    }
    const pasteClipboard = () => {
      void readClipboard()
        .then((text) => {
          if (text) term.paste(text)
        })
        .catch(() => {})
    }
    const zoom = (action: 'zoom-in' | 'zoom-out' | 'zoom-reset') => {
      const size = nextFontSize(term.options.fontSize ?? FONT_SIZE_DEFAULT, action)
      if (size === term.options.fontSize) return
      term.options.fontSize = size
      doFit()
    }

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      const action = keyAction({
        key: ev.key,
        ctrl: ev.ctrlKey,
        shift: ev.shiftKey,
        meta: ev.metaKey,
        alt: ev.altKey,
        hasSelection: term.hasSelection(),
        platform: HOST_PLATFORM,
      })
      // 'sigint' é o próprio xterm (manda \x03); 'pass' segue o fluxo normal.
      if (action === 'pass' || action === 'sigint') return true
      ev.preventDefault()
      ev.stopPropagation()
      if (action === 'copy') copySelection()
      else if (action === 'paste') pasteClipboard()
      else if (action === 'select-all') term.selectAll()
      else zoom(action)
      return false
    })

    // Botão direito como no Windows Terminal: com seleção copia, senão cola.
    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault()
      if (term.hasSelection()) copySelection()
      else {
        term.focus()
        pasteClipboard()
      }
    }
    el.addEventListener('contextmenu', onContextMenu)

    const dataSub = term.onData((d) => {
      if (openRef.current) writeFn.current(d)
    })
    fitFn.current = doFit
    resizeFn.current = sendResize

    return () => {
      ro.disconnect()
      el.removeEventListener('contextmenu', onContextMenu)
      dataSub.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // Conexão: uma por geração.
  useEffect(() => {
    if (kind !== 'shell') return
    const term = termRef.current
    const myId = sockId
    openRef.current = false
    statusRef.current('connecting')
    if (generation > 0 && term) term.write('\r\n\x1b[90m── novo shell ──\x1b[0m\r\n')
    writeFn.current = (d) => {
      void invoke('ops:shell.write', myId, d).catch(() => {})
    }
    const offData = onMain<{ id: string; data: Uint8Array }>('ops:shell.data', (p) => {
      if (p?.id === myId) termRef.current?.write(p.data)
    })
    const offExit = onMain<{ id: string; code: number | null }>('ops:shell.exit', (p) => {
      if (p?.id !== myId) return
      openRef.current = false
      statusRef.current('closed', p.code != null ? `código ${p.code}` : undefined)
      termRef.current?.write('\r\n\x1b[90m── shell encerrado ──\x1b[0m\r\n')
    })
    let cancelled = false
    invoke<{ shell?: string }>('ops:shell.open', myId, { cwd: cwd ?? undefined, cmd, cols: term?.cols ?? 80, rows: term?.rows ?? 24 })
      .then((r) => {
        if (cancelled) return
        openRef.current = true
        statusRef.current('open', r?.shell)
        resizeFn.current()
      })
      .catch((e: unknown) => {
        if (cancelled) return
        statusRef.current('error', errMsg(e))
        termRef.current?.write(`\r\n\x1b[31m${errMsg(e)}\x1b[0m\r\n`)
      })
    return () => {
      cancelled = true
      openRef.current = false
      offData()
      offExit()
      void invoke('ops:shell.close', myId).catch(() => {})
    }
    // cwd só vale na abertura; generation força novo shell
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, sockId, generation])

  useEffect(() => {
    if (kind === 'shell') return
    const bridge = window.hermes?.ws
    if (!bridge) {
      setUnsupported('terminal indisponível fora do app (sem proxy WS do main)')
      statusRef.current('error', 'sem main process')
      return
    }
    const term = termRef.current
    const myId = sockId
    openRef.current = false
    statusRef.current('connecting')
    if (generation > 0 && term) term.write('\r\n\x1b[90m── reconectando ──\x1b[0m\r\n')
    writeFn.current = (d) => bridge.send(myId, d)

    const offFrame = bridge.onFrame((fid, data) => {
      if (fid !== myId || !termRef.current) return
      if (typeof data === 'string') {
        if (data.startsWith('{')) {
          try {
            const j = JSON.parse(data) as { type?: string }
            if (j && typeof j.type === 'string') return // controle (ex.: resume)
          } catch {
            /* texto comum */
          }
        }
        termRef.current.write(data)
      } else {
        termRef.current.write(new Uint8Array(data))
      }
    })
    const offState = bridge.onState((sid, info) => {
      if (sid !== myId) return
      if (info.state === 'open') {
        openRef.current = true
        statusRef.current('open')
        resizeFn.current()
      } else if (info.state === 'closed' || info.state === 'error') {
        openRef.current = false
        const why = [info.code, info.reason || info.message].filter(Boolean).join(' ')
        statusRef.current(info.state === 'error' ? 'error' : 'closed', why || undefined)
        termRef.current?.write(`\r\n\x1b[90m── sessão encerrada${why ? ` (${why})` : ''} ──\x1b[0m\r\n`)
      }
    })

    let cancelled = false
    bridge
      .open(myId, apiPath('/api/pty', { profile }))
      .then((r) => {
        if (cancelled) return
        if (!r.ok) {
          statusRef.current('error', r.error ?? 'falha ao abrir /api/pty')
          termRef.current?.write(`\r\n\x1b[31m${r.error ?? 'falha ao abrir /api/pty'}\x1b[0m\r\n`)
        } else {
          openRef.current = true
          statusRef.current('open')
          resizeFn.current()
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) statusRef.current('error', errMsg(e))
      })

    return () => {
      cancelled = true
      openRef.current = false
      offFrame()
      offState()
      try {
        bridge.close(myId, 1000, 'tab closed')
      } catch {
        /* já fechado */
      }
    }
    // profile fixo por instância; generation força nova conexão
  }, [kind, sockId, profile, generation])

  // Ao ficar visível: fit + foco.
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      fitFn.current()
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active])

  return (
    // {...{[TERM_HOST_ATTR]: ''}}: marca o terminal para os atalhos globais do
    // App cederem as teclas de clipboard/zoom quando o foco está aqui.
    <div className="relative h-full w-full bg-void" {...{ [TERM_HOST_ATTR]: '' }}>
      <div ref={host} className="absolute inset-0 px-2 py-1" />
      {unsupported && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-[11px] text-faint">{unsupported}</div>
      )}
    </div>
  )
}
