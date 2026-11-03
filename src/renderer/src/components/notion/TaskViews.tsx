import { useState, type DragEvent } from 'react'
import { notionColor, spaceOfTask, type NotionSchema, type NotionStatusOpt, type NotionTask, type SpaceMap } from '../../lib/notion'
import { cx } from '../ui/cx'
import { DueChip, OptChip, PrioMark, TaskCheck, optColor } from './parts'

// Lista agrupada e quadro por status (arrastar muda status).

const SPACE_TAG: Record<string, string> = { houer: 'H', pessoal: 'P', shared: '·' }

function TaskLine({
  task,
  schema,
  map,
  selected,
  busy,
  onSelect,
  onToggleDone,
}: {
  task: NotionTask
  schema: NotionSchema | null
  map: SpaceMap
  selected: boolean
  busy: boolean
  onSelect: () => void
  onToggleDone: () => void
}) {
  const done = task.statusGroup === 'done'
  const sp = spaceOfTask(task, map)
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSelect()
          if (e.key === ' ') {
            e.preventDefault()
            onToggleDone()
          }
        }}
        className={cx(
          'group relative flex cursor-default items-center gap-2.5 rounded-md border px-2.5 py-[7px] outline-none transition-colors duration-[var(--hc-dur-1)]',
          selected ? 'border-amber/35 bg-amber/[0.06]' : 'border-transparent hover:border-edge hover:bg-hover/60 focus-visible:border-edge2',
        )}
      >
        <TaskCheck done={done} busy={busy} onToggle={onToggleDone} label={done ? 'reabrir tarefa' : 'concluir tarefa'} />
        <span className={cx('min-w-0 flex-1 truncate text-[12px]', done ? 'text-faint line-through decoration-faint/60' : 'text-ink')}>{task.title}</span>
        {task.statusGroup === 'doing' && (
          <span className="flex shrink-0 items-center gap-1 text-[9px] tracking-wider text-cyanic uppercase">
            <span aria-hidden className="hc-pulse-dot h-1 w-1 rounded-full bg-cyanic" />
            {task.status}
          </span>
        )}
        <span className="hidden shrink-0 items-center gap-1 sm:flex">
          {task.categoria.map((c) => (
            <OptChip key={c} name={c} color={optColor(schema?.categories, c)} small />
          ))}
        </span>
        <PrioMark task={task} />
        <DueChip date={task.date} done={done} className="w-[64px] justify-end" />
        <span
          className={cx('w-3 shrink-0 text-center font-mono text-[9px]', sp === 'houer' ? 'text-amber/80' : sp === 'pessoal' ? 'text-cyanic/80' : 'text-faint')}
          title={`espaço: ${sp}`}
        >
          {SPACE_TAG[sp]}
        </span>
      </div>
    </li>
  )
}

export interface TaskGroup {
  id: string
  label: string
  tone?: 'alert' | 'amber' | 'cyanic' | 'neutral'
  tasks: NotionTask[]
}

export function TaskList({
  groups,
  schema,
  map,
  selectedId,
  busyIds,
  onSelect,
  onToggleDone,
}: {
  groups: TaskGroup[]
  schema: NotionSchema | null
  map: SpaceMap
  selectedId: string | null
  busyIds: Set<string>
  onSelect: (t: NotionTask) => void
  onToggleDone: (t: NotionTask) => void
}) {
  return (
    <div className="space-y-4">
      {groups
        .filter((g) => g.tasks.length > 0)
        .map((g) => (
          <section key={g.id} className="hc-fade-in">
            <div className="mb-1 flex items-center gap-2 px-1">
              <span
                aria-hidden
                className={cx(
                  'h-1.5 w-1.5 rounded-full',
                  g.tone === 'alert' ? 'bg-alert' : g.tone === 'amber' ? 'bg-amber' : g.tone === 'cyanic' ? 'bg-cyanic' : 'bg-faint',
                )}
              />
              <span className="label">{g.label}</span>
              <span className="font-mono text-[9px] text-faint tabular-nums">{g.tasks.length}</span>
              <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-edge to-transparent" />
            </div>
            <ul className="hc-stagger space-y-px">
              {g.tasks.map((t) => (
                <TaskLine
                  key={t.id}
                  task={t}
                  schema={schema}
                  map={map}
                  selected={t.id === selectedId}
                  busy={busyIds.has(t.id)}
                  onSelect={() => onSelect(t)}
                  onToggleDone={() => onToggleDone(t)}
                />
              ))}
            </ul>
          </section>
        ))}
    </div>
  )
}

// ─── quadro ─────────────────────────────────────────────────────────────────

const COL_ACCENT = {
  alert: 'from-alert/60',
  amber: 'from-amber/60',
  phos: 'from-phos/60',
  cyanic: 'from-cyanic/60',
  neutral: 'from-faint/50',
} as const

export function TaskBoard({
  statuses,
  tasks,
  schema,
  selectedId,
  busyIds,
  onSelect,
  onMove,
}: {
  statuses: NotionStatusOpt[]
  tasks: NotionTask[]
  schema: NotionSchema | null
  selectedId: string | null
  busyIds: Set<string>
  onSelect: (t: NotionTask) => void
  onMove: (t: NotionTask, status: string) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const byId = new Map(tasks.map((t) => [t.id, t]))

  const drop = (e: DragEvent, status: string) => {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData('text/x-notion-task') || dragId
    setDragId(null)
    const t = id ? byId.get(id) : undefined
    if (t && t.status !== status) onMove(t, status)
  }

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto pb-1">
      {statuses.map((s) => {
        const col = tasks.filter((t) => t.status === s.name)
        const tone = notionColor(s.color === 'default' ? (s.group === 'done' ? 'green' : undefined) : s.color)
        const isOver = over === s.name && dragId != null
        return (
          <section
            key={s.name}
            onDragOver={(e) => {
              if (!dragId) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (over !== s.name) setOver(s.name)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === s.name ? null : o))
            }}
            onDrop={(e) => drop(e, s.name)}
            aria-label={`coluna ${s.name}`}
            className={cx(
              'relative flex w-[min(300px,85vw)] min-w-[220px] flex-1 flex-col overflow-hidden rounded-lg border bg-panel/60 transition-[border-color,box-shadow,background-color] duration-[var(--hc-dur-2)]',
              isOver ? 'border-amber/50 bg-amber/[0.04] shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-amber)_10%,transparent)]' : 'border-edge',
            )}
          >
            <span aria-hidden className={cx('absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r to-transparent', COL_ACCENT[tone])} />
            <header className="flex items-center gap-2 px-3 pt-2.5 pb-2">
              <span className="label !text-ink/80">{s.name}</span>
              <span className="font-mono text-[10px] text-faint tabular-nums">{col.length}</span>
            </header>
            <ul className="hc-stagger min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
              {col.map((t) => {
                const done = t.statusGroup === 'done'
                return (
                  <li
                    key={t.id}
                    draggable={!busyIds.has(t.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/x-notion-task', t.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragId(t.id)
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      setOver(null)
                    }}
                    onClick={() => onSelect(t)}
                    className={cx(
                      'group cursor-grab rounded-md border px-2.5 py-2 shadow-[var(--hc-shadow-1)] transition-[transform,opacity,border-color] duration-[var(--hc-dur-2)] active:cursor-grabbing',
                      t.id === selectedId ? 'border-amber/40 bg-amber/[0.06]' : 'border-edge bg-panel2/70 hover:-translate-y-px hover:border-edge2',
                      dragId === t.id && 'scale-[0.98] opacity-40',
                      busyIds.has(t.id) && 'hc-shimmer',
                    )}
                  >
                    <div className={cx('text-[11.5px] leading-snug', done ? 'text-faint line-through' : 'text-ink')}>{t.title}</div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      {t.categoria.map((c) => (
                        <OptChip key={c} name={c} color={optColor(schema?.categories, c)} small />
                      ))}
                      <span className="ml-auto flex items-center gap-1.5">
                        <PrioMark task={t} />
                        <DueChip date={t.date} done={done} />
                      </span>
                    </div>
                  </li>
                )
              })}
              {col.length === 0 && (
                <li className={cx('rounded-md border border-dashed px-2 py-4 text-center text-[10px]', isOver ? 'border-amber/50 text-amber' : 'border-edge text-faint')}>
                  {isOver ? 'soltar aqui' : 'vazio'}
                </li>
              )}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
