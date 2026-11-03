import type { ReactNode } from 'react'
import { cx } from './cx'

export type EmptyArt = 'empty' | 'error' | 'offline' | 'calendar' | 'search' | 'done'

/**
 * Estado vazio/erro/indisponível honesto. `tone="error"` para falha de fonte;
 * `action` para um botão (tentar de novo, configurar…). `art` desenha uma
 * ilustração SVG leve (padrão: derivada do tone) quando não for `compact`.
 */
export function EmptyState({
  title,
  detail,
  icon,
  action,
  tone = 'neutral',
  compact,
  art,
  className,
}: {
  title: ReactNode
  detail?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  tone?: 'neutral' | 'error' | 'warn'
  compact?: boolean
  /** ilustração (só no modo não compacto); false = sem ilustração */
  art?: EmptyArt | false
  className?: string
}) {
  const showArt = !compact && art !== false
  const kind: EmptyArt = art || (tone === 'error' ? 'error' : tone === 'warn' ? 'offline' : 'empty')
  return (
    <div
      className={cx(
        'hc-fade-in flex flex-col items-center justify-center text-center',
        compact ? 'gap-1.5 px-3 py-3' : 'h-full gap-3 px-6 py-8',
        className,
      )}
    >
      {showArt ? (
        <EmptyArtSvg kind={kind} tone={tone} />
      ) : (
        icon && (
          <div
            className={cx(
              'flex items-center justify-center rounded-lg border',
              compact ? 'h-7 w-7 text-[13px]' : 'h-10 w-10 text-[17px]',
              tone === 'error' ? 'border-alert/40 text-alert' : tone === 'warn' ? 'border-[color-mix(in_srgb,var(--color-warn)_40%,transparent)] text-warn' : 'border-edge2 text-faint',
            )}
            aria-hidden
          >
            {icon}
          </div>
        )
      )}
      <div className={cx('label', tone === 'error' && 'text-alert', tone === 'warn' && 'text-warn')}>{title}</div>
      {detail && <div className={cx('max-w-sm leading-relaxed text-dim', compact ? 'text-[10px]' : 'text-[11px]')}>{detail}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

/** Ilustração de linha (grafite + acento do espaço), animada de leve. */
export function EmptyArtSvg({ kind, tone = 'neutral' }: { kind: EmptyArt; tone?: 'neutral' | 'error' | 'warn' }) {
  const accent = tone === 'error' ? 'var(--color-alert)' : tone === 'warn' ? 'var(--color-warn)' : 'var(--color-space)'
  return (
    <svg viewBox="0 0 120 80" width="120" height="80" aria-hidden className="hc-empty-art overflow-visible">
      <defs>
        <radialGradient id={`ea-${kind}`} cx="50%" cy="55%" r="55%">
          <stop offset="0%" stopColor={accent} stopOpacity="0.16" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="60" cy="44" rx="56" ry="34" fill={`url(#ea-${kind})`} />
      <g fill="none" stroke="var(--color-edge2)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'calendar' ? (
          <>
            <rect x="34" y="18" width="52" height="46" rx="5" />
            <path d="M34 30h52M46 13v9M74 13v9" />
            <g stroke={accent}>
              <path d="M44 40h8M58 40h8M72 40h4M44 50h8M58 50h4" opacity="0.8" />
            </g>
          </>
        ) : kind === 'search' ? (
          <>
            <circle cx="54" cy="38" r="17" />
            <path d="M66 50l14 14" stroke={accent} />
          </>
        ) : kind === 'offline' ? (
          <>
            <path d="M30 34a42 42 0 0 1 60 0M40 44a28 28 0 0 1 40 0M50 54a14 14 0 0 1 20 0" />
            <circle cx="60" cy="62" r="2" fill={accent} stroke="none" />
            <path d="M36 20l48 48" stroke={accent} />
          </>
        ) : kind === 'error' ? (
          <>
            <path d="M60 14l30 52H30z" />
            <path d="M60 32v16" stroke={accent} />
            <circle cx="60" cy="56" r="1.6" fill={accent} stroke="none" />
          </>
        ) : kind === 'done' ? (
          <>
            <circle cx="60" cy="40" r="22" />
            <path d="M49 40l8 8 15-16" stroke={accent} />
          </>
        ) : (
          <>
            <path d="M28 46l10-22h44l10 22v18H28z" />
            <path d="M28 46h18l4 6h20l4-6h18" />
            <path d="M52 16l8-8 8 8" stroke={accent} className="hc-float" />
          </>
        )}
      </g>
    </svg>
  )
}
