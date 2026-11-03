import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { errMsg } from '../../lib/ops'
// regra de cor e tipos de tom moram em lib/radial.ts (pura, testada) e sao
// reexportados aqui para nao quebrar os imports existentes de './ui'.
import { displayTone, INFO_TONE, usageTone, usageToneOf, type MeterTone } from '../../lib/radial'

import { useViewActive } from '../layout/views'

export { displayTone, INFO_TONE, usageTone, usageToneOf, type MeterTone }

// Peças comuns da Central Ops: carregamento assíncrono com polling, cabeçalho
// de seção (busca/refresh), confirmação inline de 2 cliques, skeleton e
// estados de erro/vazio honestos.

export interface Async<T> {
  data: T | null
  error: string | null
  loading: boolean
  /** true só na primeira carga (sem dado ainda) */
  initial: boolean
  reload: () => Promise<void>
  at: number | null
}

/** Carrega `fn`; recarrega a cada `refreshMs` (0 = só manual) enquanto a aba está visível. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], refreshMs = 0): Async<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [at, setAt] = useState<number | null>(null)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const alive = useRef(true)
  const seq = useRef(0)
  // view escondida (keep-alive do shell): o polling pausa; ao voltar, recarrega se velho
  const viewActive = useViewActive()
  const activeRef = useRef(viewActive)
  activeRef.current = viewActive
  const atRef = useRef<number | null>(null)
  atRef.current = at

  const reload = useCallback(async () => {
    const my = ++seq.current
    setLoading(true)
    try {
      const v = await fnRef.current()
      if (!alive.current || my !== seq.current) return
      setData(v)
      setError(null)
      setAt(Date.now())
    } catch (e) {
      if (!alive.current || my !== seq.current) return
      setError(errMsg(e))
    } finally {
      if (alive.current && my === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void reload()
    let t: ReturnType<typeof setInterval> | null = null
    if (refreshMs > 0) {
      t = setInterval(() => {
        if (document.visibilityState === 'visible' && activeRef.current) void reload()
      }, refreshMs)
    }
    return () => {
      alive.current = false
      if (t) clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, refreshMs, ...deps])

  useEffect(() => {
    if (!viewActive || refreshMs <= 0) return
    if (atRef.current !== null && Date.now() - atRef.current >= refreshMs) void reload()
  }, [viewActive, refreshMs, reload])

  return { data, error, loading, initial: loading && data === null && error === null, reload, at }
}

export function SectionHeader({
  title,
  subtitle,
  query,
  onQuery,
  placeholder = 'filtrar…',
  loading,
  onRefresh,
  at,
  children,
}: {
  title: string
  subtitle?: ReactNode
  query?: string
  onQuery?: (q: string) => void
  placeholder?: string
  loading?: boolean
  onRefresh?: () => void
  at?: number | null
  children?: ReactNode
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge px-4 py-2.5">
      <div className="mr-2 min-w-0">
        <h2 className="label !text-[10.5px] !text-dim">{title}</h2>
        {subtitle && <div className="mt-0.5 truncate text-[11px] text-faint">{subtitle}</div>}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {children}
        {onQuery && (
          <input
            value={query ?? ''}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            className="h-7 w-44 rounded border border-edge2 bg-void px-2 text-[11.5px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
          />
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            title={at ? `atualizado ${new Date(at).toLocaleTimeString('pt-BR')}` : 'atualizar'}
            className="flex h-7 items-center gap-1.5 rounded border border-edge2 px-2 text-[10.5px] uppercase tracking-[0.14em] text-dim hover:border-amber/50 hover:text-ink"
          >
            <span className={loading ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
            atualizar
          </button>
        )}
      </div>
    </header>
  )
}

type Tone = 'neutral' | 'amber' | 'warn' | 'phos' | 'cyanic' | 'alert'
const TONE: Record<Tone, string> = {
  neutral: 'border-edge2 text-dim',
  amber: 'border-amber/40 text-amber',
  warn: 'border-[color-mix(in_srgb,var(--color-warn)_40%,transparent)] text-warn',
  phos: 'border-phos/40 text-phos',
  cyanic: 'border-cyanic/40 text-cyanic',
  alert: 'border-alert/40 text-alert',
}

export function Tag({ children, tone = 'neutral', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={`inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10px] leading-4 ${TONE[tone]}`}>
      {children}
    </span>
  )
}

export function Btn({
  children,
  onClick,
  disabled,
  tone = 'neutral',
  title,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  tone?: Tone
  title?: string
  className?: string
}) {
  const hover =
    tone === 'alert' ? 'hover:bg-alert/10' : tone === 'amber' ? 'hover:bg-amber/10' : tone === 'phos' ? 'hover:bg-phos/10' : 'hover:bg-hover hover:text-ink'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded border px-2 text-[10.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${TONE[tone]} ${hover} ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * Ação destrutiva com confirmação inline de 2 cliques: 1º clique arma (mostra
 * `confirmLabel` em vermelho por 4s), 2º executa. Nada de window.confirm.
 */
export function ConfirmBtn({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  title,
}: {
  label: ReactNode
  confirmLabel?: ReactNode
  onConfirm: () => void | Promise<void>
  disabled?: boolean
  title?: string
}) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  const click = async () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      onClick={() => void click()}
      onBlur={() => setArmed(false)}
      disabled={disabled || busy}
      title={armed ? 'clique de novo para confirmar' : title}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded border px-2 text-[10.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        armed ? 'border-alert bg-alert/15 text-alert' : 'border-edge2 text-dim hover:border-alert/50 hover:text-alert'
      }`}
    >
      {busy ? '…' : armed ? (confirmLabel ?? 'confirmar?') : label}
    </button>
  )
}

export function SkeletonRows({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-1.5 p-4" aria-busy="true">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }, (_, c) => (
            <div
              key={c}
              className="hc-shimmer h-4 rounded bg-panel2"
              style={{ flex: c === 0 ? 2 : 1, opacity: 1 - r * 0.1, animationDelay: `${r * 60}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Fonte que não existe nesta plataforma (ex.: lsof/ps/osascript no Windows).
 * O main sinaliza pelo prefixo da mensagem — ver needPosix() em
 * src/main/ipc/ops.ts — e aqui isso vira estado neutro, não alerta vermelho:
 * feature indisponível não é falha.
 */
export const isUnavailable = (error: string | null | undefined): boolean => /^indispon[íi]vel\b/i.test(error?.trim() ?? '')

export function ErrorState({ error, onRetry, hint }: { error: string; onRetry?: () => void; hint?: ReactNode }) {
  const off = isUnavailable(error)
  return (
    <div
      className={`hc-fade-in m-4 rounded-md border px-3 py-2.5 text-[11.5px] ${
        off ? 'border-edge2 bg-panel2/40' : 'border-alert/30 bg-alert/5'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className={off ? 'text-faint' : 'text-alert'}>●</span>
        <div className="min-w-0 flex-1">
          <div className={`break-words ${off ? 'text-dim' : 'text-ink'}`}>{error}</div>
          {hint && <div className="mt-1 text-faint">{hint}</div>}
        </div>
        {onRetry && !off && (
          <Btn onClick={onRetry} tone="alert">
            tentar de novo
          </Btn>
        )}
      </div>
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="hc-fade-in px-4 py-8 text-center text-[11.5px] text-faint">{children}</div>
}

/** Cabeçalho de tabela densa. */
export function Th({ children, className = '', onClick, active }: { children?: ReactNode; className?: string; onClick?: () => void; active?: boolean }) {
  return (
    <th
      onClick={onClick}
      className={`sticky top-0 z-10 border-b border-edge bg-panel px-2 py-1.5 text-left text-[9.5px] font-normal uppercase tracking-[0.16em] ${
        active ? 'text-amber' : 'text-faint'
      } ${onClick ? 'cursor-pointer select-none hover:text-dim' : ''} ${className}`}
    >
      {children}
    </th>
  )
}

const METER_BG: Record<MeterTone, string> = {
  amber: 'bg-amber',
  phos: 'bg-phos',
  cyanic: 'bg-cyanic',
  alert: 'bg-alert',
  warn: 'bg-warn',
}

export function Meter({ pct, tone = 'amber', className = '' }: { pct: number; tone?: MeterTone; className?: string }) {
  const v = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-edge ${className}`}>
      <div className={`h-full rounded-full ${METER_BG[tone]} transition-[width] duration-300`} style={{ width: `${v}%` }} />
    </div>
  )
}


export function useLocal<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? initial
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (nv: T) => {
      setV(nv)
      try {
        localStorage.setItem(key, nv)
      } catch {
        /* sem storage: só em memória */
      }
    },
    [key],
  )
  return [v, set]
}
