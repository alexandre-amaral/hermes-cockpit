import { useEffect, useMemo, useRef, useState } from 'react'
import { useHermesDelegation } from '../../lib/delegation'
import type { HermesRpc } from '../../lib/rpc'
import {
  fmtDuration,
  isActive,
  repoName,
  runElapsedMs,
  runHandle,
  STATUS_TONE,
  useNow,
  useSwarm,
  type Approval,
  type RunMeta,
} from '../../lib/swarm'
import { fmtRunTokens } from '../../lib/swarm-tokens'
import { useViewActive } from '../layout/views'
import { Badge, cx, EmptyState, Tabs, type TabItem } from '../ui'
import { FlowRail } from './flow'
import { HermesSubagents } from './HermesSubagents'
import { MasterView } from './MasterView'
import { RunDetail } from './RunDetail'
import { SpawnForm } from './SpawnForm'
import { SwarmApprovalCard } from './SwarmApproval'
import { SwarmTree } from './SwarmTree'
import { StatusDot, SwarmGate } from './ui'

// Visão completa do swarm (área central). Quatro lentes sobre as MESMAS fontes:
//   Comando   — visão geral: em campo / com você / entregue (padrão)
//   Execuções — lista pesquisável + detalhe de uma run do Claude Code (stream, diff, aprovações)
//   Árvore    — Hermes → bots → instâncias com terminais ao vivo
//   Subagents — delegação nativa do Hermes (tail/steer/interrupt)
// Seleção (run, subagent), filtro, busca e o sheet "Delegar tarefa" vivem AQUI;
// as lentes só recebem callbacks — navegar entre elas nunca duplica estado.
// CONTRATO: nome do export e props são fixos (App/registry já montam assim).

type Filter = 'waiting' | 'active' | 'done' | 'error' | 'all'
type Tab = 'master' | 'runs' | 'tree' | 'hermes'

const FILTERS: { id: Filter; label: string; hint: string }[] = [
  { id: 'all', label: 'todas', hint: 'todas as runs' },
  { id: 'active', label: 'em campo', hint: 'na fila, executando ou esperando você' },
  { id: 'waiting', label: 'com você', hint: 'esperando aprovação ou resposta sua' },
  { id: 'done', label: 'concluídas', hint: 'terminaram com sucesso' },
  { id: 'error', label: 'falhas', hint: 'erro ou cancelamento' },
]

const TAB_KEY = 'hc.swarm.tab'
const SEL_KEY = 'hc.swarm.sel'
const FILTER_KEY = 'hc.swarm.filter'

function readLS(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function writeLS(k: string, v: string | null): void {
  try {
    if (v == null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {
    /* ignore */
  }
}

function readTab(): Tab {
  const t = readLS(TAB_KEY)
  if (t === 'claude') return 'runs' // chave antiga
  return t === 'runs' || t === 'tree' || t === 'hermes' ? t : 'master'
}

function readFilter(): Filter {
  const f = readLS(FILTER_KEY)
  return FILTERS.some((x) => x.id === f) ? (f as Filter) : 'all'
}

function matches(r: RunMeta, f: Filter, waiting: ReadonlySet<string>): boolean {
  if (f === 'all') return true
  if (f === 'waiting') return waiting.has(r.id) || r.status === 'waiting_approval'
  if (f === 'active') return isActive(r.status)
  if (f === 'done') return r.status === 'done'
  return r.status === 'error' || r.status === 'cancelled'
}

function matchesQuery(r: RunMeta, terms: string[]): boolean {
  if (!terms.length) return true
  const hay = [r.id, r.title, r.task, r.repo, r.branch, r.model, r.requestedBy?.profile, r.groupId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return terms.every((t) => hay.includes(t))
}

interface Group {
  key: string
  groupId?: string
  runs: RunMeta[]
}

function groupRuns(runs: RunMeta[]): Group[] {
  const out: Group[] = []
  const byId = new Map<string, Group>()
  for (const r of runs) {
    if (r.groupId) {
      let g = byId.get(r.groupId)
      if (!g) {
        g = { key: r.groupId, groupId: r.groupId, runs: [] }
        byId.set(r.groupId, g)
        out.push(g)
      }
      g.runs.push(r)
    } else out.push({ key: r.id, runs: [r] })
  }
  return out
}

export function SwarmView({ rpc }: { rpc: HermesRpc | null }) {
  const s = useSwarm()
  const viewActive = useViewActive()
  const [tab, setTab] = useState<Tab>(readTab)
  const [filter, setFilter] = useState<Filter>(readFilter)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState<string | null>(() => readLS(SEL_KEY))
  const [subSel, setSubSel] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // < md: lista e detalhe alternam (master-detail em coluna única)
  const [detailOpen, setDetailOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const deleg = useHermesDelegation(rpc, viewActive && (tab === 'master' || tab === 'hermes'))
  const anyActive = s.runs.some((r) => isActive(r.status))
  const now = useNow(1000, anyActive && tab === 'runs')

  useEffect(() => writeLS(TAB_KEY, tab), [tab])
  useEffect(() => writeLS(SEL_KEY, sel), [sel])
  useEffect(() => writeLS(FILTER_KEY, filter), [filter])

  // ⌘K "Nova tarefa Claude Code": o App troca para esta view e dispara o evento.
  useEffect(() => {
    const onNewTask = () => setCreating(true)
    window.addEventListener('hc:swarm-new-task', onNewTask)
    return () => window.removeEventListener('hc:swarm-new-task', onNewTask)
  }, [])

  // seleção padrão: primeira run ativa, senão a mais recente
  useEffect(() => {
    if (!s.runs.length) return
    if (sel && s.runs.some((r) => r.id === sel)) return
    setSel((s.runs.find((r) => isActive(r.status)) ?? s.runs[0]).id)
  }, [s.runs, sel])

  const openRun = (id: string) => {
    setSel(id)
    setDetailOpen(true)
    setTab('runs')
  }
  const pickRun = (id: string) => {
    setSel(id)
    setDetailOpen(true)
  }
  const openSub = (id: string) => {
    setSubSel(id)
    setTab('hermes')
  }

  const waitingIds = useMemo(() => new Set(s.approvals.map((a) => a.runId)), [s.approvals])
  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query])

  // contagens refletem a busca (cada chip mostra quantas runs traria)
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { waiting: 0, active: 0, done: 0, error: 0, all: 0 }
    for (const r of s.runs) {
      if (!matchesQuery(r, terms)) continue
      c.all++
      for (const f of FILTERS) if (f.id !== 'all' && matches(r, f.id, waitingIds)) c[f.id]++
    }
    return c
  }, [s.runs, terms, waitingIds])
  const activeTotal = useMemo(() => s.runs.filter((r) => isActive(r.status)).length, [s.runs])

  const visible = useMemo(
    () => s.runs.filter((r) => matches(r, filter, waitingIds) && matchesQuery(r, terms)),
    [s.runs, filter, waitingIds, terms],
  )
  const groups = useMemo(() => groupRuns(visible), [visible])
  const selected = s.runs.find((r) => r.id === sel) ?? null
  const otherApprovals = s.approvals.filter((a) => a.runId !== sel)
  const subsLive = deleg.tree.length
  const filtering = filter !== 'all' || terms.length > 0

  // ↑/↓ (ou j/k) na lista movem o foco; Enter/clique abre; "/" foca a busca; Esc limpa a busca
  const onListKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT') {
      if (e.key === 'Escape' && query) {
        e.preventDefault()
        setQuery('')
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        listRef.current?.querySelector<HTMLElement>('[data-run-id]')?.focus()
      }
      return
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      searchRef.current?.focus()
      return
    }
    const dir = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0
    if (!dir || !t.dataset.runId) return
    e.preventDefault()
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-run-id]') ?? [])
    const next = rows[rows.indexOf(t) + dir]
    if (next) {
      next.focus()
      next.scrollIntoView({ block: 'nearest' })
    } else if (dir < 0) searchRef.current?.focus()
  }

  const tabs: TabItem<Tab>[] = [
    {
      id: 'master',
      label: 'Comando',
      icon: '◆',
      title: 'o que está acontecendo, o que precisa de você, o que terminou',
      badge: s.approvals.length ? <Badge tone="warn" count={s.approvals.length} /> : undefined,
    },
    {
      id: 'runs',
      label: 'Execuções',
      icon: '▤',
      title: 'runs do Claude Code: stream, diff, aprovações, continuar conversa',
      badge: activeTotal ? <Badge tone="phos" count={activeTotal} /> : undefined,
    },
    { id: 'tree', label: 'Árvore', icon: '⋔', title: 'Hermes → bots → instâncias, com terminais ao vivo' },
    {
      id: 'hermes',
      label: 'Subagents Hermes',
      icon: '⇢',
      title: 'delegação nativa do Hermes (delegate_tool)',
      badge: subsLive ? <Badge tone="cyanic" count={subsLive} /> : undefined,
    },
  ]

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-void">
      {/* barra de lentes + CTA único de criação */}
      <div className="flex items-center gap-3 border-b border-edge px-4">
        <Tabs items={tabs} value={tab} onChange={setTab} ariaLabel="Swarm" className="min-w-0 self-end overflow-x-auto !border-b-0" />
        <span className="ml-auto hidden truncate text-[10px] text-faint 2xl:inline">
          {s.status?.installed
            ? `claude ${s.status.claudeVersion ?? '?'}${s.status.profilesRegistered.length ? ` · bots: ${s.status.profilesRegistered.join(', ')}` : ''}`
            : ''}
        </span>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="hc-press my-1.5 ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-amber/70 bg-amber px-3 text-[11px] font-semibold text-void hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber 2xl:ml-0"
        >
          <span aria-hidden>＋</span> Delegar tarefa
        </button>
      </div>

      <div key={tab} className="hc-view-in flex min-h-0 flex-1 flex-col">
        {tab === 'master' ? (
          <MasterView
            s={s}
            deleg={deleg}
            onOpenRun={openRun}
            onOpenSub={openSub}
            onNewTask={() => setCreating(true)}
            onShowTree={() => setTab('tree')}
          />
        ) : tab === 'hermes' ? (
          <HermesSubagents rpc={rpc} deleg={deleg} sel={subSel} onSelect={setSubSel} />
        ) : tab === 'tree' ? (
          <SwarmGate s={s}>
            <div className="relative min-h-0 flex-1">
              <SwarmTree runs={s.runs} approvals={s.approvals} onOpen={openRun} />
            </div>
          </SwarmGate>
        ) : (
          <SwarmGate s={s}>
            <div className="flex min-h-0 flex-1">
              {/* coluna esquerda: busca + filtros + lista agrupada */}
              <aside
                className={cx(
                  'min-h-0 shrink-0 flex-col border-r border-edge bg-panel/40 md:flex md:w-[320px]',
                  detailOpen ? 'hidden' : 'flex w-full',
                )}
                aria-label="Execuções do Claude Code"
                onKeyDown={onListKey}
              >
                <div className="space-y-2 border-b border-edge px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="label">execuções</span>
                    <span className="text-[10px] tabular-nums text-faint" aria-live="polite">
                      {filtering ? `${visible.length} de ${s.runs.length}` : `${s.runs.length} no total`}
                    </span>
                    {s.error && s.phase !== 'unavailable' && (
                      <span className="truncate text-[10px] text-alert" title={s.error}>
                        ● {s.error}
                      </span>
                    )}
                  </div>
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="buscar título, tarefa, repo, branch, bot…  ( / )"
                    aria-label="Buscar execuções"
                    className="w-full rounded border border-edge2 bg-void px-2 py-1 text-[11px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
                  />
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Filtrar por estado">
                    {FILTERS.map((f) => {
                      const hot = f.id === 'waiting' && counts.waiting > 0
                      return (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => setFilter(f.id)}
                          aria-pressed={filter === f.id}
                          title={f.hint}
                          className={cx(
                            'hc-press rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber',
                            filter === f.id ? 'bg-panel2 text-ink' : hot ? 'text-amber' : 'text-faint hover:text-dim',
                          )}
                        >
                          {f.label} <span className={hot ? 'text-amber' : 'text-faint'}>{counts[f.id]}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                  {otherApprovals.length > 0 && (
                    <div className="mb-2 space-y-1.5">
                      <div className="label px-1 text-warn">esperando você em outras runs</div>
                      {otherApprovals.map((a) => (
                        <SwarmApprovalCard key={a.id} approval={a} run={s.runs.find((r) => r.id === a.runId)} compact onSelectRun={pickRun} />
                      ))}
                    </div>
                  )}
                  {!groups.length ? (
                    <EmptyState
                      compact
                      title={s.runs.length ? 'nada encontrado' : 'nenhuma run ainda'}
                      detail={
                        s.runs.length
                          ? terms.length
                            ? `Nenhuma run bate com “${query.trim()}” neste filtro.`
                            : 'Nenhuma run neste estado.'
                          : 'Delegue uma tarefa (botão no topo) ou peça a um bot (claude_spawn).'
                      }
                      action={
                        filtering && s.runs.length ? (
                          <button
                            type="button"
                            onClick={() => {
                              setQuery('')
                              setFilter('all')
                            }}
                            className="hc-press rounded border border-edge2 px-2 py-1 text-[11px] text-dim hover:text-ink"
                          >
                            limpar busca e filtro
                          </button>
                        ) : undefined
                      }
                    />
                  ) : (
                    groups.map((g) =>
                      g.groupId && g.runs.length > 1 ? (
                        <div key={g.key} className="hc-rise mb-2 rounded-md border border-edge/70 py-1" role="group" aria-label={`Grupo de ${g.runs.length} runs`}>
                          <div className="label flex items-center gap-2 px-2 py-0.5 !text-[9.5px]">
                            grupo · {g.runs.length} runs
                            {g.runs.some((r) => isActive(r.status)) && (
                              <span className="normal-case tracking-normal text-phos">{g.runs.filter((r) => isActive(r.status)).length} em campo</span>
                            )}
                            <span className="ml-auto normal-case tracking-normal text-faint">
                              {g.runs.filter((r) => r.status === 'done').length}/{g.runs.length} ok
                            </span>
                          </div>
                          {g.runs.map((r) => (
                            <RunRow key={r.id} r={r} now={now} approvals={s.approvals} waiting={waitingIds.has(r.id)} selected={r.id === sel} onClick={() => pickRun(r.id)} nested />
                          ))}
                        </div>
                      ) : (
                        <RunRow
                          key={g.key}
                          r={g.runs[0]}
                          now={now}
                          approvals={s.approvals}
                          waiting={waitingIds.has(g.runs[0].id)}
                          selected={g.runs[0].id === sel}
                          onClick={() => pickRun(g.runs[0].id)}
                        />
                      ),
                    )
                  )}
                </div>
              </aside>

              {/* centro: detalhe */}
              <main className={cx('min-w-0 flex-1 flex-col md:flex', detailOpen ? 'flex' : 'hidden')}>
                <nav className="flex items-center gap-1.5 border-b border-edge/70 px-5 py-1.5 text-[10.5px] text-faint" aria-label="trilha">
                  <button type="button" onClick={() => setDetailOpen(false)} className="hc-press shrink-0 whitespace-nowrap rounded px-1 hover:text-ink md:hidden" aria-label="voltar para a lista de execuções">
                    ← Lista
                  </button>
                  <button type="button" onClick={() => setTab('master')} className="hc-press hidden shrink-0 whitespace-nowrap rounded px-1 hover:text-ink md:inline">
                    ← Comando
                  </button>
                  <span aria-hidden>/</span>
                  <span className="shrink-0">Execuções</span>
                  {selected && (
                    <>
                      <span aria-hidden>/</span>
                      <span className="truncate text-dim">{selected.title || selected.task}</span>
                    </>
                  )}
                </nav>
                {selected ? (
                  <div key={selected.id} className="hc-slide-right flex min-h-0 flex-1 flex-col">
                    <RunDetail run={selected} approvals={s.approvals} onSelectRun={setSel} />
                  </div>
                ) : (
                  <EmptyState title="escolha uma run" detail="Selecione à esquerda para ver etapa, próximo passo, stream e diff." />
                )}
              </main>
            </div>
          </SwarmGate>
        )}
      </div>

      {creating && (
        <SpawnSheet
          onClose={() => setCreating(false)}
          onDone={(runs) => {
            setCreating(false)
            setFilter('all')
            setQuery('')
            if (runs[0]) openRun(runs[0].id)
          }}
        />
      )}
    </div>
  )
}

/** Sheet modal "Delegar tarefa" — sobre qualquer lente; Esc/fora fecha. */
function SpawnSheet({ onClose, onDone }: { onClose: () => void; onDone: (runs: RunMeta[]) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center overflow-y-auto px-4 pb-8 pt-[8vh]">
      <div className="hc-scrim absolute inset-0" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" aria-labelledby="hc-spawn-title" className="hc-sheet-in hc-card relative w-full max-w-[600px] p-5 shadow-[var(--hc-shadow-3)]">
        <div className="mb-4 flex items-start gap-3">
          <span className="mt-1 h-2.5 w-2.5 rotate-45 bg-amber" aria-hidden />
          <div className="min-w-0">
            <h2 id="hc-spawn-title" className="font-display text-[20px] leading-tight text-ink">
              Delegar ao Claude Code
            </h2>
            <p className="mt-0.5 text-[11.5px] text-dim">Cada tarefa vira uma run isolada. Você acompanha a etapa e decide quando ela pedir.</p>
          </div>
          <button type="button" onClick={onClose} className="hc-press ml-auto rounded px-1.5 text-[14px] text-faint hover:text-ink" aria-label="fechar">
            ✕
          </button>
        </div>
        <SpawnForm onCancel={onClose} onDone={onDone} />
      </div>
    </div>
  )
}

function RunRow({
  r,
  now,
  approvals,
  waiting,
  selected,
  onClick,
  nested = false,
}: {
  r: RunMeta
  now: number
  approvals: Approval[]
  waiting: boolean
  selected: boolean
  onClick: () => void
  nested?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-run-id={r.id}
      aria-current={selected || undefined}
      data-active={selected || undefined}
      className={cx(
        'hc-rail-item hc-rise mb-0.5 block w-full min-w-0 rounded px-2 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber',
        selected ? 'bg-panel2 ring-1 ring-edge2' : 'hover:bg-hover/60',
        waiting && !selected && 'bg-[color-mix(in_srgb,var(--color-warn)_5%,transparent)]',
        nested && 'pl-3',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot status={r.status} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink" title={r.task}>
          {r.title || r.task}
        </span>
        {waiting && <span className="hc-pop shrink-0 rounded-full bg-warn px-1.5 text-[9px] font-semibold text-void">você</span>}
        <span className="shrink-0 text-[10px] tabular-nums text-faint">{fmtDuration(runElapsedMs(r, now))}</span>
      </span>
      <FlowRail run={r} approvals={approvals} compact className="mt-1.5" />
      <span className="mt-1 flex min-w-0 gap-2 text-[10px] text-faint">
        <span className={STATUS_TONE[r.status].text}>{runHandle(r)}</span>
        <span className="truncate" title={r.repo}>
          {repoName(r.repo)}
          {r.branch ? ` ⎇ ${r.branch.replace(/^hermes\//, '')}` : ''}
        </span>
        <span className="ml-auto shrink-0">
          {r.numTurns != null ? `${r.numTurns}t · ` : ''}
          {r.tokensTotal != null ? fmtRunTokens(r.tokensTotal) : ''}
        </span>
      </span>
    </button>
  )
}
