import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { addDaysYmd, defaultCategoryFor, notion, openInNotion, todayYmd, type NotionSchema, type NotionTask, type TaskPatch } from '../../lib/notion'
import type { Space } from '../../lib/space'
import { toast } from '../../lib/toast'
import { Button, ConfirmButton, IconButton, Kbd } from '../ui'
import { cx } from '../ui/cx'
import { PagePreview } from './PagePreview'
import { OptChip, Section } from './parts'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ─── criar tarefa ───────────────────────────────────────────────────────────

export function NewTaskBar({
  schema,
  space,
  inputRef,
  onCreated,
}: {
  schema: NotionSchema | null
  space: Space
  inputRef: React.RefObject<HTMLInputElement | null>
  onCreated: (t: NotionTask) => void
}) {
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [prio, setPrio] = useState<string[]>([])
  const [cats, setCats] = useState<string[]>(() => defaultCategoryFor(space, schema))
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const catTouched = useRef(false)

  useEffect(() => {
    if (!catTouched.current) setCats(defaultCategoryFor(space, schema))
  }, [space, schema])

  const submit = async () => {
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      const created = await notion.createTask({
        title: t,
        ...(date && { date }),
        ...(prio.length && { prioridade: prio }),
        ...(cats.length && { categoria: cats }),
      })
      onCreated(created)
      toast({ title: 'tarefa criada', detail: created.title, tone: 'ok' })
      setTitle('')
      setDate('')
      setPrio([])
    } catch (e) {
      toast({ title: 'não criei a tarefa', detail: errMsg(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape') {
      ;(e.target as HTMLElement).blur()
      setOpen(false)
    }
  }

  const toggle = (list: string[], v: string, multi: boolean) =>
    list.includes(v) ? list.filter((x) => x !== v) : multi ? [...list, v] : [v]

  const t0 = todayYmd()
  const quick: [string, string][] = [
    ['hoje', t0],
    ['amanhã', addDaysYmd(t0, 1)],
    ['+7d', addDaysYmd(t0, 7)],
  ]

  return (
    <div
      className={cx(
        'rounded-lg border transition-[border-color,box-shadow] duration-[var(--hc-dur-2)]',
        open ? 'border-amber/40 bg-panel2/70 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-amber)_8%,transparent)]' : 'border-edge bg-panel/60',
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span aria-hidden className={cx('text-[14px] leading-none', open ? 'text-amber' : 'text-faint')}>
          +
        </span>
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder="nova tarefa no TO-DO…"
          aria-label="título da nova tarefa"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-faint"
        />
        {!open && <Kbd keys="T" />}
        {open && (
          <Button size="xs" variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void submit()}>
            criar ↵
          </Button>
        )}
      </div>
      {open && schema && (
        <div className="hc-fade-in flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-edge px-2.5 py-1.5">
          <div className="flex items-center gap-1">
            <span className="label !text-[8.5px]">prazo</span>
            {quick.map(([l, v]) => (
              <OptChip key={l} name={l} color={date === v ? 'yellow' : undefined} active={date === v} onClick={() => setDate(date === v ? '' : v)} small />
            ))}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="prazo"
              className="h-5 rounded border border-edge bg-void/50 px-1 font-mono text-[10px] text-dim outline-none focus:border-amber/50 [color-scheme:dark]"
            />
          </div>
          {schema.priorities.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="label !text-[8.5px]">prio</span>
              {schema.priorities.map((o) => (
                <OptChip key={o.name} name={o.name} color={o.color} active={prio.includes(o.name)} onClick={() => setPrio(toggle(prio, o.name, false))} small />
              ))}
            </div>
          )}
          {schema.categories.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="label !text-[8.5px]">categoria</span>
              {schema.categories.map((o) => (
                <OptChip
                  key={o.name}
                  name={o.name}
                  color={o.color}
                  active={cats.includes(o.name)}
                  onClick={() => {
                    catTouched.current = true
                    setCats(toggle(cats, o.name, true))
                  }}
                  small
                />
              ))}
            </div>
          )}
          <button type="button" onClick={() => setOpen(false)} className="ml-auto text-[10px] text-faint hover:text-dim">
            fechar
          </button>
        </div>
      )}
    </div>
  )
}

// ─── detalhe / edição ───────────────────────────────────────────────────────

export function TaskDetail({
  task,
  schema,
  onPatch,
  onArchived,
  onClose,
}: {
  task: NotionTask
  schema: NotionSchema | null
  onPatch: (id: string, p: TaskPatch) => Promise<NotionTask>
  onArchived: (t: NotionTask) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [saving, setSaving] = useState<string | null>(null)
  useEffect(() => setTitle(task.title), [task.id, task.title])

  const save = async (field: string, p: TaskPatch) => {
    setSaving(field)
    try {
      await onPatch(task.id, p)
    } catch (e) {
      toast({ title: 'Notion recusou a alteração', detail: errMsg(e), tone: 'error' })
    } finally {
      setSaving(null)
    }
  }

  const commitTitle = () => {
    const t = title.trim()
    if (!t) return setTitle(task.title)
    if (t !== task.title) void save('title', { title: t })
  }

  const archive = async () => {
    try {
      await notion.archiveTask(task.id)
      onArchived(task)
      toast({ title: 'tarefa arquivada', detail: `${task.title} — restaure pela lixeira do Notion`, tone: 'info' })
    } catch (e) {
      toast({ title: 'não arquivei', detail: errMsg(e), tone: 'error' })
    }
  }

  const multiToggle = (cur: string[], v: string, multi: boolean) =>
    cur.includes(v) ? cur.filter((x) => x !== v) : multi ? [...cur, v] : [v]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-2 border-b border-edge px-4 pt-3 pb-2">
        <textarea
          value={title}
          rows={1}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLTextAreaElement).blur()
            } else if (e.key === 'Escape') {
              setTitle(task.title)
              ;(e.target as HTMLTextAreaElement).blur()
            }
          }}
          aria-label="título"
          className="font-display field-sizing-content min-w-0 flex-1 resize-none bg-transparent text-[15px] leading-snug text-ink outline-none focus:text-amber"
        />
        <IconButton label="fechar detalhe (Esc)" onClick={onClose}>
          ×
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {schema && (
          <div className="space-y-2.5">
            <Row label="status" busy={saving === 'status'}>
              {schema.statuses.map((s) => (
                <OptChip key={s.name} name={s.name} color={s.color === 'default' ? 'gray' : s.color} active={task.status === s.name} onClick={() => task.status !== s.name && void save('status', { status: s.name })} />
              ))}
            </Row>
            {schema.priorities.length > 0 && (
              <Row label="prioridade" busy={saving === 'prio'}>
                {schema.priorities.map((o) => (
                  <OptChip
                    key={o.name}
                    name={o.name}
                    color={o.color}
                    active={task.prioridade.includes(o.name)}
                    onClick={() => void save('prio', { prioridade: multiToggle(task.prioridade, o.name, false) })}
                  />
                ))}
              </Row>
            )}
            {schema.categories.length > 0 && (
              <Row label="categoria" busy={saving === 'cat'}>
                {schema.categories.map((o) => (
                  <OptChip
                    key={o.name}
                    name={o.name}
                    color={o.color}
                    active={task.categoria.includes(o.name)}
                    onClick={() => void save('cat', { categoria: multiToggle(task.categoria, o.name, true) })}
                  />
                ))}
              </Row>
            )}
            {schema.dateProp && (
              <Row label="prazo" busy={saving === 'date'}>
                <input
                  type="date"
                  value={task.date?.slice(0, 10) ?? ''}
                  onChange={(e) => void save('date', { date: e.target.value || null })}
                  aria-label="prazo"
                  className="h-6 rounded border border-edge bg-void/50 px-1.5 font-mono text-[10.5px] text-dim outline-none focus:border-amber/50 [color-scheme:dark]"
                />
                {task.date && (
                  <button type="button" className="text-[10px] text-faint hover:text-alert" onClick={() => void save('date', { date: null })}>
                    limpar
                  </button>
                )}
              </Row>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={() => openInNotion(task.url).catch((e: unknown) => toast({ title: 'não abri', detail: errMsg(e), tone: 'error' }))}>
            abrir no Notion ↗
          </Button>
          <ConfirmButton onConfirm={archive} confirmLabel="arquivar mesmo?" title="move para a lixeira do Notion">
            arquivar
          </ConfirmButton>
        </div>
        <Section label="conteúdo">
          <PagePreview id={task.id} showProps={false} compact />
        </Section>
      </div>
    </div>
  )
}

function Row({ label, busy, children }: { label: string; busy?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className={cx('label w-[72px] shrink-0 pt-[3px] !text-[9px]', busy && 'hc-pulse-dot text-warn')}>{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{children}</div>
    </div>
  )
}
