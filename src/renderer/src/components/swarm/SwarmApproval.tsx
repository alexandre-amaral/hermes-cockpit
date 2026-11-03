import { useState } from 'react'
import { errMsg, refreshSwarm, runHandle, swarmApi, type Approval, type RunMeta } from '../../lib/swarm'
import { toast } from '../../lib/toast'
import { prettyJson, summarizeInput } from './ui'

// Card de aprovação de ferramenta do Claude Code (perm.mjs → arquivo → cockpit).
// Mesmo idioma visual do ApprovalCard do chat: âmbar tracejado.

export function SwarmApprovalCard({
  approval,
  run,
  compact = false,
  onSelectRun,
}: {
  approval: Approval
  run?: RunMeta
  compact?: boolean
  onSelectRun?: (runId: string) => void
}) {
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [showReason, setShowReason] = useState(false)
  const [expanded, setExpanded] = useState(!compact)

  const decide = async (d: 'allow' | 'deny') => {
    setBusy(d)
    setError(null)
    try {
      await swarmApi.decide(approval.id, d, reason.trim() || undefined)
      toast({ title: d === 'allow' ? 'Aprovado' : 'Negado', detail: approval.toolName, tone: d === 'allow' ? 'ok' : 'info' })
      void refreshSwarm()
    } catch (e) {
      setError(errMsg(e))
      setBusy(null)
    }
  }

  const summary = summarizeInput(approval.toolName, approval.input)

  if (approval.toolName === 'AskUserQuestion') {
    return <QuestionCard approval={approval} run={run} onSelectRun={onSelectRun} />
  }

  return (
    <div className="hc-rise hc-breathe rounded-lg border border-dashed border-amber/70 bg-amber/[0.04] px-3.5 py-2.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="font-bold text-amber glow-amber">!</span>
        <span className="shrink-0 text-[12px] text-ink">Aprovação pendente</span>
        <span className="min-w-0 truncate text-[12px] text-warn">· {approval.toolName}</span>
        {run && (
          <button
            type="button"
            onClick={() => onSelectRun?.(run.id)}
            className="ml-auto shrink-0 text-[10.5px] text-dim hover:text-ink"
            title={run.title || run.task}
          >
            {runHandle(run)}
          </button>
        )}
      </div>
      {summary && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 block w-full truncate text-left text-[11.5px] text-dim hover:text-ink"
          title="ver input completo"
        >
          {summary}
        </button>
      )}
      {expanded && (
        <pre className="hc-fade-in mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-void px-2.5 py-1.5 text-[11px] text-ink/90">
          {prettyJson(approval.input)}
        </pre>
      )}
      {showReason && (
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="motivo (opcional, vai ao claude)"
          className="mt-2 w-full rounded border border-edge2 bg-void px-2 py-1 text-[11px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
        />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => decide('allow')}
          className="rounded bg-amber px-3 py-1 text-[11.5px] font-semibold text-void hover:brightness-110 disabled:opacity-50"
        >
          {busy === 'allow' ? 'Aprovando…' : 'Aprovar'}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => decide('deny')}
          className="rounded border border-edge2 px-3 py-1 text-[11.5px] text-ink hover:border-alert hover:text-alert disabled:opacity-50"
        >
          {busy === 'deny' ? 'Negando…' : 'Negar'}
        </button>
        {!showReason && (
          <button type="button" onClick={() => setShowReason(true)} className="text-[10.5px] text-faint hover:text-dim">
            + motivo
          </button>
        )}
        {error && <span className="text-[11px] text-alert">{error}</span>}
      </div>
    </div>
  )
}

interface QOption {
  label: string
  description?: string
}
interface Question {
  question: string
  header?: string
  options?: QOption[]
  multiSelect?: boolean
}

/**
 * Pergunta do Claude Code (AskUserQuestion) respondida pelo operador. A resposta
 * volta ao worker como updatedInput = {...input, answers: {[pergunta]: rótulo}}
 * (multiSelect: rótulos separados por ", "). "Deixar ele decidir" nega → o
 * worker escolhe sozinho e registra a suposição.
 */
function QuestionCard({ approval, run, onSelectRun }: { approval: Approval; run?: RunMeta; onSelectRun?: (runId: string) => void }) {
  const input = (approval.input ?? {}) as { questions?: Question[] }
  const questions = Array.isArray(input.questions) ? input.questions : []
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const answerOf = (i: number): string => {
    const o = other[i]?.trim()
    if (o) return o
    return (picked[i] ?? []).join(', ')
  }
  const complete = questions.length > 0 && questions.every((_, i) => answerOf(i))

  const toggle = (i: number, label: string, multi?: boolean) =>
    setPicked((p) => {
      const cur = p[i] ?? []
      const next = multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label]
      return { ...p, [i]: next }
    })

  const send = async (answer: boolean) => {
    setBusy(true)
    setError(null)
    try {
      if (answer) {
        const answers: Record<string, string> = {}
        questions.forEach((q, i) => (answers[q.question] = answerOf(i)))
        await swarmApi.decide(approval.id, 'allow', undefined, { ...input, answers })
        toast({ title: 'Resposta enviada ao Claude Code', tone: 'ok' })
      } else {
        await swarmApi.decide(approval.id, 'deny', 'operador deixou a decisão com o agente')
        toast({ title: 'Claude Code vai decidir sozinho', tone: 'info' })
      }
      void refreshSwarm()
    } catch (e) {
      setError(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <div className="hc-rise rounded-lg border border-dashed border-cyanic/70 bg-cyanic/[0.05] px-3.5 py-2.5 shadow-[0_0_24px_-10px_var(--color-cyanic)]">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="hc-pulse-dot inline-block h-2 w-2 shrink-0 rounded-full bg-cyanic" />
        <span className="shrink-0 text-[12px] font-semibold text-ink">Claude Code pergunta</span>
        {run && (
          <button type="button" onClick={() => onSelectRun?.(run.id)} className="ml-auto min-w-0 truncate text-[10.5px] text-dim hover:text-ink" title={run.title || run.task}>
            {runHandle(run)}
          </button>
        )}
      </div>
      <div className="mt-2 space-y-3">
        {questions.map((q, i) => (
          <div key={i}>
            {q.header && <div className="label mb-0.5 text-[9.5px] text-cyanic">{q.header}</div>}
            <div className="mb-1.5 text-[12px] leading-snug text-ink">{q.question}</div>
            <div className="flex flex-col gap-1">
              {(q.options ?? []).map((o) => {
                const on = (picked[i] ?? []).includes(o.label) && !other[i]?.trim()
                return (
                  <button
                    key={o.label}
                    type="button"
                    disabled={busy}
                    onClick={() => toggle(i, o.label, q.multiSelect)}
                    className={`rounded border px-2.5 py-1.5 text-left transition-colors ${
                      on ? 'border-cyanic bg-cyanic/15 text-ink' : 'border-edge2 bg-void/60 text-dim hover:border-cyanic/60 hover:text-ink'
                    }`}
                  >
                    <div className="text-[11.5px]">
                      {q.multiSelect ? (on ? '☑ ' : '☐ ') : on ? '◉ ' : '○ '}
                      {o.label}
                    </div>
                    {o.description && <div className="mt-0.5 text-[10.5px] text-faint">{o.description}</div>}
                  </button>
                )
              })}
              <input
                value={other[i] ?? ''}
                disabled={busy}
                onChange={(e) => setOther((p) => ({ ...p, [i]: e.target.value }))}
                placeholder="outra resposta (texto livre)…"
                className="rounded border border-edge2 bg-void px-2 py-1 text-[11px] text-ink outline-none placeholder:text-faint focus:border-cyanic/60"
              />
            </div>
          </div>
        ))}
        {questions.length === 0 && <pre className="max-h-40 overflow-auto text-[11px] text-dim">{prettyJson(approval.input)}</pre>}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !complete}
          onClick={() => void send(true)}
          className="rounded bg-cyanic px-3 py-1 text-[11.5px] font-semibold text-void hover:brightness-110 disabled:opacity-40"
        >
          {busy ? 'Enviando…' : 'Responder'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void send(false)}
          className="rounded border border-edge2 px-3 py-1 text-[11.5px] text-dim hover:border-edge2 hover:text-ink disabled:opacity-50"
        >
          Deixar ele decidir
        </button>
        {error && <span className="text-[11px] text-alert">{error}</span>}
      </div>
    </div>
  )
}
