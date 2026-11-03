import { useEffect, useRef } from 'react'
import { cx } from '../ui'
import { describeComputer, type ComputerAction } from '../../lib/voice'
import { HOST_LABEL, HOST_THIS } from '../../lib/platform'

// Painel "<host> ao vivo": screenshot (ops:screenshot) + trilha de ações do
// agente — o rótulo segue a plataforma (Mac/Windows/Linux).
// O marcador de clique só aparece sobre a imagem quando a ação mirou a tela inteira
// (app="screen"); nos demais casos as coordenadas são relativas à janela capturada
// pelo tool, então o destaque fica na própria linha da ação.

export interface AgentAction {
  id: string
  name: string
  label: string
  computer: ComputerAction | null
  status: 'rodando' | 'ok' | 'erro'
  startedAt: number
  durationS?: number
  summary?: string
}

export function MacLivePanel(props: {
  shot: string | null
  shotAt: number | null
  shotError: string | null
  polling: boolean
  pinned: boolean
  onPin: (v: boolean) => void
  onOpenSettings: () => void
  actions: AgentAction[]
}) {
  const { shot, shotError, polling, pinned, actions } = props
  const listRef = useRef<HTMLDivElement | null>(null)
  const lastScreen = [...actions].reverse().find((a) => a.computer?.coordinate && a.computer.app === 'screen')

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [actions.length])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold tracking-[0.18em] text-dim uppercase">{HOST_LABEL} ao vivo</span>
        {polling && (
          <span className="flex items-center gap-1 text-[10px] tracking-wider text-cyanic uppercase">
            <span className="hc-pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-cyanic" /> ao vivo
          </span>
        )}
        {props.shotAt && !polling && (
          <span className="text-[10px] text-faint">{new Date(props.shotAt).toLocaleTimeString('pt-BR')}</span>
        )}
        <label className="no-drag ml-auto flex cursor-pointer items-center gap-1.5 text-[10px] tracking-wider text-dim uppercase">
          <input type="checkbox" className="accent-amber" checked={pinned} onChange={(e) => props.onPin(e.target.checked)} />
          fixar tela
        </label>
      </div>

      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-md border border-edge2 bg-void">
        {shot ? (
          <img src={shot} alt={`tela ${HOST_THIS}`} className="h-full w-full object-contain" draggable={false} />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-faint">
            {shotError ? null : polling ? 'capturando…' : 'a tela aparece quando o agente usar computer use (ou fixe a tela)'}
          </div>
        )}
        {polling && <div className="vo-scan pointer-events-none absolute inset-0" />}
        {lastScreen?.computer?.coordinate && shot && (
          <ScreenMarker key={lastScreen.id} x={lastScreen.computer.coordinate[0]} y={lastScreen.computer.coordinate[1]} />
        )}
        {shotError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-void/85 px-6 text-center">
            <span className="text-[11px] text-alert">{shotError}</span>
            {/permiss/i.test(shotError) && (
              <button type="button" onClick={props.onOpenSettings} className="no-drag rounded border border-edge2 px-2 py-1 text-[10px] tracking-wider text-dim uppercase hover:border-amber hover:text-amber">
                abrir Gravação de Tela
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <span className="text-[10px] font-semibold tracking-[0.18em] text-dim uppercase">Ações do agente</span>
        <span className="text-[10px] text-faint">{actions.length || ''}</span>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {actions.length === 0 && <div className="py-3 text-[11px] text-faint">nenhuma ferramenta usada nesta conversa ainda</div>}
        {actions.map((a) => (
          <ActionRow key={a.id} a={a} />
        ))}
      </div>
    </div>
  )
}

function ActionRow({ a }: { a: AgentAction }) {
  const c = a.computer
  const hasPoint = Boolean(c?.coordinate || c?.from || c?.element != null)
  const isClick = c ? /click/.test(c.action) : false
  return (
    <div
      className={cx(
        'hc-rise flex items-start gap-2 rounded border px-2 py-1.5 text-[11px]',
        c ? 'border-cyanic/30 bg-cyanic/5' : 'border-edge bg-panel2/60',
        a.status === 'erro' && 'border-alert/40',
      )}
    >
      <div className="mt-0.5 shrink-0">
        {c && hasPoint ? <TargetGlyph click={isClick} live={a.status === 'rodando'} /> : <StatusGlyph s={a.status} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cx('truncate', c ? 'text-cyanic' : 'text-ink')}>{c ? describeComputer(c) : a.label}</span>
          <span className="ml-auto shrink-0 text-[10px] text-faint">
            {a.status === 'rodando' ? 'rodando' : a.durationS != null ? `${a.durationS.toFixed(1)}s` : a.status}
          </span>
        </div>
        {c && <div className="text-[10px] tracking-wider text-faint uppercase">{a.name}</div>}
        {a.summary && <div className="truncate text-[10px] text-dim">{a.summary}</div>}
      </div>
    </div>
  )
}

function StatusGlyph({ s }: { s: AgentAction['status'] }) {
  if (s === 'rodando') return <span className="hc-pulse-dot inline-block h-2 w-2 rounded-full bg-amber" />
  if (s === 'erro') return <span className="inline-block h-2 w-2 rounded-full bg-alert" />
  return <span className="inline-block h-2 w-2 rounded-full bg-phos/70" />
}

/** Mira com ripple — destaca ações com alvo (coordenada/elemento). */
function TargetGlyph({ click, live }: { click: boolean; live: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className="text-cyanic" aria-hidden>
      <circle cx="9" cy="9" r="3" fill="currentColor" opacity={0.9} />
      <circle cx="9" cy="9" r="6.5" fill="none" stroke="currentColor" strokeWidth="1" opacity={0.5} />
      <path d="M9 0v3M9 15v3M0 9h3M15 9h3" stroke="currentColor" strokeWidth="1" opacity={0.6} />
      {(click || live) && (
        <circle cx="9" cy="9" r="3" fill="none" stroke="currentColor" strokeWidth="1.2" className="vo-ripple" />
      )}
    </svg>
  )
}

/** Cursor + ripple sobre a screenshot (coordenadas da tela inteira, aproximadas). */
function ScreenMarker({ x, y }: { x: number; y: number }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    const img = el?.parentElement?.querySelector('img')
    if (!el || !img) return
    const place = () => {
      const nw = img.naturalWidth
      const nh = img.naturalHeight
      if (!nw || !nh) return
      // screenshot em pixels físicos; coordenadas do tool em pontos lógicos
      const scale = window.devicePixelRatio || 1
      const box = img.getBoundingClientRect()
      const host = el.parentElement!.getBoundingClientRect()
      const k = Math.min(box.width / nw, box.height / nh)
      const ox = (box.width - nw * k) / 2 + (box.left - host.left)
      const oy = (box.height - nh * k) / 2 + (box.top - host.top)
      el.style.left = `${ox + x * scale * k}px`
      el.style.top = `${oy + y * scale * k}px`
      el.style.opacity = '1'
    }
    place()
    img.addEventListener('load', place)
    const ro = new ResizeObserver(place)
    ro.observe(img)
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const ring = el.querySelector('.vo-marker-ring')
    const anim = !reduce && ring
      ? ring.animate([{ transform: 'scale(0.4)', opacity: 1 }, { transform: 'scale(2.6)', opacity: 0 }], { duration: 900, iterations: 3, easing: 'cubic-bezier(0.16,1,0.3,1)' })
      : null
    return () => {
      img.removeEventListener('load', place)
      ro.disconnect()
      anim?.cancel()
    }
  }, [x, y])
  return (
    <div ref={ref} className="pointer-events-none absolute opacity-0" style={{ transition: 'left 240ms var(--hc-ease-out), top 240ms var(--hc-ease-out)' }}>
      <span className="vo-marker-ring absolute -left-3 -top-3 block h-6 w-6 rounded-full border-2 border-cyanic" />
      <svg width="16" height="20" viewBox="0 0 16 20" className="absolute -left-0.5 -top-0.5 drop-shadow" aria-hidden>
        <path d="M1 1l13 9-6 1-3 6z" fill="var(--color-ink)" stroke="var(--color-void)" strokeWidth="1.2" />
      </svg>
      <span className="absolute left-4 top-4 rounded bg-void/80 px-1 text-[9px] whitespace-nowrap text-cyanic">
        ≈ {x},{y}
      </span>
    </div>
  )
}
