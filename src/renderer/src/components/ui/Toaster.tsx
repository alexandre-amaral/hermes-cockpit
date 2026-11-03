import { useEffect, useRef, useState } from 'react'
import { dismissToast, subscribeToasts, type ToastItem, type ToastTone } from '../../lib/toast'
import { cx } from './cx'

const TONE: Record<ToastTone, { bar: string; icon: string; glyph: string; title: string }> = {
  info: { bar: 'bg-cyanic', icon: 'text-cyanic border-cyanic/40', glyph: 'i', title: 'text-ink' },
  ok: { bar: 'bg-phos', icon: 'text-phos border-phos/40', glyph: '✓', title: 'text-ink' },
  warn: { bar: 'bg-amber', icon: 'text-amber border-amber/50', glyph: '!', title: 'text-amber' },
  error: { bar: 'bg-alert', icon: 'text-alert border-alert/50', glyph: '×', title: 'text-alert' },
}

const EXIT_MS = 170

interface Shown extends ToastItem {
  leaving?: boolean
}

/**
 * Pilha de toasts (lib/toast.ts) no canto inferior direito. Entrada hc-rise,
 * saída hc-sink; erros com aria-live assertivo. Montado uma vez pelo App.
 */
export function Toaster() {
  const [shown, setShown] = useState<Shown[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const t = timers.current
    const off = subscribeToasts((items) => {
      setShown((prev) => {
        const live = new Set(items.map((i) => i.id))
        const next: Shown[] = []
        for (const p of prev) {
          if (live.has(p.id)) next.push(items.find((i) => i.id === p.id) ?? p)
          else {
            if (!p.leaving && !t.has(p.id)) {
              t.set(
                p.id,
                setTimeout(() => {
                  t.delete(p.id)
                  setShown((s) => s.filter((x) => x.id !== p.id))
                }, EXIT_MS),
              )
            }
            next.push({ ...p, leaving: true })
          }
        }
        for (const it of items) if (!prev.some((p) => p.id === it.id)) next.push(it)
        return next
      })
    })
    return () => {
      off()
      for (const h of t.values()) clearTimeout(h)
      t.clear()
    }
  }, [])

  if (!shown.length) return null
  return (
    <div className="no-drag pointer-events-none fixed right-3 bottom-3 z-[80] flex w-[min(360px,calc(100vw-24px))] flex-col items-stretch gap-2">
      {shown.map((t) => (
        <ToastCard key={t.id} t={t} />
      ))}
    </div>
  )
}

function ToastCard({ t }: { t: Shown }) {
  const tone = TONE[t.tone ?? 'info']
  const ms = t.durationMs ?? (t.tone === 'error' ? 8000 : 4000)
  return (
    <div
      role={t.tone === 'error' ? 'alert' : 'status'}
      aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
      className={cx(
        'hc-glass pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-lg py-2.5 pr-2 pl-3',
        t.leaving ? 'hc-sink' : 'hc-rise',
      )}
    >
      <span aria-hidden className={cx('absolute inset-y-0 left-0 w-[2px]', tone.bar)} />
      <span
        aria-hidden
        className={cx('mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-bold', tone.icon)}
      >
        {tone.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cx('text-[12px] leading-snug', tone.title)}>{t.title}</div>
        {t.detail && <div className="mt-0.5 line-clamp-4 text-[11px] leading-snug break-words text-dim">{t.detail}</div>}
      </div>
      <button
        type="button"
        aria-label="fechar"
        onClick={() => dismissToast(t.id)}
        className="hc-press -mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[12px] text-faint hover:bg-hover hover:text-ink"
      >
        ×
      </button>
      {ms > 0 && !t.leaving && (
        <span
          aria-hidden
          className={cx('hc-countdown absolute bottom-0 left-0 h-px w-full opacity-50', tone.bar)}
          style={{ animationDuration: `${ms}ms` }}
        />
      )}
    </div>
  )
}
