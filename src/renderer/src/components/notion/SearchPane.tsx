import { useEffect, useRef, useState } from 'react'
import { notion, openInNotion, type NotionHit, type NotionPage } from '../../lib/notion'
import { EmptyState, Spinner } from '../ui'
import { cx } from '../ui/cx'
import { PagePreview } from './PagePreview'
import { useDebounced } from './QuickCapture'

// Busca global no workspace (páginas + data sources compartilhados com a
// integração) com preview à direita. ↑/↓ navega, ↵ abre o preview.

function ago(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const m = Math.round((Date.now() - t) / 60_000)
  if (m < 60) return `${Math.max(1, m)}min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function SearchPane({
  inputRef,
  onCaptureHere,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  onCaptureHere: (p: NotionPage) => void
}) {
  const [q, setQ] = useState('')
  const [tipo, setTipo] = useState<'all' | 'page' | 'data_source'>('all')
  const dq = useDebounced(q, 300)
  const [hits, setHits] = useState<NotionHit[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    let alive = true
    setBusy(true)
    notion
      .search(dq, { limite: 30, ...(tipo !== 'all' && { tipo }) })
      .then(
        (r) => {
          if (!alive) return
          setHits(r.hits)
          setErr(null)
          setCursor(0)
        },
        (e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => alive && setBusy(false))
    return () => {
      alive = false
    }
  }, [dq, tipo])

  const selHit = hits.find((h) => h.id === sel) ?? null

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[min(380px,42%)] min-w-[240px] shrink-0 flex-col border-r border-edge">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden className="shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(hits.length - 1, c + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(0, c - 1))
              } else if (e.key === 'Enter' && hits[cursor]) {
                e.preventDefault()
                setSel(hits[cursor].id)
              }
            }}
            placeholder="buscar no Notion…"
            aria-label="buscar no Notion"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-faint"
          />
          {busy && <Spinner size={10} className="text-warn" />}
        </div>
        <div className="flex gap-1 border-b border-edge px-3 py-1.5">
          {(
            [
              ['all', 'tudo'],
              ['page', 'páginas'],
              ['data_source', 'bases'],
            ] as const
          ).map(([id, l]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTipo(id)}
              aria-pressed={tipo === id}
              className={cx(
                'hc-press rounded px-1.5 py-[2px] text-[9.5px] tracking-wider uppercase',
                tipo === id ? 'bg-amber/10 text-amber' : 'text-faint hover:text-dim',
              )}
            >
              {l}
            </button>
          ))}
          <span className="ml-auto font-mono text-[9px] text-faint tabular-nums">{hits.length}</span>
        </div>
        {err ? (
          <EmptyState compact tone="error" icon="!" title="busca falhou" detail={err} />
        ) : (
          <ul ref={listRef} className="hc-stagger min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label="resultados">
            {!busy && hits.length === 0 && <li className="px-3 py-3 text-[11px] text-faint">{dq ? 'nada encontrado' : 'nenhuma página compartilhada com a integração'}</li>}
            {hits.map((h, i) => (
              <li key={h.id} role="option" aria-selected={sel === h.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSel(h.id)
                    setCursor(i)
                  }}
                  className={cx(
                    'group relative flex w-full items-center gap-2 px-3 py-1.5 text-left',
                    sel === h.id ? 'bg-amber/[0.07]' : i === cursor ? 'bg-panel2/70' : 'hover:bg-hover/50',
                  )}
                >
                  {sel === h.id && <span aria-hidden className="absolute inset-y-1 left-0 w-[2px] rounded bg-amber" />}
                  <span className="w-4 shrink-0 text-center text-[12px]">{h.icon ?? (h.object === 'page' ? '·' : '▦')}</span>
                  <span className={cx('min-w-0 flex-1 truncate text-[11.5px]', sel === h.id ? 'text-ink' : 'text-dim group-hover:text-ink')}>{h.title}</span>
                  {h.object !== 'page' && <span className="label !text-[8px] text-cyanic">base</span>}
                  <span className="shrink-0 font-mono text-[9px] text-faint">{ago(h.lastEdited)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {selHit ? (
          selHit.object === 'page' ? (
            <PagePreview key={selHit.id} id={selHit.id} onCaptureHere={onCaptureHere} />
          ) : (
            <EmptyState
              title={selHit.title}
              detail="base de dados (data source) — o preview mostra páginas; abra no Notion para ver a base."
              icon="▦"
              action={
                selHit.url ? (
                  <button type="button" className="text-[11px] text-amber hover:underline" onClick={() => void openInNotion(selHit.url).catch(() => {})}>
                    abrir ↗
                  </button>
                ) : undefined
              }
            />
          )
        ) : (
          <EmptyState icon="⌕" title="preview" detail="escolha um resultado para ver propriedades e conteúdo (somente leitura)." />
        )}
      </div>
    </div>
  )
}
