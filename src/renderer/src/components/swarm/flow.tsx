import type { ReactNode } from 'react'
import { FLOW_STEPS, OUTCOME_LABEL, runFlow, type FlowOutcome, type NextStep } from '../../lib/flow'
import type { Approval, RunMeta } from '../../lib/swarm'
import { cx } from '../ui'

// Peças visuais do fluxo de delegação (lib/flow): stepper de etapas e banner
// "próximo passo". Movimento: conector da etapa atual "flui" (hc-flow-x) enquanto
// há trabalho; nó atual com anel pulsante; tudo desliga com reduced-motion.

const OUTCOME_TONE: Record<FlowOutcome, { text: string; bg: string; border: string }> = {
  done: { text: 'text-cyanic', bg: 'bg-cyanic', border: 'border-cyanic/60' },
  error: { text: 'text-alert', bg: 'bg-alert', border: 'border-alert/60' },
  cancelled: { text: 'text-faint', bg: 'bg-faint', border: 'border-faint/60' },
}

/**
 * Stepper horizontal: Criada → Na fila → Executando → Aguardando você → Resultado.
 * "Aguardando você" é opcional (tracejado) — só acende se a run parar lá.
 * `compact`: só os nós + rótulo da etapa atual (cards da masterview, linhas).
 */
export function FlowRail({
  run,
  approvals,
  compact = false,
  className,
}: {
  run: RunMeta
  approvals: Approval[]
  compact?: boolean
  className?: string
}) {
  const f = runFlow(run, approvals)
  const live = f.step === 'running' || f.step === 'queued'
  const waiting = f.step === 'waiting'
  const outcome = f.outcome
  return (
    <ol
      className={cx('hc-flow flex min-w-0 items-center', className)}
      aria-label={`etapa: ${outcome ? OUTCOME_LABEL[outcome] : FLOW_STEPS[f.index]?.label}`}
    >
      {FLOW_STEPS.map((s, i) => {
        const past = i < f.index
        const cur = i === f.index
        // "aguardando você" pulado (run passou direto ou terminou sem parar) → fica tracejado
        const skipped = s.id === 'waiting' && !cur && f.step !== 'waiting'
        const label = s.id === 'end' && outcome ? OUTCOME_LABEL[outcome] : s.label
        const tone =
          cur && outcome
            ? OUTCOME_TONE[outcome]
            : cur && waiting
              ? { text: 'text-amber', bg: 'bg-amber', border: 'border-amber/70' }
              : cur
                ? { text: 'text-phos', bg: 'bg-phos', border: 'border-phos/60' }
                : past && !skipped
                  ? { text: 'text-dim', bg: 'bg-dim', border: 'border-dim/50' }
                  : { text: 'text-faint', bg: 'bg-transparent', border: 'border-edge2' }
        return (
          <li key={s.id} className={cx('flex min-w-0 items-center', i < FLOW_STEPS.length - 1 && 'flex-1')}>
            <span
              className={cx('flex shrink-0 items-center gap-1.5', !compact && 'flex-col gap-1')}
              title={`${label} — ${s.hint}`}
            >
              <span
                data-state={cur ? 'current' : past ? 'past' : 'future'}
                className={cx(
                  'hc-flow-node relative flex items-center justify-center rounded-full border',
                  compact ? 'h-2 w-2' : 'h-3 w-3',
                  tone.border,
                  skipped && 'border-dashed',
                  cur && (waiting ? 'hc-flow-node-you' : live ? 'hc-flow-node-live' : ''),
                )}
              >
                <span className={cx('rounded-full', compact ? 'h-1 w-1' : 'h-1.5 w-1.5', (cur || (past && !skipped)) && tone.bg)} />
              </span>
              {!compact && (
                <span
                  key={cur ? `${s.id}-${run.status}` : s.id}
                  className={cx(
                    'whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.04em]',
                    tone.text,
                    cur && 'hc-pop font-semibold',
                    skipped && 'opacity-60',
                  )}
                >
                  {label}
                </span>
              )}
            </span>
            {i < FLOW_STEPS.length - 1 && (
              <span
                aria-hidden
                className={cx(
                  'mx-0.5 h-px min-w-1 flex-1',
                  !compact && 'mb-4',
                  cur && live ? 'hc-flow-x' : cur && waiting ? 'hc-flow-x-amber' : past ? 'bg-dim/50' : 'bg-edge2',
                  s.id === 'running' && f.step !== 'waiting' && 'opacity-60',
                )}
              />
            )}
          </li>
        )
      })}
      {compact && (
        <span
          key={run.status}
          className={cx(
            'hc-pop ml-2 shrink-0 font-mono text-[9px] uppercase tracking-[0.04em]',
            outcome ? OUTCOME_TONE[outcome].text : waiting ? 'text-warn' : 'text-phos',
          )}
        >
          {outcome ? OUTCOME_LABEL[outcome] : FLOW_STEPS[f.index]?.label}
        </span>
      )}
    </ol>
  )
}

const NEXT_TONE: Record<NextStep['tone'], { box: string; dot: string; kicker: string }> = {
  you: { box: 'border-amber/50 bg-amber/[0.06] hc-breathe', dot: 'bg-amber hc-pulse-dot', kicker: 'text-amber' },
  wait: { box: 'border-edge2 bg-panel2/40', dot: 'bg-phos hc-pulse-dot', kicker: 'text-phos' },
  ok: { box: 'border-cyanic/30 bg-cyanic/[0.04]', dot: 'bg-cyanic', kicker: 'text-cyanic' },
  bad: { box: 'border-alert/40 bg-alert/[0.05]', dot: 'bg-alert', kicker: 'text-alert' },
  idle: { box: 'border-edge2 bg-panel2/30', dot: 'bg-faint', kicker: 'text-faint' },
}

/** Banner "próximo passo" — onde a run está e o que fazer agora, com CTA evidente. */
export function NextStepBanner({ step, action, compact = false }: { step: NextStep; action?: ReactNode; compact?: boolean }) {
  const t = NEXT_TONE[step.tone]
  return (
    <div
      key={`${step.tone}-${step.headline}`}
      role={step.tone === 'you' ? 'alert' : 'status'}
      className={cx('hc-rise flex min-w-0 items-center gap-3 rounded-lg border', compact ? 'px-2.5 py-1.5' : 'px-3.5 py-2.5', t.box)}
    >
      <span className={cx('h-2 w-2 shrink-0 rounded-full', t.dot)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className={cx('font-mono text-[9.5px] uppercase tracking-[0.16em]', t.kicker)}>
          {step.tone === 'you' ? 'próximo passo · com você' : step.tone === 'wait' ? 'em andamento · sem ação' : 'próximo passo'}
        </div>
        <div className={cx('truncate text-ink', compact ? 'text-[11.5px]' : 'text-[12.5px]')}>{step.headline}</div>
        {(!compact || step.tone === 'bad') && (
          <div className={cx('line-clamp-2 leading-snug', step.tone === 'bad' ? 'text-alert/85' : 'text-dim', compact ? 'text-[10.5px]' : 'text-[11px]')}>
            {step.detail}
          </div>
        )}
      </div>
      {action}
    </div>
  )
}
