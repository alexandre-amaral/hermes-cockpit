import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** nome acessível (obrigatório: botão só com ícone) */
  label: string
  active?: boolean
  size?: 'sm' | 'md'
  tone?: 'default' | 'danger'
  children: ReactNode
}

/** Botão quadrado só com ícone (prefira <Icon/>). `active` = aria-pressed + realce na cor do espaço. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, size = 'md', tone = 'default', className, title, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={active}
      title={title ?? label}
      className={cx(
        'no-drag hc-press flex shrink-0 items-center justify-center rounded-md border disabled:opacity-40',
        size === 'md' ? 'h-7 w-7 text-[13px]' : 'h-5 w-5 text-[11px]',
        active
          ? 'border-space/50 bg-space/10 text-space shadow-[0_0_10px_-3px_var(--color-space)]'
          : tone === 'danger'
            ? 'border-transparent text-faint hover:border-alert/40 hover:bg-alert/10 hover:text-alert'
            : 'border-transparent text-faint hover:border-edge2 hover:bg-hover hover:text-ink',
        className,
      )}
      {...rest}
    />
  )
})
