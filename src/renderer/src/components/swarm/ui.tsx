import { useEffect, useRef, useState, type ReactNode } from 'react'
import { STATUS_TONE, type RunStatus, type SwarmState } from '../../lib/swarm'

// Peças visuais pequenas do swarm. Animações: classes do shell (hc-*) e Web
// Animations API — nada de keyframes próprios aqui.

export function StatusDot({ status, className = '' }: { status: RunStatus; className?: string }) {
  const live = status === 'running' || status === 'waiting_approval'
  return (
    <span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_TONE[status].bg} ${live ? 'hc-pulse-dot' : ''} ${className}`}
    />
  )
}

/** Barra indeterminada (enquanto rodando) — deslizador via WAAPI. */
export function IndeterminateBar({ tone = 'bg-phos', className = '' }: { tone?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    // WAAPI ignora o bloco CSS de prefers-reduced-motion: barra fica estática.
    if (!el || typeof el.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const a = el.animate([{ transform: 'translateX(-110%)' }, { transform: 'translateX(260%)' }], {
      duration: 1500,
      iterations: Infinity,
      easing: 'cubic-bezier(.4,0,.2,1)',
    })
    return () => a.cancel()
  }, [])
  return (
    <span className={`relative block h-[3px] overflow-hidden rounded-full bg-edge ${className}`}>
      <span ref={ref} className={`absolute inset-y-0 left-0 w-2/5 rounded-full ${tone} opacity-80`} />
    </span>
  )
}

/** Barra de status de uma run: indeterminada se ativa, cheia/colorida se terminou. */
export function RunBar({ status, className = '' }: { status: RunStatus; className?: string }) {
  if (status === 'running') return <IndeterminateBar className={className} />
  if (status === 'waiting_approval') return <IndeterminateBar tone="bg-warn" className={className} />
  const w = status === 'queued' ? 'w-[6%]' : 'w-full'
  return (
    <span className={`relative block h-[3px] overflow-hidden rounded-full bg-edge ${className}`}>
      <span
        className={`absolute inset-y-0 left-0 ${w} rounded-full ${STATUS_TONE[status].bg} ${status === 'cancelled' ? 'opacity-40' : 'opacity-80'} transition-[width] duration-500`}
      />
    </span>
  )
}

/** Confirmação inline de 2 cliques (sem window.confirm). Volta ao normal em 4s. */
export function ConfirmButton({
  label,
  confirmLabel = 'confirmar?',
  onConfirm,
  disabled,
  title,
  className = '',
}: {
  label: ReactNode
  confirmLabel?: string
  onConfirm: () => Promise<void> | void
  disabled?: boolean
  title?: string
  className?: string
}) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      type="button"
      title={title}
      disabled={disabled || busy}
      onClick={async () => {
        if (!armed) {
          setArmed(true)
          return
        }
        setBusy(true)
        try {
          await onConfirm()
        } finally {
          setBusy(false)
          setArmed(false)
        }
      }}
      onBlur={() => setArmed(false)}
      className={`rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
        armed ? 'border-alert bg-alert/15 text-alert' : 'border-edge2 text-dim hover:border-alert/60 hover:text-alert'
      } ${className}`}
    >
      {busy ? '…' : armed ? confirmLabel : label}
    </button>
  )
}

export function Btn({
  children,
  onClick,
  disabled,
  title,
  tone = 'default',
  className = '',
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  title?: string
  tone?: 'default' | 'primary' | 'ghost'
  className?: string
  type?: 'button' | 'submit'
}) {
  const cls =
    tone === 'primary'
      ? 'bg-amber text-void font-semibold hover:brightness-110 border border-amber'
      : tone === 'ghost'
        ? 'text-dim hover:text-ink border border-transparent'
        : 'border border-edge2 text-dim hover:border-amber/50 hover:text-ink'
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${cls} ${className}`}
    >
      {children}
    </button>
  )
}

export function SkeletonRows({ n = 4, className = '' }: { n?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`} aria-busy>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="hc-shimmer h-9 rounded bg-panel2" style={{ opacity: 1 - i * 0.18 }} />
      ))}
    </div>
  )
}

/** Estado vazio honesto: sem main, domínio ausente, não instalado ou erro. */
export function SwarmGate({ s, compact = false, children }: { s: SwarmState; compact?: boolean; children: ReactNode }) {
  const pad = compact ? 'p-3' : 'p-8'
  if (s.phase === 'loading' && !s.updatedAt) return <SkeletonRows n={compact ? 2 : 5} className={pad} />
  if (s.phase === 'unavailable' || (s.phase === 'ready' && s.status && !s.status.installed)) {
    const why =
      s.phase === 'unavailable'
        ? s.error ?? 'indisponível'
        : `binários não encontrados${s.status?.binDir ? ` em ${s.status.binDir}` : ''}`
    return (
      <div className={`hc-fade-in ${pad} text-[11px] text-dim`}>
        <div className="label mb-2">swarm de claude code · inativo</div>
        <p className="text-faint">{why}.</p>
        <p className="mt-2">
          Instale com <code className="rounded bg-panel2 px-1.5 py-0.5 text-amber">npm run swarm:install</code> no
          diretório do cockpit e reabra o app.
        </p>
      </div>
    )
  }
  if (s.phase === 'error' && !s.updatedAt) {
    return (
      <div className={`hc-fade-in ${pad} text-[11px]`}>
        <div className="label mb-2 text-alert">swarm · erro</div>
        <p className="text-alert/90">{s.error}</p>
      </div>
    )
  }
  return <>{children}</>
}

export function summarizeInput(name: string, input: unknown): string {
  if (input == null) return ''
  if (typeof input !== 'object') return String(input).slice(0, 200)
  const o = input as Record<string, unknown>
  const pick = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null)
  const s =
    pick('command') ??
    pick('file_path') ??
    pick('path') ??
    pick('pattern') ??
    pick('url') ??
    pick('query') ??
    pick('description') ??
    pick('prompt')
  if (s) {
    const extra = name === 'Grep' && pick('path') ? ` em ${pick('path')}` : ''
    return (s + extra).replace(/\s+/g, ' ').slice(0, 220)
  }
  try {
    return JSON.stringify(o).slice(0, 220)
  } catch {
    return ''
  }
}

export function prettyJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
