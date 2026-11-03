import { useEffect, useRef, useState, type ReactNode } from 'react'
import { displayTone, radialGeometry, radialLabel, toneColor, type MeterTone } from '../../lib/radial'
import { Icon, type IconName } from './Icon'
import { cx } from './cx'

// Donut de progresso em SVG puro (sem dependência). Substitui a barra `Meter`
// nos cartões de uso de recursos (widget Sistema, Ops › Sistema, rodapé da rail).
//
//   0%   → só o trilho escuro (sem o pontinho da ponta arredondada)
//   50%  → meio círculo
//   100% → anel fechado, sem gap
//   null → anel vazio e "—" no centro
//
// Começa às 12h e cresce no sentido horário; o arco anima por stroke-dashoffset
// (~400ms, `.hc-radial-arc` em index.css).

export interface RadialMeterProps {
  /** 0–100; null/indefinido = sem dado (anel vazio + "—") */
  value: number | null | undefined
  /** cor do anel (token do tema) */
  tone?: MeterTone
  /** diâmetro em px */
  size?: number
  /** espessura do anel em px */
  strokeWidth?: number
  /** rótulo acessível (aria-label); também vira <title> do SVG */
  aria: string
  /** conteúdo central; padrão = a % inteira */
  children?: ReactNode
  /** linha pequena sob a % dentro do anel (ex.: "vram") */
  caption?: ReactNode
  /** classe extra no wrapper */
  className?: string
  /** tooltip nativo do wrapper */
  title?: string
}

const reduced = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

export function RadialMeter({
  value,
  tone = 'phos',
  size = 56,
  strokeWidth = 5,
  aria,
  children,
  caption,
  className,
  title,
}: RadialMeterProps) {
  const g = radialGeometry(value, size, strokeWidth)
  const color = toneColor(tone)
  // anima do vazio até o valor na 1ª pintura; depois a transição CSS cuida
  const [drawn, setDrawn] = useState(() => (reduced() ? g.dashoffset : g.circumference))
  const raf = useRef(0)
  useEffect(() => {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => setDrawn(g.dashoffset))
    return () => cancelAnimationFrame(raf.current)
  }, [g.dashoffset])

  const center = size / 2
  return (
    <div
      className={cx('hc-radial relative shrink-0', className)}
      style={{ width: size, height: size, ['--hc-radial-color' as string]: color }}
      title={title}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        overflow="visible"
        role="meter"
        aria-label={aria}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(g.pct == null ? {} : { 'aria-valuenow': Math.round(g.pct) })}
        aria-valuetext={radialLabel(g.pct)}
        className="block -rotate-90"
      >
        <title>{`${aria} · ${radialLabel(g.pct)}`}</title>
        <circle
          cx={center}
          cy={center}
          r={g.r}
          fill="none"
          stroke="var(--color-edge)"
          strokeWidth={strokeWidth}
          className="hc-radial-track"
        />
        {g.showArc && (
          <circle
            cx={center}
            cy={center}
            r={g.r}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap={g.linecap}
            strokeDasharray={g.dasharray}
            strokeDashoffset={drawn}
            className="hc-radial-arc"
          />
        )}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span
          className="tabular-nums"
          style={{
            // com caption o número cede espaço; o piso de 9px mantém "100%"
            // legível nos donuts pequenos da rail (36–40px)
            fontSize: Math.max(9, Math.round(size * (caption ? 0.23 : 0.28))),
            color: g.pct == null ? 'var(--color-faint)' : color,
          }}
        >
          {children ?? radialLabel(g.pct)}
        </span>
        {caption && (
          <span className="mt-[2px] max-w-full truncate px-1 text-[8px] text-faint uppercase tracking-[0.1em]">{caption}</span>
        )}
      </div>
    </div>
  )
}

/**
 * Cartão de métrica: ícone + rótulo no topo, donut no centro com a % grande
 * dentro e o detalhe embaixo (ex.: "453 GB / 465 GB"). Usado no widget de
 * painel Sistema e na Ops › Sistema — mesma peça, só muda o tamanho.
 */
export function RadialStat({
  icon,
  label,
  value,
  tone,
  detail,
  sub,
  size = 56,
  strokeWidth = 5,
  title,
  center,
  className,
}: {
  icon?: IconName
  label: string
  value: number | null | undefined
  tone?: MeterTone
  /** linha principal embaixo do anel */
  detail?: ReactNode
  /** linha secundária menor (ex.: "12.1 GB livres") */
  sub?: ReactNode
  size?: number
  strokeWidth?: number
  title?: string
  /** conteúdo central alternativo (padrão: a %) */
  center?: ReactNode
  className?: string
}) {
  const t = tone ?? displayTone(value)
  return (
    <div
      className={cx(
        'flex min-w-0 flex-col items-center gap-1.5 rounded-lg border border-edge bg-panel2/40 px-1.5 py-2',
        className,
      )}
      title={title ?? label}
    >
      <div className="flex w-full min-w-0 items-center justify-center gap-1">
        {icon && <Icon name={icon} size={11} className="text-dim" />}
        <span className="min-w-0 truncate text-[10.5px] text-dim" title={label}>
          {label}
        </span>
      </div>
      <RadialMeter value={value} tone={t} size={size} strokeWidth={strokeWidth} aria={label}>
        {center}
      </RadialMeter>
      {detail != null && detail !== '' && (
        <div className="w-full truncate text-center text-[10px] text-faint tabular-nums">{detail}</div>
      )}
      {sub != null && sub !== '' && <div className="-mt-1 w-full truncate text-center text-[9px] text-faint">{sub}</div>}
    </div>
  )
}
