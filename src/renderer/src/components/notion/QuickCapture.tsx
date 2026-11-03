import { useEffect, useRef, useState } from 'react'
import { getCaptureTarget, notion, setCaptureTarget, type NotionHit } from '../../lib/notion'
import { toast } from '../../lib/toast'
import { Button, Kbd, Spinner } from '../ui'
import { cx } from '../ui/cx'

// Captura rápida: anexa texto ao fim de uma página escolhida. Linhas viram
// blocos ("- " lista, "[] " to-do, "## " título, "> " citação). Destino
// lembrado em localStorage. ⌘↵ envia, Esc fecha.

export function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

export function PagePicker({ value, onPick }: { value: NotionHit | null; onPick: (h: NotionHit) => void }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 280)
  const [hits, setHits] = useState<NotionHit[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setBusy(true)
    notion.search(dq, { tipo: 'page', limite: 8 }).then(
      (r) => {
        if (!alive) return
        setHits(r.hits)
        setErr(null)
      },
      (e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)),
    ).finally(() => alive && setBusy(false))
    return () => {
      alive = false
    }
  }, [dq])

  return (
    <div className="rounded-md border border-edge bg-void/40">
      <div className="flex items-center gap-2 border-b border-edge px-2 py-1">
        <span className="label !text-[8.5px]">destino</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={value ? value.title : 'buscar página…'}
          aria-label="buscar página de destino"
          className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-faint"
        />
        {busy && <Spinner size={9} />}
      </div>
      <ul className="max-h-36 overflow-y-auto py-0.5">
        {err && <li className="px-2 py-1 text-[10px] text-alert">{err}</li>}
        {hits?.length === 0 && !err && <li className="px-2 py-1 text-[10px] text-faint">nenhuma página compartilhada com a integração</li>}
        {hits?.map((h) => (
          <li key={h.id}>
            <button
              type="button"
              onClick={() => onPick(h)}
              className={cx(
                'flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-hover',
                value?.id === h.id ? 'text-amber' : 'text-dim',
              )}
            >
              <span className="w-4 shrink-0 text-center">{h.icon ?? '·'}</span>
              <span className="min-w-0 flex-1 truncate">{h.title}</span>
              {value?.id === h.id && <span className="text-[9px]">●</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function QuickCapture({ open, onClose, initialTarget }: { open: boolean; onClose: () => void; initialTarget?: NotionHit | null }) {
  const [target, setTarget] = useState<NotionHit | null>(() => getCaptureTarget())
  const [text, setText] = useState('')
  const [stamp, setStamp] = useState(true)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    if (initialTarget) {
      setTarget(initialTarget)
      setCaptureTarget(initialTarget)
    }
    setPicking(!(initialTarget ?? getCaptureTarget()))
    const t = setTimeout(() => ta.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open, initialTarget])

  if (!open) return null

  const send = async () => {
    if (!target || !text.trim() || busy) return
    setBusy(true)
    try {
      const r = await notion.appendToPage(target.id, text, { carimbo: stamp })
      toast({ title: `capturado em ${target.title}`, detail: `${r.appended} bloco(s)`, tone: 'ok' })
      setText('')
      onClose()
    } catch (e) {
      toast({ title: 'captura falhou', detail: e instanceof Error ? e.message : String(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="hc-scrim hc-fade-in absolute inset-0 z-40 flex items-start justify-center bg-void/55 px-4 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label="captura rápida no Notion"
    >
      <div className="hc-glass hc-rise w-full max-w-[560px] overflow-hidden rounded-xl border border-edge2 shadow-[var(--hc-shadow-3)]">
        <div className="relative flex items-center gap-2 border-b border-edge px-3 py-2">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber shadow-[0_0_8px_var(--color-amber)]" />
          <span className="label !text-ink">captura rápida</span>
          <button
            type="button"
            onClick={() => setPicking((v) => !v)}
            className="ml-2 flex min-w-0 items-center gap-1 truncate rounded border border-edge px-1.5 py-[2px] text-[10.5px] text-dim hover:border-amber/50 hover:text-amber"
            title="trocar página de destino"
          >
            <span>{target?.icon ?? '→'}</span>
            <span className="truncate">{target ? target.title : 'escolher página'}</span>
            <span aria-hidden className="text-faint">▾</span>
          </button>
          <span className="ml-auto flex items-center gap-1 text-[9px] text-faint">
            <Kbd keys={['⌘', '↵']} /> envia · <Kbd keys="Esc" />
          </span>
          <span aria-hidden className="hc-flow-x absolute inset-x-0 bottom-0 h-px opacity-60" />
        </div>
        {picking && (
          <div className="border-b border-edge p-2">
            <PagePicker
              value={target}
              onPick={(h) => {
                setTarget(h)
                setCaptureTarget(h)
                setPicking(false)
                ta.current?.focus()
              }}
            />
          </div>
        )}
        <textarea
          ref={ta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
          rows={6}
          placeholder={'ideia, nota, link…\n- item de lista\n[] to-do'}
          aria-label="texto da captura"
          className="block w-full resize-none bg-transparent px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-2 border-t border-edge px-3 py-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-dim">
            <input type="checkbox" checked={stamp} onChange={(e) => setStamp(e.target.checked)} className="accent-amber" />
            carimbo de data/hora
          </label>
          <span className="ml-auto font-mono text-[9px] text-faint tabular-nums">{text.length} car.</span>
          <Button size="sm" variant="ghost" onClick={onClose}>
            cancelar
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!target || !text.trim()} onClick={() => void send()}>
            anexar
          </Button>
        </div>
      </div>
    </div>
  )
}
