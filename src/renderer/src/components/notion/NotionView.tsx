import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { hasMain } from '../../lib/ipc'
import {
  addDaysYmd,
  DEFAULT_SPACE_MAP,
  doneStatus,
  dueTone,
  notion,
  openInNotion,
  setSpaceMap,
  taskInSpace,
  todayYmd,
  todoStatus,
  urgencyCompare,
  useSpaceMap,
  type NotionHit,
  type NotionStatus,
  type NotionTask,
  type Prazo,
  type SpaceMap,
} from '../../lib/notion'
import type { HermesRpc } from '../../lib/rpc'
import { SPACES, useSpace, type ItemSpace } from '../../lib/space'
import { toast } from '../../lib/toast'
import { useViewActive } from '../layout/views'
import { Badge, Button, EmptyState, IconButton, Kbd, SkeletonLines, Tabs } from '../ui'
import { cx } from '../ui/cx'
import { NotionGlyph, OptChip } from './parts'
import { QuickCapture } from './QuickCapture'
import { SearchPane } from './SearchPane'
import { NewTaskBar, TaskDetail } from './TaskEditors'
import { TaskBoard, TaskList, type TaskGroup } from './TaskViews'
import { useNotionTasks } from './useNotionTasks'

// Notion completo: tarefas do TO-DO (lista agrupada por urgência e quadro por
// status com arrastar), filtros, criação/edição, busca global com preview e
// captura rápida. Filtra pelo espaço ativo via Categoria (ver lib/notion.ts).
// Atalhos com a view focada: n captura · t nova tarefa · / busca · 1/2/3 modo
// · r recarrega · Esc fecha detalhe.
// CONTRATO: nome do export e props são fixos.

type Mode = 'lista' | 'quadro' | 'busca'
const MODE_KEY = 'hermes-cockpit.notion.mode'
const FILT_KEY = 'hermes-cockpit.notion.filters'

interface Filters {
  status: string[]
  prioridade: string[]
  prazo: Prazo
  done: boolean
}
const NO_FILTERS: Filters = { status: [], prioridade: [], prazo: 'todas', done: false }

function readLocal<T>(k: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(k)
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback
  } catch {
    return fallback
  }
}
function writeLocal(k: string, v: unknown): void {
  try {
    localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v))
  } catch {
    /* sem storage */
  }
}

const PRAZOS: { id: Prazo; label: string }[] = [
  { id: 'todas', label: 'todos' },
  { id: 'atrasadas', label: 'atrasadas' },
  { id: 'hoje', label: 'hoje' },
  { id: 'semana', label: '7 dias' },
  { id: 'sem-prazo', label: 'sem prazo' },
]

export function NotionView(props: { rpc: HermesRpc | null }) {
  void props.rpc
  const active = useViewActive()
  const space = useSpace()
  const map = useSpaceMap()
  const [mode, setModeRaw] = useState<Mode>(() => {
    try {
      const m = localStorage.getItem(MODE_KEY)
      return m === 'quadro' || m === 'busca' ? m : 'lista'
    } catch {
      return 'lista'
    }
  })
  const setMode = (m: Mode) => {
    setModeRaw(m)
    writeLocal(MODE_KEY, m)
  }
  const [filters, setFiltersRaw] = useState<Filters>(() => readLocal(FILT_KEY, NO_FILTERS))
  const setFilters = (f: Filters) => {
    setFiltersRaw(f)
    writeLocal(FILT_KEY, f)
  }
  const [text, setText] = useState('')
  const [selId, setSelId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [captureOpen, setCaptureOpen] = useState(false)
  const [captureTarget, setCaptureTarget] = useState<NotionHit | null>(null)
  const [settings, setSettings] = useState(false)
  const [conn, setConn] = useState<NotionStatus | null>(null)

  const root = useRef<HTMLDivElement>(null)
  const newRef = useRef<HTMLInputElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const st = useNotionTasks(
    {
      status: filters.status,
      prioridade: filters.prioridade,
      prazo: filters.prazo,
      incluirConcluidas: filters.done || mode === 'quadro' || filters.status.length > 0,
      limite: 400,
    },
    { active: active && mode !== 'busca', refreshMs: 60_000 },
  )
  const { schema } = st

  useEffect(() => {
    if (!hasMain()) return
    let alive = true
    void notion.status().then((s) => alive && setConn(s), () => {})
    return () => {
      alive = false
    }
  }, [])

  // foca a view ao ativar (atalhos de tecla única funcionam já)
  useEffect(() => {
    if (active && root.current && !root.current.contains(document.activeElement)) root.current.focus({ preventScroll: true })
  }, [active])

  const q = text.trim().toLowerCase()
  const visible = useMemo(
    () =>
      st.tasks
        .filter((t) => taskInSpace(t, space, map))
        .filter((t) => !q || t.title.toLowerCase().includes(q) || t.categoria.some((c) => c.toLowerCase().includes(q))),
    [st.tasks, space, map, q],
  )

  const selected = visible.find((t) => t.id === selId) ?? st.tasks.find((t) => t.id === selId) ?? null

  const stats = useMemo(() => {
    const open = visible.filter((t) => t.statusGroup !== 'done')
    return {
      abertas: open.length,
      atrasadas: open.filter((t) => dueTone(t.date) === 'overdue').length,
      hoje: open.filter((t) => dueTone(t.date) === 'today').length,
      curso: open.filter((t) => t.statusGroup === 'doing').length,
    }
  }, [visible])

  const groups: TaskGroup[] = useMemo(() => {
    const t0 = todayYmd()
    const wk = addDaysYmd(t0, 7)
    const open = visible.filter((t) => t.statusGroup !== 'done').sort(urgencyCompare)
    const g = (id: string, label: string, tone: TaskGroup['tone']): TaskGroup => ({ id, label, tone, tasks: [] })
    const out = {
      atrasadas: g('atrasadas', 'atrasadas', 'alert'),
      hoje: g('hoje', 'hoje', 'amber'),
      curso: g('curso', 'em curso', 'cyanic'),
      semana: g('semana', 'próximos 7 dias', 'neutral'),
      depois: g('depois', 'depois', 'neutral'),
      sem: g('sem', 'sem prazo', 'neutral'),
    }
    for (const t of open) {
      const d = t.date?.slice(0, 10)
      if (d && d < t0) out.atrasadas.tasks.push(t)
      else if (d === t0) out.hoje.tasks.push(t)
      else if (t.statusGroup === 'doing') out.curso.tasks.push(t)
      else if (d && d <= wk) out.semana.tasks.push(t)
      else if (d) out.depois.tasks.push(t)
      else out.sem.tasks.push(t)
    }
    const done: TaskGroup = {
      id: 'done',
      label: 'concluídas',
      tone: 'neutral',
      tasks: visible.filter((t) => t.statusGroup === 'done').sort((a, b) => b.lastEdited.localeCompare(a.lastEdited)),
    }
    return [...Object.values(out), done]
  }, [visible])

  const withBusy = async (id: string, fn: () => Promise<unknown>) => {
    setBusy((s) => new Set(s).add(id))
    try {
      await fn()
    } finally {
      setBusy((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
    }
  }

  const toggleDone = (t: NotionTask) => {
    const target = t.statusGroup === 'done' ? todoStatus(schema) : doneStatus(schema)
    if (!target) return toast({ title: 'sem status de conclusão no schema', tone: 'warn' })
    void withBusy(t.id, async () => {
      try {
        await st.patch(t.id, { status: target })
        if (t.statusGroup !== 'done')
          toast({ title: 'concluída', detail: t.title, tone: 'ok', durationMs: 2500 })
      } catch (e) {
        toast({ title: 'Notion recusou', detail: e instanceof Error ? e.message : String(e), tone: 'error' })
      }
    })
  }

  const move = (t: NotionTask, status: string) =>
    void withBusy(t.id, async () => {
      try {
        await st.patch(t.id, { status })
      } catch (e) {
        toast({ title: 'não movi a tarefa', detail: e instanceof Error ? e.message : String(e), tone: 'error' })
      }
    })

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const el = e.target as HTMLElement
    const typing = el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
    if (e.key === 'Escape') {
      if (captureOpen || settings) return
      if (typing) return el.blur()
      if (selId) {
        e.preventDefault()
        setSelId(null)
      }
      return
    }
    if (typing || captureOpen) return
    const k = e.key.toLowerCase()
    if (k === 'n') {
      e.preventDefault()
      setCaptureTarget(null)
      setCaptureOpen(true)
    } else if (k === 't') {
      e.preventDefault()
      if (mode === 'busca') setMode('lista')
      setTimeout(() => newRef.current?.focus(), 0)
    } else if (e.key === '/') {
      e.preventDefault()
      if (mode === 'busca') searchRef.current?.focus()
      else filterRef.current?.focus()
    } else if (k === '1' || k === '2' || k === '3') {
      e.preventDefault()
      setMode(k === '1' ? 'lista' : k === '2' ? 'quadro' : 'busca')
    } else if (k === 'r') {
      e.preventDefault()
      st.refresh()
    }
  }

  const filtersOn = filters.status.length + filters.prioridade.length > 0 || filters.prazo !== 'todas' || filters.done || q.length > 0
  const spaceLabel = SPACES.find((s) => s.id === space)?.label ?? space

  return (
    <div ref={root} tabIndex={-1} onKeyDown={onKey} className="relative flex h-full min-h-0 flex-col outline-none" aria-label="Notion">
      {/* cabeçalho */}
      <header className="relative flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge px-4 py-2.5">
        <span aria-hidden className="hc-aurora pointer-events-none absolute inset-0 opacity-40" />
        <div className="relative flex items-center gap-2">
          <span className={cx('flex h-7 w-7 items-center justify-center rounded-md border', conn?.ok ? 'border-amber/40 text-amber hc-glow-amber' : 'border-edge2 text-faint')}>
            <NotionGlyph size={15} />
          </span>
          <div className="leading-tight">
            <div className="font-display text-[14px] text-ink">{schema?.title ?? 'Notion'}</div>
            <div className="flex items-center gap-1.5 text-[9.5px] text-faint">
              <span aria-hidden className={cx('h-1.5 w-1.5 rounded-full', conn == null ? 'bg-faint' : conn.ok ? 'bg-phos hc-pulse-dot' : 'bg-alert')} />
              {conn == null ? 'conectando…' : conn.ok ? `${conn.workspace ?? conn.bot ?? 'conectado'} · API ${conn.notionVersion}` : (conn.error ?? 'sem conexão')}
            </div>
          </div>
        </div>
        <Tabs<Mode>
          variant="pill"
          ariaLabel="modo"
          className="relative"
          value={mode}
          onChange={setMode}
          items={[
            { id: 'lista', label: 'lista', title: 'lista agrupada por urgência (1)' },
            { id: 'quadro', label: 'quadro', title: 'quadro por status — arraste para mudar (2)' },
            { id: 'busca', label: 'busca', title: 'busca global com preview (3)' },
          ]}
        />
        <Badge tone={space === 'houer' ? 'amber' : space === 'pessoal' ? 'cyanic' : 'neutral'} title="espaço ativo (filtro por Categoria)">
          {spaceLabel}
        </Badge>
        <div className="relative ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => (setCaptureTarget(null), setCaptureOpen(true))} title="captura rápida (n)">
            captura <Kbd keys="N" />
          </Button>
          <Button size="sm" variant="primary" onClick={() => (mode === 'busca' && setMode('lista'), setTimeout(() => newRef.current?.focus(), 0))} title="nova tarefa (t)">
            + tarefa
          </Button>
          <IconButton label="recarregar (r)" onClick={st.refresh}>
            <span className={cx(st.loading && 'hc-spin inline-block')}>↻</span>
          </IconButton>
          <IconButton label="espaços × categorias" active={settings} onClick={() => setSettings((v) => !v)}>
            ⚙
          </IconButton>
          {schema?.url && (
            <IconButton label="abrir TO-DO no Notion" onClick={() => void openInNotion(schema.url).catch(() => {})}>
              ↗
            </IconButton>
          )}
        </div>
      </header>

      {settings && <SpaceMapEditor categories={schema?.categories.map((c) => c.name) ?? []} map={map} onClose={() => setSettings(false)} />}

      {mode === 'busca' ? (
        <div className="min-h-0 flex-1">
          <SearchPane
            inputRef={searchRef}
            onCaptureHere={(p) => {
              setCaptureTarget({ id: p.id, object: 'page', title: p.title, url: p.url, icon: p.icon, lastEdited: p.lastEdited, parent: null })
              setCaptureOpen(true)
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {/* métricas + filtros */}
            <div className="space-y-2 border-b border-edge px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                <Stat n={stats.abertas} label="abertas" />
                <Stat n={stats.atrasadas} label="atrasadas" tone={stats.atrasadas ? 'alert' : undefined} onClick={() => setFilters({ ...filters, prazo: filters.prazo === 'atrasadas' ? 'todas' : 'atrasadas' })} />
                <Stat n={stats.hoje} label="hoje" tone={stats.hoje ? 'amber' : undefined} onClick={() => setFilters({ ...filters, prazo: filters.prazo === 'hoje' ? 'todas' : 'hoje' })} />
                <Stat n={stats.curso} label="em curso" tone={stats.curso ? 'cyanic' : undefined} />
                <div className="ml-auto flex min-w-[180px] items-center gap-2 rounded-md border border-edge bg-void/40 px-2 py-1 focus-within:border-amber/40">
                  <span aria-hidden className="text-[11px] text-faint">⌕</span>
                  <input
                    ref={filterRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && (setText(''), (e.target as HTMLInputElement).blur())}
                    placeholder="filtrar tarefas"
                    aria-label="filtrar tarefas"
                    className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-faint"
                  />
                  <Kbd keys="/" />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <FilterGroup label="prazo">
                  {PRAZOS.map((p) => (
                    <OptChip key={p.id} name={p.label} color={filters.prazo === p.id ? 'yellow' : undefined} active={filters.prazo === p.id} onClick={() => setFilters({ ...filters, prazo: p.id })} small />
                  ))}
                </FilterGroup>
                {schema && schema.statuses.length > 0 && (
                  <FilterGroup label="status">
                    {schema.statuses.map((s) => (
                      <OptChip
                        key={s.name}
                        name={s.name}
                        color={s.color === 'default' ? 'gray' : s.color}
                        active={filters.status.includes(s.name)}
                        onClick={() => setFilters({ ...filters, status: toggle(filters.status, s.name) })}
                        small
                      />
                    ))}
                  </FilterGroup>
                )}
                {schema && schema.priorities.length > 0 && (
                  <FilterGroup label="prio">
                    {schema.priorities.map((o) => (
                      <OptChip key={o.name} name={o.name} color={o.color} active={filters.prioridade.includes(o.name)} onClick={() => setFilters({ ...filters, prioridade: toggle(filters.prioridade, o.name) })} small />
                    ))}
                  </FilterGroup>
                )}
                {mode === 'lista' && (
                  <label className="flex cursor-pointer items-center gap-1 text-[10px] text-dim">
                    <input type="checkbox" checked={filters.done} onChange={(e) => setFilters({ ...filters, done: e.target.checked })} className="accent-amber" />
                    concluídas
                  </label>
                )}
                {filtersOn && (
                  <button type="button" className="text-[10px] text-faint hover:text-amber" onClick={() => (setFilters(NO_FILTERS), setText(''))}>
                    limpar filtros
                  </button>
                )}
                {st.error && st.tasks.length > 0 && (
                  <button type="button" onClick={st.refresh} className="ml-auto truncate rounded border border-alert/40 bg-alert/5 px-1.5 text-[10px] text-alert" title={st.error}>
                    erro: {st.error} ↻
                  </button>
                )}
              </div>
            </div>

            <div className={cx('min-h-0 flex-1 px-4 py-3', mode === 'lista' ? 'overflow-y-auto' : 'overflow-hidden')}>
              {mode === 'lista' && (
                <div className="mb-3">
                  <NewTaskBar schema={schema} space={space} inputRef={newRef} onCreated={(t) => (st.upsertLocal(t), setSelId(t.id))} />
                </div>
              )}
              {st.loading && st.tasks.length === 0 ? (
                <SkeletonLines lines={7} />
              ) : st.error && st.tasks.length === 0 ? (
                <EmptyState
                  tone="error"
                  icon="!"
                  title="Notion indisponível"
                  detail={st.error}
                  action={
                    <Button size="sm" onClick={st.refresh}>
                      tentar de novo
                    </Button>
                  }
                />
              ) : visible.length === 0 ? (
                <EmptyState
                  icon="✓"
                  title={filtersOn ? 'nada com esses filtros' : 'nenhuma tarefa aberta'}
                  detail={space !== 'tudo' ? `espaço ${spaceLabel}: só tarefas com categoria mapeada para ele (ou sem categoria).` : undefined}
                />
              ) : mode === 'lista' ? (
                <TaskList groups={groups} schema={schema} map={map} selectedId={selId} busyIds={busy} onSelect={(t) => setSelId(t.id === selId ? null : t.id)} onToggleDone={toggleDone} />
              ) : (
                <TaskBoard statuses={schema?.statuses ?? []} tasks={visible} schema={schema} selectedId={selId} busyIds={busy} onSelect={(t) => setSelId(t.id === selId ? null : t.id)} onMove={move} />
              )}
              {st.truncated && <div className="mt-2 text-[10px] text-warn">mostrando as primeiras 400 tarefas — refine os filtros</div>}
            </div>
            {mode === 'quadro' && (
              <div className="border-t border-edge px-4 py-1.5">
                <NewTaskBar schema={schema} space={space} inputRef={newRef} onCreated={(t) => (st.upsertLocal(t), setSelId(t.id))} />
              </div>
            )}
          </div>

          {selected && (
            <aside className="hc-slide-left w-[min(400px,45%)] min-w-[280px] shrink-0 border-l border-edge bg-panel/50" aria-label="detalhe da tarefa">
              <TaskDetail
                key={selected.id}
                task={selected}
                schema={schema}
                onPatch={st.patch}
                onArchived={(t) => (st.removeLocal(t.id), setSelId(null))}
                onClose={() => setSelId(null)}
              />
            </aside>
          )}
        </div>
      )}

      <QuickCapture open={captureOpen} initialTarget={captureTarget} onClose={() => (setCaptureOpen(false), root.current?.focus({ preventScroll: true }))} />
    </div>
  )
}

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

function Stat({ n, label, tone, onClick }: { n: number; label: string; tone?: 'alert' | 'amber' | 'cyanic'; onClick?: () => void }) {
  const color = tone === 'alert' ? 'text-alert' : tone === 'amber' ? 'text-amber' : tone === 'cyanic' ? 'text-cyanic' : 'text-ink'
  const body = (
    <>
      <span key={n} className={cx('hc-count font-mono text-[18px] leading-none tabular-nums', color)}>
        {n}
      </span>
      <span className="label !text-[8.5px]">{label}</span>
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className="hc-press flex items-baseline gap-1.5 rounded px-0.5 hover:bg-hover/60" title={`filtrar: ${label}`}>
      {body}
    </button>
  ) : (
    <div className="flex items-baseline gap-1.5">{body}</div>
  )
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="label mr-0.5 !text-[8.5px]">{label}</span>
      {children}
    </div>
  )
}

const SPACE_OPTS: { id: ItemSpace; label: string }[] = [
  { id: 'houer', label: 'Houer' },
  { id: 'pessoal', label: 'Pessoal' },
  { id: 'shared', label: 'ambos' },
]

function SpaceMapEditor({ categories, map, onClose }: { categories: string[]; map: SpaceMap; onClose: () => void }) {
  return (
    <div className="hc-fade-in border-b border-edge bg-panel2/40 px-4 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="label !text-ink/80">espaço por categoria</span>
        <span className="text-[10px] text-faint">propriedade “Categoria” do TO-DO → espaço do cockpit. Sem categoria = ambos. Salvo neste computador.</span>
        <button type="button" onClick={onClose} className="ml-auto text-[10px] text-faint hover:text-dim">
          fechar
        </button>
      </div>
      {categories.length === 0 ? (
        <div className="text-[10px] text-faint">o schema não tem propriedade de categoria — todas as tarefas aparecem em todos os espaços.</div>
      ) : (
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {categories.map((c) => (
            <div key={c} className="flex items-center gap-1.5">
              <span className="w-[76px] truncate font-mono text-[10px] text-ink">{c}</span>
              {SPACE_OPTS.map((o) => (
                <OptChip
                  key={o.id}
                  name={o.label}
                  color={o.id === 'houer' ? 'orange' : o.id === 'pessoal' ? 'blue' : 'gray'}
                  active={(map[c] ?? 'shared') === o.id}
                  onClick={() => setSpaceMap({ ...map, [c]: o.id })}
                  small
                />
              ))}
            </div>
          ))}
          <button type="button" className="text-[10px] text-faint hover:text-amber" onClick={() => setSpaceMap(DEFAULT_SPACE_MAP)}>
            restaurar padrão
          </button>
        </div>
      )}
    </div>
  )
}
