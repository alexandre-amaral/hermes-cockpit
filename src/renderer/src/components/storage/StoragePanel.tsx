import { useCallback, useEffect, useMemo, useState } from 'react'
import { BOT_GROUPS, botTitle } from '../../lib/bots'
import {
  BOT_CHAT_TITLE,
  bulkDeleteSessions,
  deleteEmptySessions,
  emptySessionCount,
  restSessions,
  sessionStats,
  type RestSessionRow,
  type SessionStats,
} from '../../lib/gateway'
import { api } from '../../lib/ipc'
import type { HermesRpc } from '../../lib/rpc'
import { toast } from '../../lib/toast'
import { ConfirmButton } from '../chat/ConfirmButton'
import { DiskUsage } from './DiskUsage'

// Armazenamento (aba da OpsView): estatísticas do registro de sessões por profile,
// limpeza de sessões vazias, navegador de sessões de todos os profiles com filtros e
// apagar em lote (sempre pela API do Hermes, com confirmação de 2 cliques) e uso de
// disco de ~/.hermes com limpeza segura (main: storage:*).
// CONTRATO: nome do export e props são fixos (App/registry já montam assim).
export function StoragePanel(props: { rpc: HermesRpc | null }) {
  void props.rpc // tudo aqui é REST (o registro de sessões é do serve)
  const [profiles, setProfiles] = useState<string[] | null>(null)
  const [profErr, setProfErr] = useState<string | null>(null)

  useEffect(() => {
    api<{ profiles?: { name: string }[] }>('/api/profiles')
      .then((r) => setProfiles((r.profiles ?? []).map((p) => p.name)))
      .catch((e) => {
        setProfErr(e instanceof Error ? e.message : String(e))
        setProfiles(Object.keys(BOT_GROUPS)) // fallback: bots conhecidos
      })
  }, [])

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
        {profErr && <div className="rounded border border-amber/40 px-3 py-1.5 text-[11px] text-amber">/api/profiles falhou ({profErr}) — usando a lista de bots conhecida</div>}
        {profiles && <SessionStore profiles={profiles} />}
        <DiskUsage />
      </div>
    </div>
  )
}

// ── registro de sessões ──────────────────────────────────────────────────────

interface ProfileStat {
  stats?: SessionStats
  empty?: number
  error?: string
}

type Row = RestSessionRow & { profile: string }

const SIZE_FILTERS = {
  all: { label: 'qualquer tamanho', test: () => true },
  empty: { label: 'vazias (0 msgs)', test: (r: Row) => !r.message_count },
  small: { label: 'pequenas (< 5)', test: (r: Row) => (r.message_count ?? 0) < 5 },
  large: { label: 'grandes (≥ 50)', test: (r: Row) => (r.message_count ?? 0) >= 50 },
} as const
const AGE_FILTERS = {
  all: { label: 'qualquer data', days: 0 },
  d7: { label: 'paradas há > 7 dias', days: 7 },
  d30: { label: 'paradas há > 30 dias', days: 30 },
  d90: { label: 'paradas há > 90 dias', days: 90 },
} as const

const PAGE = 100
const MAX_PER_PROFILE = 500

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function labelOf(p: string): string {
  return p === 'default' ? 'Hermes (default)' : botTitle(p)
}

function when(ts?: number | null): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: '2-digit' })
}

const rowKey = (r: Row) => `${r.profile}::${r.id}`

/** Linhas protegidas: o Bot Chat (identidade do bot) e sessões ativas agora. */
function protectedReason(r: Row): string | null {
  if ((r.title ?? '').trim() === BOT_CHAT_TITLE) return 'Bot Chat canônico'
  if (r.is_active) return 'ativa agora'
  return null
}

function SessionStore({ profiles }: { profiles: string[] }) {
  const [stats, setStats] = useState<Record<string, ProfileStat>>({})
  const [rows, setRows] = useState<Row[] | null>(null)
  const [rowErrors, setRowErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [bot, setBot] = useState<string>('all')
  const [size, setSize] = useState<keyof typeof SIZE_FILTERS>('all')
  const [age, setAge] = useState<keyof typeof AGE_FILTERS>('all')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const loadStats = useCallback(async () => {
    const entries = await Promise.all(
      profiles.map(async (p): Promise<[string, ProfileStat]> => {
        const [s, e] = await Promise.allSettled([sessionStats(api, p), emptySessionCount(api, p)])
        return [
          p,
          {
            stats: s.status === 'fulfilled' ? s.value : undefined,
            empty: e.status === 'fulfilled' ? e.value.count : undefined,
            error: s.status === 'rejected' ? errText(s.reason) : e.status === 'rejected' ? errText(e.reason) : undefined,
          },
        ]
      }),
    )
    setStats(Object.fromEntries(entries))
  }, [profiles])

  const loadRows = useCallback(async () => {
    setLoading(true)
    const errs: string[] = []
    const all: Row[] = []
    await Promise.all(
      profiles.map(async (p) => {
        try {
          for (let offset = 0; offset < MAX_PER_PROFILE; offset += PAGE) {
            const res = await restSessions(api, p, { limit: PAGE, offset, archived: 'include', order: 'recent' })
            for (const s of res.sessions ?? []) all.push({ ...s, profile: p })
            if ((res.sessions?.length ?? 0) < PAGE || offset + PAGE >= (res.total ?? 0)) break
          }
        } catch (e) {
          errs.push(`${labelOf(p)}: ${errText(e)}`)
        }
      }),
    )
    all.sort((a, b) => (b.last_active ?? b.started_at ?? 0) - (a.last_active ?? a.started_at ?? 0))
    setRows(all)
    setRowErrors(errs)
    setSelected((prev) => new Set([...prev].filter((k) => all.some((r) => rowKey(r) === k))))
    setLoading(false)
  }, [profiles])

  const reload = useCallback(() => {
    void loadStats()
    void loadRows()
  }, [loadStats, loadRows])

  useEffect(() => reload(), [reload])

  const visible = useMemo(() => {
    if (!rows) return []
    const now = Date.now() / 1000
    const days = AGE_FILTERS[age].days
    const ql = q.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (bot === 'all' || r.profile === bot) &&
        SIZE_FILTERS[size].test(r) &&
        (!days || now - (r.last_active ?? r.started_at ?? now) > days * 86400) &&
        (!ql || `${r.title ?? ''} ${r.preview ?? ''} ${r.id} ${r.model ?? ''}`.toLowerCase().includes(ql)),
    )
  }, [rows, bot, size, age, q])

  const selectable = visible.filter((r) => !protectedReason(r))
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(rowKey(r)))
  const selRows = (rows ?? []).filter((r) => selected.has(rowKey(r)))

  const toggle = (r: Row) =>
    setSelected((prev) => {
      const next = new Set(prev)
      const k = rowKey(r)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const bulkDelete = async () => {
    const byProfile = new Map<string, string[]>()
    for (const r of selRows) {
      if (protectedReason(r)) continue
      byProfile.set(r.profile, [...(byProfile.get(r.profile) ?? []), r.id])
    }
    let deleted = 0
    const errs: string[] = []
    for (const [p, ids] of byProfile) {
      for (let i = 0; i < ids.length; i += 500) {
        try {
          const res = await bulkDeleteSessions(api, p, ids.slice(i, i + 500))
          deleted += res.deleted ?? 0
        } catch (e) {
          errs.push(`${labelOf(p)}: ${errText(e)}`)
        }
      }
    }
    toast({
      title: `${deleted} sessão(ões) apagada(s)`,
      detail: errs.length ? errs.join(' · ') : undefined,
      tone: errs.length ? 'warn' : 'ok',
    })
    setSelected(new Set())
    reload()
  }

  const clearEmpty = async (p: string) => {
    try {
      const r = await deleteEmptySessions(api, p)
      toast({ title: `${labelOf(p)}: ${r.deleted} sessão(ões) vazia(s) removida(s)`, tone: 'ok' })
      reload()
    } catch (e) {
      toast({ title: 'Limpar vazias falhou', detail: errText(e), tone: 'error' })
    }
  }

  const totals = Object.values(stats).reduce<{ total: number; messages: number; archived: number; empty: number }>(
    (acc, s) => ({
      total: acc.total + (s.stats?.total ?? 0),
      messages: acc.messages + (s.stats?.messages ?? 0),
      archived: acc.archived + (s.stats?.archived ?? 0),
      empty: acc.empty + (s.empty ?? 0),
    }),
    { total: 0, messages: 0, archived: 0, empty: 0 },
  )
  const maxTotal = Math.max(1, ...Object.values(stats).map((s) => s.stats?.total ?? 0))

  return (
    <>
      {/* estatísticas por profile */}
      <section className="rounded-lg border border-edge bg-panel/60">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-edge px-3 py-2">
          <span className="label">Sessões · registro do Hermes</span>
          <Stat label="sessões" value={totals.total} />
          <Stat label="mensagens" value={totals.messages} />
          <Stat label="arquivadas" value={totals.archived} />
          <Stat label="vazias" value={totals.empty} tone={totals.empty ? 'amber' : undefined} />
          <button
            onClick={reload}
            disabled={loading}
            className="ml-auto rounded border border-edge px-2 py-0.5 text-[11px] text-dim hover:border-amber/50 hover:text-ink disabled:opacity-50"
          >
            {loading ? 'carregando…' : '↻ recarregar'}
          </button>
        </header>
        <div className="grid grid-cols-1 gap-x-6 gap-y-1 p-3 md:grid-cols-2">
          {profiles.map((p) => {
            const s = stats[p]
            return (
              <div key={p} className="flex items-center gap-2 text-[11.5px]">
                <span className="w-32 shrink-0 truncate text-ink/90">{labelOf(p)}</span>
                {!s ? (
                  <div className="hc-shimmer h-3 flex-1 rounded-sm" />
                ) : s.error && !s.stats ? (
                  <span className="min-w-0 flex-1 truncate text-[10.5px] text-alert" title={s.error}>
                    {s.error}
                  </span>
                ) : (
                  <>
                    <div className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-sm bg-void" title={`${s.stats?.total ?? 0} sessões · ${s.stats?.messages ?? 0} mensagens`}>
                      <div className="h-full bg-cyanic/60" style={{ width: `${((s.stats?.total ?? 0) / maxTotal) * 100}%` }} />
                    </div>
                    <span className="w-24 shrink-0 text-right tabular-nums text-dim">
                      {s.stats?.total ?? 0} · {(s.stats?.messages ?? 0).toLocaleString('pt-BR')} msg
                    </span>
                    <span className="w-28 shrink-0 text-right">
                      {s.empty ? (
                        <ConfirmButton onConfirm={() => clearEmpty(p)} confirmLabel={`apagar ${s.empty}?`} title="apaga sessões sem nenhuma mensagem (ativas e arquivadas ficam)">
                          limpar {s.empty} vazia{s.empty > 1 ? 's' : ''}
                        </ConfirmButton>
                      ) : (
                        <span className="text-[10.5px] text-faint">sem vazias</span>
                      )}
                    </span>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* navegador de sessões */}
      <section className="flex min-h-[320px] flex-col rounded-lg border border-edge bg-panel/60">
        <header className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2">
          <span className="label">Todas as sessões</span>
          <select value={bot} onChange={(e) => setBot(e.target.value)} className="rounded border border-edge bg-void px-1.5 py-0.5 text-[11px] text-ink focus:outline-none">
            <option value="all">todos os bots</option>
            {profiles.map((p) => (
              <option key={p} value={p}>
                {labelOf(p)}
              </option>
            ))}
          </select>
          <select value={size} onChange={(e) => setSize(e.target.value as keyof typeof SIZE_FILTERS)} className="rounded border border-edge bg-void px-1.5 py-0.5 text-[11px] text-ink focus:outline-none">
            {Object.entries(SIZE_FILTERS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <select value={age} onChange={(e) => setAge(e.target.value as keyof typeof AGE_FILTERS)} className="rounded border border-edge bg-void px-1.5 py-0.5 text-[11px] text-ink focus:outline-none">
            {Object.entries(AGE_FILTERS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filtrar título/modelo/id…"
            className="min-w-[140px] flex-1 rounded border border-edge bg-void px-2 py-0.5 text-[11px] text-ink placeholder:text-faint focus:border-amber/60 focus:outline-none"
          />
          <span className="text-[10.5px] text-faint">
            {visible.length}
            {rows ? `/${rows.length}` : ''}
          </span>
        </header>

        {selRows.length > 0 && (
          <div className="hc-fade-in flex items-center gap-3 border-b border-edge bg-alert/[0.04] px-3 py-1.5 text-[11.5px]">
            <span className="text-ink">{selRows.length} selecionada(s)</span>
            <span className="text-faint">{selRows.reduce((s, r) => s + (r.message_count ?? 0), 0).toLocaleString('pt-BR')} mensagens</span>
            <button onClick={() => setSelected(new Set())} className="text-[11px] text-dim hover:text-ink">
              limpar seleção
            </button>
            <span className="ml-auto" />
            <ConfirmButton onConfirm={bulkDelete} confirmLabel={`confirmar: apagar ${selRows.length} sessão(ões)`} title="apaga pelo endpoint do Hermes (bulk-delete)">
              apagar {selRows.length}
            </ConfirmButton>
          </div>
        )}

        {rowErrors.length > 0 && <div className="border-b border-edge px-3 py-1 text-[10.5px] text-alert">{rowErrors.join(' · ')}</div>}

        <div className="min-h-0 flex-1 overflow-auto">
          {!rows ? (
            <div className="space-y-1.5 p-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="hc-shimmer h-5 rounded" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="p-6 text-center text-[12px] text-faint">nenhuma sessão com esses filtros</div>
          ) : (
            <table className="w-full border-collapse text-[11.5px]">
              <thead className="sticky top-0 z-[1] bg-panel">
                <tr className="text-left">
                  <th className="w-8 px-3 py-1">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      disabled={!selectable.length}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev)
                          for (const r of selectable) {
                            if (allSelected) next.delete(rowKey(r))
                            else next.add(rowKey(r))
                          }
                          return next
                        })
                      }
                      className="accent-amber"
                      aria-label="selecionar todas visíveis"
                    />
                  </th>
                  <th className="label px-2 py-1 text-[9.5px]">título</th>
                  <th className="label px-2 py-1 text-[9.5px]">bot</th>
                  <th className="label px-2 py-1 text-right text-[9.5px]">msgs</th>
                  <th className="label px-2 py-1 text-right text-[9.5px]">tokens</th>
                  <th className="label px-2 py-1 text-[9.5px]">origem</th>
                  <th className="label px-2 py-1 text-right text-[9.5px]">última atividade</th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, 600).map((r) => {
                  const k = rowKey(r)
                  const prot = protectedReason(r)
                  const tok = (r.input_tokens ?? 0) + (r.output_tokens ?? 0)
                  return (
                    <tr
                      key={k}
                      onClick={() => !prot && toggle(r)}
                      className={`border-t border-edge/50 ${prot ? 'opacity-60' : 'cursor-pointer hover:bg-hover'} ${selected.has(k) ? 'bg-amber/[0.06]' : ''}`}
                    >
                      <td className="px-3 py-1">
                        <input
                          type="checkbox"
                          checked={selected.has(k)}
                          disabled={Boolean(prot)}
                          onChange={() => toggle(r)}
                          onClick={(e) => e.stopPropagation()}
                          className="accent-amber"
                          title={prot ?? undefined}
                        />
                      </td>
                      <td className="max-w-[340px] px-2 py-1">
                        <div className="truncate text-ink/90" title={r.title || r.preview || r.id}>
                          {r.title?.trim() || r.preview?.trim() || <span className="text-faint">{r.id}</span>}
                        </div>
                        {(prot || r.archived || r.pinned) && (
                          <div className="flex gap-1.5 text-[9.5px] uppercase tracking-[0.08em]">
                            {prot && <span className="text-amber">{prot}</span>}
                            {r.archived && <span className="text-faint">arquivada</span>}
                            {r.pinned && <span className="text-cyanic">fixada</span>}
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-dim">{labelOf(r.profile)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-dim">{r.message_count ?? 0}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-faint">{tok ? (tok >= 1000 ? `${Math.round(tok / 1000)}k` : tok) : '—'}</td>
                      <td className="px-2 py-1 text-faint">{r.source || '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right text-faint">{when(r.last_active ?? r.started_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {visible.length > 600 && <div className="px-3 py-2 text-center text-[10.5px] text-faint">mostrando 600 de {visible.length} — refine os filtros</div>}
        </div>
      </section>
    </>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'amber' }) {
  return (
    <span className="flex items-baseline gap-1 text-[11px]">
      <span className={`tabular-nums ${tone === 'amber' ? 'text-amber' : 'text-ink'}`}>{value.toLocaleString('pt-BR')}</span>
      <span className="text-faint">{label}</span>
    </span>
  )
}
