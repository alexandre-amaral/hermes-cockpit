import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../../lib/ipc'
import { RpcError, type HermesRpc } from '../../lib/rpc'
import { toast } from '../../lib/toast'
import {
  BOT_CHAT_TITLE,
  closeSession,
  deleteSessionRpc,
  exportSession,
  listSessionsAll,
  renameSession,
  searchSessions,
  setSessionHidden,
  type SessionRow,
} from '../../lib/gateway'
import { ConfirmButton } from './ConfirmButton'

export interface DrawerRow {
  id: string
  title: string
  preview: string
  snippet?: string
  started_at: number
  message_count: number
  source: string
  hidden: boolean
}

interface Props {
  rpc: HermesRpc
  profile: string
  botTitle: string
  /** storedIds abertos em abas (não dá para apagar sessão aberta) */
  openIds: Set<string>
  activeId: string | null
  /** runtime conhecido de uma sessão (para fechar antes de apagar) e se está rodando */
  runtimeOf: (storedId: string) => { runtimeId: string; running: boolean } | null
  /** sinal externo para recarregar (sessions.changed) */
  refreshNonce: number
  onOpen: (row: { id: string; title: string }) => void
  onRenamed: (storedId: string, title: string) => void
  onDeleted: (storedId: string) => void
  onClose: () => void
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function rowTitle(r: { title?: string | null; preview?: string | null; id: string }): string {
  return r.title?.trim() || r.preview?.trim().slice(0, 60) || r.id
}

const BUCKETS = ['Hoje', 'Ontem', 'Últimos 7 dias', 'Últimos 30 dias', 'Mais antigas', 'Sem data'] as const

function bucketOf(ts: number): (typeof BUCKETS)[number] {
  if (!ts) return 'Sem data'
  const d = new Date(ts * 1000)
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const day = 86400_000
  const t = d.getTime()
  if (t >= start.getTime()) return 'Hoje'
  if (t >= start.getTime() - day) return 'Ontem'
  if (t >= start.getTime() - 6 * day) return 'Últimos 7 dias'
  if (t >= start.getTime() - 29 * day) return 'Últimos 30 dias'
  return 'Mais antigas'
}

function when(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: '2-digit' } : {}) })
}

function download(name: string, data: unknown): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// Gaveta de sessões do bot: busca (REST /api/sessions/search; fallback local),
// agrupamento por data, abrir em aba, renomear, ocultar/mostrar, exportar e apagar
// (confirmação de 2 cliques; session.delete recusa sessão viva — ver gateway.ts).
// O Bot Chat canônico nunca aparece aqui (não se renomeia/apaga a identidade do bot).
export function SessionDrawer(props: Props) {
  const { rpc, profile, botTitle, openIds, activeId, runtimeOf, refreshNonce, onOpen, onRenamed, onDeleted, onClose } = props
  const [rows, setRows] = useState<DrawerRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DrawerRow[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [visible, all] = await Promise.all([
        listSessionsAll(rpc, profile, { limit: 200 }),
        showHidden ? listSessionsAll(rpc, profile, { limit: 200, includeHidden: true }) : Promise.resolve<SessionRow[] | null>(null),
      ])
      const visibleIds = new Set(visible.map((r) => r.id))
      const src = all ?? visible
      setRows(
        src.map((r) => ({
          id: r.id,
          title: rowTitle(r),
          preview: r.preview ?? '',
          started_at: r.started_at ?? 0,
          message_count: r.message_count ?? 0,
          source: r.source ?? '',
          hidden: !visibleIds.has(r.id),
        })),
      )
    } catch (e) {
      setError(errText(e))
    }
  }, [rpc, profile, showHidden])

  useEffect(() => {
    void load()
  }, [load, refreshNonce])

  useEffect(() => {
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editing])

  // busca com debounce: REST (FTS no conteúdo); sem REST, filtra a lista local
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setSearchErr(null)
      return
    }
    let alive = true
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const res = await searchSessions(api, profile, q, 40)
        if (!alive) return
        const known = new Map((rows ?? []).map((r) => [r.id, r]))
        setResults(
          res
            .filter((r) => (r.title ?? '').trim() !== BOT_CHAT_TITLE)
            // busca é do bot aberto (sempre do espaço — o ChatPane avisa quando não é):
            // descarta linhas de outro profile caso o backend ignore o filtro
            .filter((r) => {
              const p = (r as { profile?: unknown }).profile
              return typeof p !== 'string' || !p || p === profile
            })
            .map((r) => ({
              id: r.id,
              title: rowTitle(r),
              preview: r.preview ?? '',
              snippet: r.snippet ?? undefined,
              started_at: r.started_at ?? 0,
              message_count: r.message_count ?? 0,
              source: r.source ?? '',
              hidden: known.get(r.id)?.hidden ?? false,
            })),
        )
        setSearchErr(null)
      } catch (e) {
        if (!alive) return
        const ql = q.toLowerCase()
        setResults((rows ?? []).filter((r) => `${r.title} ${r.preview} ${r.id}`.toLowerCase().includes(ql)))
        setSearchErr(`busca no conteúdo indisponível (${errText(e)}) — filtrando só títulos`)
      } finally {
        if (alive) setSearching(false)
      }
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, profile, rows])

  const list = results ?? rows ?? []
  const grouped = useMemo(() => {
    const m = new Map<string, DrawerRow[]>()
    for (const r of list) {
      const b = bucketOf(r.started_at)
      m.set(b, [...(m.get(b) ?? []), r])
    }
    return BUCKETS.filter((b) => m.has(b)).map((b) => ({ bucket: b, rows: m.get(b)! }))
  }, [list])

  const patch = (id: string, p: Partial<DrawerRow>) => {
    setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, ...p } : r)) ?? rs)
    setResults((rs) => rs?.map((r) => (r.id === id ? { ...r, ...p } : r)) ?? rs)
  }
  const drop = (id: string) => {
    setRows((rs) => rs?.filter((r) => r.id !== id) ?? rs)
    setResults((rs) => rs?.filter((r) => r.id !== id) ?? rs)
  }

  const rename = async (r: DrawerRow, title: string) => {
    setBusy(r.id)
    try {
      const live = runtimeOf(r.id)
      let final: string
      try {
        final = await renameSession(rpc, api, { profile, storedId: r.id, runtimeId: live?.runtimeId, title })
      } catch (e) {
        // runtime morto (4001/5007): cai para o REST
        if (!live) throw e
        final = await renameSession(null, api, { profile, storedId: r.id, title })
      }
      patch(r.id, { title: final })
      onRenamed(r.id, final)
      setEditing(null)
    } catch (e) {
      toast({ title: 'Renomear falhou', detail: errText(e), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const toggleHidden = async (r: DrawerRow) => {
    setBusy(r.id)
    try {
      await setSessionHidden(rpc, profile, runtimeOf(r.id)?.runtimeId ?? r.id, !r.hidden)
      if (!r.hidden && !showHidden) drop(r.id)
      else patch(r.id, { hidden: !r.hidden })
      toast({ title: r.hidden ? 'Sessão visível de novo' : 'Sessão oculta', detail: r.title, tone: 'ok' })
    } catch (e) {
      toast({ title: 'Ocultar falhou', detail: errText(e), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const doExport = async (r: DrawerRow) => {
    setBusy(r.id)
    try {
      const data = await exportSession(api, profile, r.id)
      download(`hermes-${profile}-${r.id}.json`, data)
      toast({ title: 'Sessão exportada', detail: `hermes-${profile}-${r.id}.json`, tone: 'ok' })
    } catch (e) {
      toast({ title: 'Exportar falhou', detail: errText(e), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const doDelete = async (r: DrawerRow) => {
    if (openIds.has(r.id)) {
      toast({ title: 'Sessão aberta em uma aba', detail: 'feche a aba antes de apagar', tone: 'warn' })
      return
    }
    setBusy(r.id)
    try {
      try {
        await deleteSessionRpc(rpc, profile, r.id)
      } catch (e) {
        // 4023 = ainda viva no gateway. Se fomos nós que a abrimos e ela não está
        // rodando, fecha o runtime e tenta de novo; senão, recusa.
        const live = runtimeOf(r.id)
        if (e instanceof RpcError && e.code === 4023 && live && !live.running) {
          await closeSession(rpc, live.runtimeId, profile)
          await deleteSessionRpc(rpc, profile, r.id)
        } else if (e instanceof RpcError && e.code === 4023) {
          throw new Error('a sessão está ativa no gateway (turno rodando ou aberta em outro cliente)')
        } else throw e
      }
      drop(r.id)
      onDeleted(r.id)
      toast({ title: 'Sessão apagada', detail: r.title, tone: 'ok' })
    } catch (e) {
      toast({ title: 'Apagar falhou', detail: errText(e), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <aside className="hc-glass hc-fade-in absolute inset-y-0 right-0 z-30 flex w-[360px] max-w-[92%] flex-col border-l border-edge2 shadow-2xl">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="label">Sessões · {botTitle}</span>
        <span className="text-[10.5px] text-faint">{rows ? `${rows.length}` : ''}</span>
        <button onClick={() => void load()} title="recarregar" className="ml-auto rounded px-1.5 text-[12px] text-faint hover:bg-hover hover:text-ink">
          ↻
        </button>
        <button onClick={onClose} aria-label="fechar" className="rounded px-1.5 text-faint hover:bg-hover hover:text-ink">
          ✕
        </button>
      </div>
      <div className="space-y-1.5 border-b border-edge px-3 py-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-faint">⌕</span>
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="buscar em títulos e mensagens…"
            className="w-full rounded border border-edge bg-void py-1 pl-6 pr-6 text-[12px] text-ink placeholder:text-faint focus:border-amber/60 focus:outline-none"
          />
          {searching && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-faint">…</span>}
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-dim">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-amber" />
          mostrar ocultas
        </label>
        {searchErr && <div className="text-[10.5px] text-amber">{searchErr}</div>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error && (
          <div className="m-3 rounded border border-alert/40 px-3 py-2 text-[11.5px] text-alert">
            {error}
            <button onClick={() => void load()} className="ml-2 text-ink underline">
              tentar de novo
            </button>
          </div>
        )}
        {!rows && !error && (
          <div className="space-y-2 px-3 py-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="hc-shimmer h-8 rounded" />
            ))}
          </div>
        )}
        {rows && list.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-faint">{query ? `nada para "${query}"` : 'nenhum side-chat ainda'}</div>
        )}
        {grouped.map((g) => (
          <div key={g.bucket} className="pb-1">
            <div className="label sticky top-0 z-[1] bg-panel/95 px-3 py-1 text-[9.5px] backdrop-blur-sm">{g.bucket}</div>
            {g.rows.map((r) => {
              const isOpen = openIds.has(r.id)
              const isActive = activeId === r.id
              return (
                <div
                  key={r.id}
                  onClick={() => editing !== r.id && onOpen({ id: r.id, title: r.title })}
                  className={`group relative cursor-pointer px-3 py-1.5 transition-colors hover:bg-hover ${isActive ? 'bg-[color-mix(in_srgb,var(--color-sel)_70%,transparent)]' : ''}`}
                >
                  {isActive && <span className="absolute inset-y-1 left-0 w-0.5 rounded bg-amber" />}
                  {editing === r.id ? (
                    <InlineRename initial={r.title} busy={busy === r.id} onCancel={() => setEditing(null)} onSave={(t) => void rename(r, t)} />
                  ) : (
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className={`min-w-0 truncate text-[12px] ${isActive ? 'text-amber' : r.hidden ? 'text-faint' : 'text-ink'}`}>{r.title}</span>
                      {isOpen && !isActive && <span className="h-1 w-1 shrink-0 rounded-full bg-amber/70" title="aberta em aba" />}
                      {r.hidden && <span className="label shrink-0 text-[9px]">oculta</span>}
                      <span className="ml-auto shrink-0 text-[10px] text-faint group-hover:hidden">
                        {when(r.started_at)}
                        {r.message_count ? ` · ${r.message_count}` : ''}
                      </span>
                    </div>
                  )}
                  {editing !== r.id && (r.snippet || (r.preview && r.preview !== r.title)) && (
                    <div className="mt-0.5 truncate text-[10.5px] text-faint">{(r.snippet || r.preview).replace(/>>>|<<</g, '')}</div>
                  )}
                  {editing !== r.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute right-2 top-1 hidden items-center gap-1 rounded bg-panel2 pl-1 group-hover:flex"
                    >
                      <IconBtn title="renomear" disabled={busy === r.id} onClick={() => setEditing(r.id)}>
                        ✎
                      </IconBtn>
                      <IconBtn title={r.hidden ? 'mostrar' : 'ocultar'} disabled={busy === r.id} onClick={() => void toggleHidden(r)}>
                        {r.hidden ? '◉' : '◌'}
                      </IconBtn>
                      <IconBtn title="exportar JSON" disabled={busy === r.id} onClick={() => void doExport(r)}>
                        ⤓
                      </IconBtn>
                      <ConfirmButton
                        title={isOpen ? 'feche a aba antes de apagar' : 'apagar sessão'}
                        disabled={busy === r.id || isOpen}
                        onConfirm={() => doDelete(r)}
                        confirmLabel="apagar?"
                        className="rounded px-1 text-[11px] text-faint hover:bg-edge hover:text-alert"
                        armedClassName="rounded bg-alert/20 px-1.5 text-[10.5px] font-semibold text-alert"
                      >
                        ⌫
                      </ConfirmButton>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="border-t border-edge px-3 py-1.5 text-[10px] text-faint">
        clique abre em aba · o Bot Chat canônico não aparece aqui
      </div>
    </aside>
  )
}

function IconBtn({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded px-1 text-[11px] text-faint hover:bg-edge hover:text-ink disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function InlineRename({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave: (t: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  return (
    <form
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault()
        const t = v.trim()
        if (!t || t === initial) onCancel()
        else onSave(t)
      }}
      className="flex items-center gap-1"
    >
      <input
        autoFocus
        value={v}
        disabled={busy}
        maxLength={100}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
        className="min-w-0 flex-1 rounded border border-amber/60 bg-void px-1.5 py-0.5 text-[12px] text-ink focus:outline-none"
      />
      <button type="submit" disabled={busy} className="rounded bg-amber px-1.5 py-0.5 text-[10.5px] font-semibold text-void disabled:opacity-50">
        {busy ? '…' : 'ok'}
      </button>
    </form>
  )
}
