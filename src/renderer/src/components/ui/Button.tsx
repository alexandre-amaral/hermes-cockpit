import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
export type ButtonSize = 'xs' | 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** mostra Spinner e desabilita */
  loading?: boolean
  icon?: ReactNode
}

const VARIANT: Record<ButtonVariant, string> = {
  // hc-btn-primary é só um gancho de tema (presets podem sobrescrever).
  primary: 'hc-btn-primary border-amber/70 bg-amber text-void font-semibold hover:brightness-110 hover:hc-glow-amber',
  secondary: 'border-edge2 bg-panel2 text-ink hover:border-faint hover:bg-edge/60',
  outline: 'border-edge2 bg-transparent text-dim hover:border-amber/60 hover:text-amber',
  ghost: 'border-transparent bg-transparent text-dim hover:bg-hover hover:text-ink',
  danger: 'border-alert/50 bg-transparent text-alert hover:bg-alert/10 hover:border-alert',
}

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-6 gap-1 px-2 text-[10px] rounded',
  sm: 'h-7 gap-1.5 px-2.5 text-[11px] rounded-md',
  md: 'h-8 gap-2 px-3 text-[12px] rounded-md',
}

/** Botão base do cockpit. `type="button"` por padrão (nunca submete sem querer). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'no-drag hc-press inline-flex shrink-0 items-center justify-center border whitespace-nowrap select-none',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === 'md' ? 12 : 10} /> : icon}
      {children}
    </button>
  )
})
