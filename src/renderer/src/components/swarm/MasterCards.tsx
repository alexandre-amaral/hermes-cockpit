import { memo, useMemo, type ReactNode } from 'react'
import { epochMs, subLabel, subTone, SUB_TERMINAL, type ActiveSub, type LiveInfo } from '../../lib/delegation'
import { ago, retryRun } from '../../lib/flow'
import {
  fmtDuration,
  repoName,
  runElapsedMs,
  runHandle,
  STATUS_TONE,
  useRunEvents,
  type Approval,
  type RunMeta,
} from '../../lib/swarm'
import { fmtRunTokens } from '../../lib/swarm-tokens'
import { useViewActive } from '../layout/views'
import { cx } from '../ui'
import { FlowRail } from './flow'
import { buildItems } from './RunStream'
import { summarizeInput } from './ui'

// Peças da masterview (Comando): coluna, card de run ao vivo, card de subagent
// Hermes, linha de conclusão e diário de bordo. Só dados reais (RunMeta,
// eventos da run, delegation.status + subagent.*).

export function Column({
  kicker,
  title,
  count,
  tone = 'neutral',
  hot = false,
  aside,
  children,
}: {
  kicker: string
  title: string
  count: number
  tone?: 'phos' | 'amber' | 'warn' | 'cyanic' | 'neutral'
  /** destaque (ex.: há algo esperando o usuário) */
  hot?: boolean
  aside?: ReactNode
  children: ReactNode
}) {
  const t = {
    phos: 'text-phos',
    amber: 'text-amber',
    warn: 'text-warn',
    cyanic: 'text-cyanic',
    neutral: 'text-dim',
  }[tone]
  return (
    <section
      className={cx(
        'hc-card flex min-h-[220px] min-w-0 flex-col overflow-hidden transition-[border-color] duration-[var(--hc-dur-3)]',
        hot && 'hc-breathe border-[color-mix(in_srgb,var(--color-warn)_45%,transparent)]',
      )}
    >
      <header className="flex items-end gap-2 border-b border-edge/80 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <div className={cx('font-mono text-[9.5px] uppercase tracking-[0.2em]', t)}>{kicker}</div>
          <h3 className="font-display truncate text-[17px] leading-tight text-ink">{title}</h3>
        </div>
        <span key={count} className={cx('hc-num-swap ml-auto font-mono text-[22px] leading-none tabular-nums', count ? t : 'text-faint')}>
          {count}
        </span>
      </header>
      {aside && <div className="border-b border-edge/60 px-4 py-1.5 text-[10.5px]">{aside}</div>}
      <div className="hc-stagger flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">{children}</div>
    </section>
  )
}

type Item = ReturnType<typeof buildItems>[number]

/** última coisa que a run fez, em uma linha */
function lastActivity(items: Item[]): { text: string; cls: string } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.k === 'tool') return { text: `→ ${it.name} ${summarizeInput(it.name, it.input)}`.trim(), cls: 'text-cyanic' }
    if (it.k === 'task') return { text: `${it.done ? '✓' : '⟳'} ${it.text}`, cls: it.done ? 'text-phos' : 'text-amber' }
    if (it.k === 'text') {
      const l = it.text.split('\n').filter(Boolean).pop()
      if (l) return { text: l, cls: 'text-ink/85' }
    }
    if (it.k === 'thinking') return { text: '∴ pensando…', cls: 'text-faint italic' }
    if (it.k === 'init') return { text: `── claude iniciou · ${it.model ?? '?'}`, cls: 'text-faint' }
  }
  return null
}

/** Run ativa: identidade, stepper compacto e o último passo ao vivo. */
export const LiveRunCard = memo(function LiveRunCard({
  run,
  approvals,
  now,
  onOpen,
}: {
  run: RunMeta
  approvals: Approval[]
  now: number
  onOpen: () => void
}) {
  // view escondida (keep-alive): sem polling; swarm:changed continua atualizando
  const ev = useRunEvents(run.id, useViewActive())
  const items = useMemo(() => buildItems(ev.lines), [ev.lines])
  const last = lastActivity(items)
  const steps = items.filter((i) => i.k === 'tool').length
  const waiting = approvals.some((a) => a.runId === run.id)
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx(
        'hc-card hc-card-hover group block w-full min-w-0 px-3 py-2.5 text-left',
        waiting ? 'border-[color-mix(in_srgb,var(--color-warn)_50%,transparent)]' : 'border-phos/25',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-[10px] text-dim">{runHandle(run)}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={run.task}>
          {run.title || run.task}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">{fmtDuration(runElapsedMs(run, now))}</span>
      </span>
      <FlowRail run={run} approvals={approvals} compact className="mt-2" />
      <span className="hc-scan mt-2 block overflow-hidden rounded border border-edge/70 bg-void/70 px-2 py-1 font-mono text-[10.5px]">
        <span key={last?.text ?? 'none'} className={cx('hc-fade-in block truncate', last?.cls ?? 'text-faint')} title={last?.text}>
          {last?.text ?? (ev.loading ? 'conectando ao stream…' : 'aguardando o primeiro evento…')}
        </span>
      </span>
      <span className="mt-1.5 flex min-w-0 gap-2 text-[10px] text-faint">
        <span className="truncate" title={run.repo}>
          {repoName(run.repo)}
          {run.branch ? ` ⎇ ${run.branch.replace(/^hermes\//, '')}` : ''}
        </span>
        <span className="ml-auto shrink-0">{steps ? `${steps} passos` : ''}</span>
        <span className="shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100">abrir →</span>
      </span>
    </button>
  )
})

/** Subagent nativo do Hermes em campo. */
export function SubCard({ sub, info, lvl, now, onOpen }: { sub: ActiveSub; info?: LiveInfo; lvl: number; now: number; onOpen: () => void }) {
  const status = info?.status ?? sub.status ?? 'running'
  const start = epochMs(sub.started_at)
  const tool = info?.lastTool ?? sub.last_tool
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ marginLeft: lvl * 12 }}
      className="hc-card hc-card-hover group block min-w-0 px-3 py-2 text-left"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="rounded border border-cyanic/40 px-1 font-mono text-[9px] uppercase tracking-[0.12em] text-cyanic">hermes</span>
        <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', subTone(status), !SUB_TERMINAL.has(status) && 'hc-pulse-dot')} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{sub.goal || info?.goal || sub.subagent_id}</span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">{start ? fmtDuration(now - start) : ''}</span>
      </span>
      <span className="mt-1 flex min-w-0 gap-2 text-[10px] text-faint">
        <span>{subLabel(status)}</span>
        {sub.model && <span className="truncate">{sub.model}</span>}
        {sub.tool_count != null && <span>{sub.tool_count} tools</span>}
        {tool && <span key={tool} className="hc-fade-in truncate text-cyanic/80">→ {tool}</span>}
        <span className="ml-auto shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100">inspecionar →</span>
      </span>
    </button>
  )
}

/** Run terminada (concluída/falhou/cancelada) com resumo do resultado. */
export function FinishedRow({ run, now, onOpen, onRetried }: { run: RunMeta; now: number; onOpen: () => void; onRetried: (id: string) => void }) {
  const ok = run.status === 'done'
  const summary = ok ? run.resultText?.split('\n').find((l) => l.trim()) : run.error
  return (
    <div className="group relative min-w-0 rounded-md border border-edge/70 bg-panel/50 transition-colors hover:border-edge2 hover:bg-hover/60">
      <button type="button" onClick={onOpen} className="block w-full min-w-0 px-3 py-2 text-left">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_TONE[run.status].bg)} />
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink" title={run.task}>
            {run.title || run.task}
          </span>
          <span className="shrink-0 text-[10px] text-faint">{ago(run.endedAt ?? run.createdAt, now)}</span>
        </span>
        {summary && (
          <span className={cx('mt-0.5 block truncate pl-3.5 text-[10.5px]', ok ? 'text-dim' : 'text-alert/85')} title={summary}>
            {summary.replace(/^#+\s*/, '')}
          </span>
        )}
        <span className="mt-0.5 flex gap-2 pl-3.5 text-[10px] text-faint">
          <span className={STATUS_TONE[run.status].text}>{runHandle(run)}</span>
          <span>{fmtDuration(runElapsedMs(run, now))}</span>
          {run.tokensTotal != null && <span>{fmtRunTokens(run.tokensTotal)}</span>}
        </span>
      </button>
      {!ok && (
        <button
          type="button"
          onClick={async () => {
            const next = await retryRun(run)
            if (next) onRetried(next.id)
          }}
          className="hc-press absolute right-2 top-1.5 rounded border border-edge2 bg-panel px-1.5 py-px text-[10px] text-dim opacity-0 transition-opacity hover:border-amber/60 hover:text-amber focus-visible:opacity-100 group-hover:opacity-100"
        >
          ↻ repetir
        </button>
      )}
    </div>
  )
}

// ── diário de bordo: transições reais derivadas dos timestamps das runs ─────

export interface LogEntry {
  at: number
  runId: string
  glyph: string
  cls: string
  dot: string
  text: string
}

export function buildLog(runs: RunMeta[], approvals: Approval[], limit = 14): LogEntry[] {
  const out: LogEntry[] = []
  const t = (iso?: string) => (iso ? Date.parse(iso) : NaN)
  for (const r of runs) {
    const who = runHandle(r)
    const name = `“${(r.title || r.task).slice(0, 60)}”`
    const c = t(r.createdAt)
    if (!Number.isNaN(c))
      out.push({ at: c, runId: r.id, glyph: '◇', cls: 'text-dim', dot: 'bg-edge2', text: `${r.parentRunId ? `${who} continuou` : `${who} delegou`} ${name}` })
    const e = t(r.endedAt)
    if (!Number.isNaN(e)) {
      const map = {
        done: { glyph: '✓', cls: 'text-cyanic', dot: 'bg-cyanic', verb: 'entregou' },
        error: { glyph: '✕', cls: 'text-alert', dot: 'bg-alert', verb: 'falhou em' },
        cancelled: { glyph: '◌', cls: 'text-faint', dot: 'bg-faint', verb: 'cancelou' },
      } as const
      const m = map[r.status as keyof typeof map]
      if (m) out.push({ at: e, runId: r.id, glyph: m.glyph, cls: m.cls, dot: m.dot, text: `${m.verb} ${name}` })
    }
  }
  for (const a of approvals) {
    const c = t(a.createdAt)
    if (Number.isNaN(c)) continue
    out.push({
      at: c,
      runId: a.runId,
      glyph: '!',
      cls: 'text-amber',
      dot: 'bg-amber',
      text: a.toolName === 'AskUserQuestion' ? 'Claude perguntou algo — aguardando você' : `pediu aprovação para ${a.toolName}`,
    })
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit)
}

export function LogFeed({ entries, onOpen }: { entries: LogEntry[]; onOpen: (runId: string) => void }) {
  if (!entries.length) return <div className="px-1 py-2 text-[11px] text-faint">nada registrado ainda — a primeira delegação aparece aqui.</div>
  return (
    <ol className="hc-stagger relative ml-1.5 border-l border-edge2/70">
      {entries.map((e) => (
        <li key={`${e.runId}-${e.at}-${e.glyph}`} className="relative">
          <button type="button" onClick={() => onOpen(e.runId)} className="flex w-full min-w-0 items-baseline gap-2 rounded py-0.5 pl-3 pr-1 text-left hover:bg-hover/50">
            <span className={cx('absolute -left-[4.5px] top-[7px] h-2 w-2 rounded-full border border-void', e.dot)} aria-hidden />
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">
              {new Date(e.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className={cx('shrink-0 font-mono text-[10.5px]', e.cls)}>{e.glyph}</span>
            <span className="min-w-0 truncate text-[11px] text-dim">{e.text}</span>
          </button>
        </li>
      ))}
    </ol>
  )
}
