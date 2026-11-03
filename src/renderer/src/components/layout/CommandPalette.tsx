import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Kbd } from '../ui/Kbd'
import { Skeleton } from '../ui/Skeleton'
import { cx } from '../ui/cx'

export interface PaletteItem {
  id: string
  label: string
  /** seção (Views, Bots, Sessões, Comandos, Ações, Tema…) */
  group: string
  hint?: string
  /** atalho exibido, ex.: ['⌘', '1'] */
  shortcut?: string[]
  /** termos extras para a busca (não exibidos) */
  keywords?: string
  icon?: string
  /** conteúdo do painel de preview à direita */
  preview?: { title?: string; body?: string; rows?: Array<[string, ReactNode]> }
  run: () => void
}

/** Fonte assíncrona carregada quando a paleta abre (sessões, comandos, repos). */
export interface PaletteSource {
  group: string
  load: () => Promise<PaletteItem[]>
}

type SourceState = { status: 'loading' } | { status: 'ok'; items: PaletteItem[] } | { status: 'error'; message: string }

interface Scored {
  it: PaletteItem
  score: number
  hits: number[]
}

// ─── fuzzy ────────────────────────────────────────────────────────────────
// Subsequência com bônus: prefixo, início de palavra, caracteres consecutivos.
// Retorna null se não casa. `hits` = índices casados (para realce).
function fuzzy(term: string, text: string): { score: number; hits: number[] } | null {
  const t = text.toLowerCase()
  const q = term.toLowerCase()
  if (!q) return { score: 0, hits: [] }
  const direct = t.indexOf(q)
  if (direct >= 0) {
    const atWord = direct === 0 || /[\s·:/\-_.]/.test(t[direct - 1])
    return {
      score: 40 + q.length * 4 + (direct === 0 ? 30 : atWord ? 15 : 0) - Math.min(direct, 20) * 0.5,
      hits: Array.from({ length: q.length }, (_, i) => direct + i),
    }
  }
  let score = 0
  let ti = 0
  let prev = -2
  const hits: number[] = []
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return null
    const atWord = found === 0 || /[\s·:/\-_.]/.test(t[found - 1])
    score += 2 + (found === prev + 1 ? 5 : 0) + (atWord ? 6 : 0) - Math.min(found - ti, 8) * 0.4
    hits.push(found)
    prev = found
    ti = found + 1
  }
  return { score, hits }
}

function scoreItem(terms: string[], it: PaletteItem): Scored | null {
  let total = 0
  let labelHits: number[] = []
  for (const term of terms) {
    const l = fuzzy(term, it.label)
    const other = fuzzy(term, `${it.group} ${it.hint ?? ''} ${it.keywords ?? ''}`)
    if (!l && !other) return null
    if (l && (!other || l.score >= other.score * 0.6)) {
      total += l.score * 1.5
      labelHits = labelHits.concat(l.hits)
    } else if (other) total += other.score * 0.7
  }
  return { it, score: total, hits: labelHits }
}

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>
  const set = new Set(hits)
  const out: ReactNode[] = []
  let buf = ''
  let on = false
  const flush = (k: number) => {
    if (!buf) return
    out.push(on ? <mark key={k} className="bg-transparent text-amber">{buf}</mark> : <span key={k}>{buf}</span>)
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i)
    if (h !== on) {
      flush(i)
      on = h
    }
    buf += text[i]
  }
  flush(text.length)
  return <>{out}</>
}

// Paleta ⌘K: fuzzy em views, bots, sessões recentes, comandos slash e ações,
// agrupado por seção (seções ordenadas pela melhor nota com busca), preview à
// direita, ↑↓ / Enter / Esc, Tab pula de seção.
export function CommandPalette({
  items,
  sources = [],
  onClose,
}: {
  items: PaletteItem[]
  sources?: PaletteSource[]
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const [src, setSrc] = useState<Record<string, SourceState>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  // fontes assíncronas: carregam uma vez por abertura
  const sourcesRef = useRef(sources)
  useEffect(() => {
    let alive = true
    const list = sourcesRef.current
    setSrc(Object.fromEntries(list.map((s) => [s.group, { status: 'loading' } as SourceState])))
    for (const s of list) {
      s.load().then(
        (got) => alive && setSrc((m) => ({ ...m, [s.group]: { status: 'ok', items: got } })),
        (e: unknown) =>
          alive &&
          setSrc((m) => ({ ...m, [s.group]: { status: 'error', message: e instanceof Error ? e.message : String(e) } })),
      )
    }
    return () => {
      alive = false
    }
  }, [])

  const all = useMemo(() => {
    const extra = Object.values(src).flatMap((s) => (s.status === 'ok' ? s.items : []))
    return [...items, ...extra]
  }, [items, src])

  // ordem natural das seções: itens fixos, depois fontes
  const groupOrder = useMemo(() => {
    const order: string[] = []
    for (const it of items) if (!order.includes(it.group)) order.push(it.group)
    for (const s of sourcesRef.current) if (!order.includes(s.group)) order.push(s.group)
    return order
  }, [items])

  const sections = useMemo(() => {
    const terms = q.trim().split(/\s+/).filter(Boolean)
    const scored: Scored[] = terms.length
      ? all.map((it) => scoreItem(terms, it)).filter((x): x is Scored => x !== null)
      : all.map((it) => ({ it, score: 0, hits: [] }))
    const by = new Map<string, Scored[]>()
    for (const s of scored) {
      const arr = by.get(s.it.group) ?? []
      arr.push(s)
      by.set(s.it.group, arr)
    }
    const groups = [...by.entries()].map(([group, list]) => {
      if (terms.length) list.sort((a, b) => b.score - a.score)
      const cap = terms.length ? 12 : group === 'Comandos' ? 8 : 10
      return { group, list: list.slice(0, cap), more: Math.max(0, list.length - cap), best: list[0]?.score ?? 0 }
    })
    groups.sort((a, b) =>
      terms.length ? b.best - a.best : groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group),
    )
    return groups
  }, [all, q, groupOrder])

  const flat = useMemo(() => sections.flatMap((s) => s.list), [sections])
  useEffect(() => setIdx(0), [q])
  const safeIdx = Math.min(idx, Math.max(0, flat.length - 1))
  const current = flat[safeIdx]?.it

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${safeIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [safeIdx])

  const exec = (it: PaletteItem | undefined) => {
    if (!it) return
    onClose()
    it.run()
  }

  const jumpSection = (dir: 1 | -1) => {
    let acc = 0
    const starts = sections.map((s) => {
      const st = acc
      acc += s.list.length
      return st
    })
    let curSec = 0
    starts.forEach((st, i) => {
      if (st <= safeIdx) curSec = i
    })
    const next = (curSec + dir + sections.length) % Math.max(1, sections.length)
    setIdx(starts[next] ?? 0)
  }

  const pending = Object.entries(src).filter(([, s]) => s.status === 'loading').map(([g]) => g)
  const errors = Object.entries(src).filter(([, s]) => s.status === 'error') as Array<[string, { status: 'error'; message: string }]>

  let n = -1
  return (
    <div
      className="no-drag hc-scrim fixed inset-0 z-50 flex items-start justify-center pt-[11vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
        className="hc-glass hc-pop flex max-h-[70vh] w-[min(780px,94vw)] flex-col overflow-hidden rounded-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-edge px-4">
          <span className="text-[13px] text-amber" aria-hidden>
            ⌘
          </span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="hc-palette-list"
            aria-activedescendant={current ? `pal-${current.id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                if (q) setQ('')
                else onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((i) => (flat.length ? (Math.min(i, flat.length - 1) + 1) % flat.length : 0))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((i) => (flat.length ? (Math.min(i, flat.length - 1) - 1 + flat.length) % flat.length : 0))
              } else if (e.key === 'Tab') {
                e.preventDefault()
                jumpSection(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                exec(current)
              }
            }}
            placeholder="Buscar view, bot, sessão, /comando ou ação…"
            style={{ boxShadow: 'none' }}
            className="h-12 min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-faint focus:outline-none"
          />
          {pending.length > 0 && (
            <span className="label shrink-0 normal-case tracking-normal" title={`carregando: ${pending.join(', ')}`}>
              carregando…
            </span>
          )}
        </div>

        <div className="flex min-h-0 flex-1">
          <div ref={listRef} id="hc-palette-list" role="listbox" className="min-h-0 min-w-0 flex-1 overflow-y-auto py-1.5">
            {flat.length === 0 && pending.length === 0 && (
              <div className="px-4 py-6 text-center text-[11px] text-faint">nada encontrado para “{q}”</div>
            )}
            {sections.map((s) => (
              <div key={s.group} className="mb-1" role="group" aria-label={s.group}>
                <div className="label flex items-center gap-2 px-4 pt-2 pb-1">
                  <span>{s.group}</span>
                  {s.more > 0 && <span className="normal-case tracking-normal">+{s.more}</span>}
                </div>
                {s.list.map(({ it, hits }) => {
                  n++
                  const i = n
                  const on = i === safeIdx
                  return (
                    <button
                      key={it.id}
                      id={`pal-${it.id}`}
                      type="button"
                      role="option"
                      aria-selected={on}
                      data-idx={i}
                      onMouseMove={() => i !== safeIdx && setIdx(i)}
                      onClick={() => exec(it)}
                      className={cx(
                        'relative mx-1.5 flex w-[calc(100%-12px)] items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors duration-[var(--hc-dur-1)]',
                        on ? 'bg-sel text-sel-ink' : 'text-dim',
                      )}
                    >
                      {on && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[2px] rounded bg-amber" />}
                      <span className={cx('w-4 shrink-0 text-center text-[11px]', on ? 'text-amber' : 'text-faint')} aria-hidden>
                        {it.icon ?? '›'}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        <Highlight text={it.label} hits={hits} />
                        {it.hint && <span className="ml-2 text-[10px] text-faint">{it.hint}</span>}
                      </span>
                      {it.shortcut && <Kbd keys={it.shortcut} />}
                    </button>
                  )
                })}
              </div>
            ))}
            {!q &&
              pending.map((g) => (
                <div key={`sk-${g}`} className="mb-1">
                  <div className="label px-4 pt-2 pb-1">{g}</div>
                  {[0, 1, 2].map((k) => (
                    <div key={k} className="flex items-center gap-3 px-4 py-1.5">
                      <Skeleton className="h-3 w-3" />
                      <Skeleton className={cx('h-2.5', k === 1 ? 'w-5/12' : 'w-7/12')} />
                    </div>
                  ))}
                </div>
              ))}
            {errors.map(([g, e]) => (
              <div key={`err-${g}`} className="mx-4 my-1 truncate text-[10px] text-alert/90" title={e.message}>
                {g}: indisponível — {e.message}
              </div>
            ))}
          </div>

          <Preview it={current} />
        </div>

        <div className="flex items-center gap-3 border-t border-edge px-4 py-1.5 text-[10px] text-faint">
          <span className="flex items-center gap-1">
            <Kbd keys={['↑', '↓']} /> navegar
          </span>
          <span className="flex items-center gap-1">
            <Kbd keys="↵" /> executar
          </span>
          <span className="flex items-center gap-1">
            <Kbd keys="Tab" /> seção
          </span>
          <span className="flex items-center gap-1">
            <Kbd keys="Esc" /> fechar
          </span>
          <span className="ml-auto truncate">{flat.length} resultados</span>
        </div>
      </div>
    </div>
  )
}

function Preview({ it }: { it: PaletteItem | undefined }) {
  return (
    <aside className="hidden w-[38%] max-w-[300px] shrink-0 border-l border-edge bg-void/30 px-4 py-3 md:block" aria-live="polite">
      {it ? (
        <div key={it.id} className="hc-fade-in space-y-3">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md border border-edge2 bg-panel2 text-[12px] text-amber" aria-hidden>
              {it.icon ?? '›'}
            </span>
            <div className="min-w-0">
              <div className="label">{it.group}</div>
              <div className="truncate text-[12px] text-ink">{it.preview?.title ?? it.label}</div>
            </div>
          </div>
          {it.preview?.body && <p className="text-[11px] leading-relaxed whitespace-pre-line text-dim">{it.preview.body}</p>}
          {!it.preview?.body && it.hint && <p className="text-[11px] leading-relaxed text-dim">{it.hint}</p>}
          {it.preview?.rows && it.preview.rows.length > 0 && (
            <dl className="space-y-1 text-[10px]">
              {it.preview.rows.map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="w-16 shrink-0 text-faint">{k}</dt>
                  <dd className="min-w-0 flex-1 truncate text-dim">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {it.shortcut && (
            <div className="flex items-center gap-2 text-[10px] text-faint">
              atalho <Kbd keys={it.shortcut} />
            </div>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-faint">nada selecionado</div>
      )}
    </aside>
  )
}
