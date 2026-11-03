import { useEffect, useState } from 'react'
import { notion, openInNotion, type NotionPage } from '../../lib/notion'
import { toast } from '../../lib/toast'
import { Markdown } from '../chat/Markdown'
import { Button, EmptyState, SkeletonLines } from '../ui'

// Preview somente-leitura de uma página: propriedades + blocos em markdown.

export function PagePreview({
  id,
  showProps = true,
  onCaptureHere,
  compact,
}: {
  id: string
  showProps?: boolean
  onCaptureHere?: (p: NotionPage) => void
  compact?: boolean
}) {
  const [page, setPage] = useState<NotionPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    setPage(null)
    setError(null)
    notion.getPage(id).then(
      (p) => alive && setPage(p),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      alive = false
    }
  }, [id, nonce])

  if (error)
    return (
      <EmptyState
        compact
        tone="error"
        icon="!"
        title="página indisponível"
        detail={error}
        action={
          <Button size="xs" onClick={() => setNonce((n) => n + 1)}>
            tentar de novo
          </Button>
        }
      />
    )
  if (!page) return <SkeletonLines lines={6} className="p-1" />

  return (
    <div className="hc-fade-in min-w-0">
      {!compact && (
        <div className="mb-3 flex items-start gap-2">
          {page.icon && <span className="text-[18px] leading-none">{page.icon}</span>}
          <h3 className="font-display min-w-0 flex-1 text-[15px] leading-snug text-ink">{page.title}</h3>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          onClick={() => openInNotion(page.url).catch((e: unknown) => toast({ title: 'não abri', detail: String(e), tone: 'error' }))}
        >
          abrir no Notion ↗
        </Button>
        {onCaptureHere && (
          <Button size="xs" variant="ghost" onClick={() => onCaptureHere(page)} title="usar como destino da captura rápida">
            capturar aqui
          </Button>
        )}
        <span className="ml-auto font-mono text-[9px] text-faint">
          editado {page.lastEdited ? new Date(page.lastEdited).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
        </span>
      </div>
      {showProps && page.properties.length > 0 && (
        <dl className="mb-3 grid grid-cols-[minmax(70px,auto)_1fr] gap-x-3 gap-y-1 rounded-md border border-edge bg-void/40 px-3 py-2 text-[10.5px]">
          {page.properties.map((p) => (
            <div key={p.name} className="contents">
              <dt className="label truncate !text-[9px]">{p.name || '(sem nome)'}</dt>
              <dd className="min-w-0 truncate text-dim">{p.value || <span className="text-faint">—</span>}</dd>
            </div>
          ))}
        </dl>
      )}
      {page.markdown ? (
        <div className="text-[12px] leading-relaxed text-ink/90">
          <Markdown text={page.markdown} />
        </div>
      ) : (
        <div className="text-[11px] text-faint">página sem conteúdo</div>
      )}
      {page.truncated && <div className="mt-2 text-[10px] text-warn">preview truncado (página longa) — abra no Notion para ver tudo</div>}
    </div>
  )
}
