import type { ReactNode } from 'react'
import { cx } from './cx'

// 'amber' = acento (destaque neutro, ex.: "atual"); 'warn' = aviso/pendência
// (--color-warn). Os fundos usam os tokens *-soft, que valem a própria cor a
// 10% — igual ao bg-<cor>/10 de antes.
export type BadgeTone = 'neutral' | 'amber' | 'warn' | 'phos' | 'cyanic' | 'alert'

const TONE: Record<BadgeTone, string> = {
  neutral: 'border-edge2 text-dim bg-panel2/60',
  amber: 'border-amber/50 text-amber bg-amber/10',
  warn: 'border-[color-mix(in_srgb,var(--color-warn)_50%,transparent)] text-warn bg-warn-soft',
  phos: 'border-phos/40 text-phos bg-phos-soft',
  cyanic: 'border-cyanic/40 text-cyanic bg-cyanic-soft',
  alert: 'border-alert/50 text-alert bg-alert-soft',
}

/** Rótulo/contador pequeno. `count` vira pílula numérica (99+); `pulse` anima um ponto. */
export function Badge({
  tone = 'neutral',
  children,
  count,
  pulse,
  className,
  title,
}: {
  tone?: BadgeTone
  children?: ReactNode
  count?: number
  pulse?: boolean
  className?: string
  title?: string
}) {
  const text = count != null ? (count > 99 ? '99+' : String(count)) : children
  return (
    <span
      title={title}
      className={cx(
        'hc-fade-in inline-flex shrink-0 items-center gap-1 rounded-full border leading-none tabular-nums',
        count != null ? 'h-4 min-w-4 justify-center px-1 text-[9px] font-semibold' : 'px-1.5 py-0.5 text-[9px] tracking-wider uppercase',
        TONE[tone],
        className,
      )}
    >
      {pulse && <Dot tone={tone} pulse />}
      {text}
    </span>
  )
}

const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-faint',
  amber: 'bg-amber',
  warn: 'bg-warn',
  phos: 'bg-phos',
  cyanic: 'bg-cyanic',
  alert: 'bg-alert',
}

/** Ponto de status (opcionalmente pulsante — usa hc-pulse-dot). */
export function Dot({ tone = 'neutral', pulse, className }: { tone?: BadgeTone; pulse?: boolean; className?: string }) {
  return <span aria-hidden className={cx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', DOT[tone], pulse && 'hc-pulse-dot', className)} />
}
