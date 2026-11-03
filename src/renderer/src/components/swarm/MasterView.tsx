import { useMemo, useState } from 'react'
import { botTitle } from '../../lib/bots'
import type { HermesDelegation } from '../../lib/delegation'
import { errMsg, isActive, useNow, type RunMeta, type SwarmState } from '../../lib/swarm'
import { fmtTokens, tokensInWindow } from '../../lib/swarm-tokens'
import { toast } from '../../lib/toast'
import { CountUp, cx, EmptyState } from '../ui'
import { buildLog, Column, FinishedRow, LiveRunCard, LogFeed, SubCard } from './MasterCards'
import { SwarmApprovalCard } from './SwarmApproval'

// Masterview "Ponte de comando": a história do swarm em três tempos —
//   AGORA (quem está em campo) · COM VOCÊ (o que espera decisão) · ENTREGUE (o que terminou)
// mais o esquadrão (bots que delegam) e o diário de bordo. Reúne runs do Claude
// Code (lib/swarm) e subagents nativos do Hermes (lib/delegation) — mesmas
// fontes da árvore e das abas de detalhe; nada mockado. A inspeção profunda
// continua nas outras abas (Execuções, Árvore, Subagents).

const DAY = 24 * 3600e3
const FAIL_WINDOW = 12 * 3600e3
const MAX_FINISHED = 8

interface Crew {
  key: string
  label: string
  active: number
  waiting: number
  today: number
}

export function MasterView({
  s,
  deleg,
  onOpenRun,
  onOpenSub,
  onNewTask,
  onShowTree,
}: {
  s: SwarmState
  deleg: HermesDelegation
  onOpenRun: (runId: string) => void
  onOpenSub: (subId: string) => void
  onNewTask: () => void
  onShowTree: () => void
}) {
  const anyLive = s.runs.some((r) => isActive(r.status)) || deleg.tree.length > 0
  const now = useNow(anyLive ? 1000 : 30_000)
  const [crew, setCrew] = useState<string | null>(null)

  const whoOf = (r: RunMeta) => r.requestedBy?.profile || 'cockpit'
  const runs = useMemo(() => (crew ? s.runs.filter((r) => whoOf(r) === crew) : s.runs), [s.runs, crew])
  const waitingRunIds = useMemo(() => new Set(s.approvals.map((a) => a.runId)), [s.approvals])

  const active = runs.filter((r) => isActive(r.status))
  // quem espera você primeiro, depois os mais recentes
  active.sort((a, b) => Number(waitingRunIds.has(b.id)) - Number(waitingRunIds.has(a.id)) || b.createdAt.localeCompare(a.createdAt))
  const ended = runs.filter((r) => !isActive(r.status))
  const endedAt = (r: RunMeta) => Date.parse(r.endedAt ?? r.createdAt) || 0
  const recent = ended.filter((r) => now - endedAt(r) < DAY)
  const failures = ended.filter((r) => r.status === 'error' && now - endedAt(r) < FAIL_WINDOW).slice(0, 3)
  const finished = [...ended].sort((a, b) => endedAt(b) - endedAt(a)).slice(0, MAX_FINISHED)
  const doneToday = recent.filter((r) => r.status === 'done').length
  // consumo em tokens reais (soma do result de cada run); runs sem dado ficam fora e são contadas no hint
  const tok24 = tokensInWindow(s.runs, now, DAY)
  const approvals = crew ? s.approvals.filter((a) => { const r = s.runs.find((x) => x.id === a.runId); return !r || whoOf(r) === crew }) : s.approvals
  const subs = crew ? [] : deleg.tree
  const inField = active.length + subs.length
  const needYou = approvals.length

  const roster = useMemo<Crew[]>(() => {
    const m = new Map<string, Crew>()
    const get = (k: string) => {
      let c = m.get(k)
      if (!c) {
        c = { key: k, label: k === 'cockpit' ? 'Você (cockpit)' : botTitle(k), active: 0, waiting: 0, today: 0 }
        m.set(k, c)
      }
      return c
    }
    for (const p of s.status?.profilesRegistered ?? []) get(p)
    for (const r of s.runs) {
      const c = get(whoOf(r))
      if (isActive(r.status)) c.active++
      if (waitingRunIds.has(r.id)) c.waiting++
      if (now - (Date.parse(r.createdAt) || 0) < DAY) c.today++
    }
    return [...m.values()].sort((a, b) => b.waiting - a.waiting || b.active - a.active || b.today - a.today || a.label.localeCompare(b.label))
  }, [s.runs, s.status, waitingRunIds, now])

  const log = useMemo(() => buildLog(runs, approvals), [runs, approvals])
  const story = headline({ inField, needYou, doneToday, lastFailed: failures[0], swarmDown: swarmIssue(s) })
  const clock = new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const pulse: 'you' | 'live' | 'idle' = needYou ? 'you' : inField ? 'live' : 'idle'

  return (
    <div className="relative h-full min-h-0 overflow-y-auto">
      <div className="hc-grid-bg pointer-events-none absolute inset-x-0 top-0 h-72" aria-hidden />

      {/* ── cabeçalho: a frase do momento + placar ───────────────────────── */}
      <header className="relative flex flex-wrap items-end gap-x-8 gap-y-4 px-6 pb-3 pt-6">
        <div className="min-w-[280px] flex-1">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em] text-faint">
            <span className={cx('h-1.5 w-1.5 rotate-45', pulse === 'you' ? 'bg-amber hc-pulse-dot' : pulse === 'live' ? 'bg-phos hc-pulse-dot' : 'bg-faint')} />
            ponte de comando · {clock}
            {crew && (
              <button type="button" onClick={() => setCrew(null)} className="hc-pop rounded border border-amber/50 px-1.5 text-amber normal-case tracking-normal hover:bg-amber/10">
                só {roster.find((c) => c.key === crew)?.label ?? crew} ✕
              </button>
            )}
          </div>
          <h2 key={story.title} className="font-display hc-rise mt-1.5 text-[28px] leading-[1.1] text-ink">
            {story.title}
          </h2>
          <p key={story.sub} className="hc-fade-in mt-1 max-w-[640px] text-[12.5px] text-dim">
            {story.sub}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onNewTask}
              className="hc-press hc-lift flex h-8 items-center gap-2 rounded-md border border-amber/70 bg-amber px-3.5 text-[12px] font-semibold text-void hover:brightness-110"
            >
              <span aria-hidden>＋</span> Delegar tarefa
            </button>
            <button
              type="button"
              onClick={onShowTree}
              className="hc-press h-8 rounded-md border border-edge2 px-3 text-[12px] text-dim hover:border-amber/50 hover:text-ink"
            >
              Ver árvore ao vivo
            </button>
          </div>
        </div>
        <dl className="grid grid-cols-4 gap-2">
          <Stat label="em campo" value={inField} tone={inField ? 'text-phos' : 'text-faint'} />
          <Stat label="com você" value={needYou} tone={needYou ? 'text-warn' : 'text-faint'} />
          <Stat label="entregues 24h" value={doneToday} tone={doneToday ? 'text-cyanic' : 'text-faint'} />
          <Stat
            label="tokens 24h"
            value={tok24.total}
            tone={tok24.total != null ? 'text-ink' : 'text-faint'}
            format={(n) => fmtTokens(Math.round(n))}
            hint={
              tok24.total == null
                ? 'sem dado de tokens nas runs das últimas 24h'
                : `${tok24.total.toLocaleString('pt-BR')} tokens (input + output + cache) em ${tok24.counted} run(s)` +
                  (tok24.missing ? ` · ${tok24.missing} sem dado de tokens` : '')
            }
          />
        </dl>
      </header>

      {/* ── pulso: linha de ECG viva (âmbar se algo espera você) ─────────── */}
      <Pulse state={pulse} />

      {/* ── esquadrão ─────────────────────────────────────────────────────── */}
      {roster.length > 0 && (
        <div className="relative flex flex-wrap items-center gap-1.5 px-6 pb-4 pt-2">
          <span className="label mr-1">esquadrão</span>
          {roster.map((c) => {
            const on = crew === c.key
            const state = c.waiting ? 'you' : c.active ? 'live' : 'idle'
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setCrew(on ? null : c.key)}
                aria-pressed={on}
                title={`${c.label}: ${c.active} em campo · ${c.today} nas últimas 24h${c.waiting ? ` · ${c.waiting} esperando você` : ''} — clique para filtrar`}
                className={cx(
                  'hc-press flex items-center gap-1.5 rounded-full border py-0.5 pl-1 pr-2.5 text-[11px]',
                  on ? 'border-amber/70 bg-amber/10 text-ink' : 'border-edge2 bg-panel/60 text-dim hover:border-faint hover:text-ink',
                )}
              >
                <span
                  className={cx(
                    'flex h-5 w-5 items-center justify-center rounded-full border font-display text-[11px]',
                    state === 'you' ? 'border-amber/70 text-amber' : state === 'live' ? 'border-phos/60 text-phos' : 'border-edge2 text-faint',
                  )}
                >
                  {c.label.charAt(0)}
                </span>
                {c.label}
                {c.active > 0 && <span className="font-mono text-[10px] text-phos">{c.active}▸</span>}
                {c.waiting > 0 && <span className="font-mono text-[10px] text-warn">{c.waiting}!</span>}
                {!c.active && !c.waiting && <span className="font-mono text-[10px] text-faint">{c.today || '·'}</span>}
              </button>
            )
          })}
          {deleg.online && deleg.tree.length > 0 && (
            <span className="ml-1 flex items-center gap-1.5 rounded-full border border-cyanic/40 px-2.5 py-0.5 text-[11px] text-cyanic">
              <span className="h-1.5 w-1.5 rounded-full bg-cyanic hc-pulse-dot" />
              {deleg.tree.length} subagent{deleg.tree.length > 1 ? 's' : ''} Hermes
            </span>
          )}
        </div>
      )}

      {/* ── três tempos ──────────────────────────────────────────────────── */}
      <div className="relative grid gap-4 px-6 pb-4 lg:grid-cols-3">
        <Column
          kicker="agora"
          title="Em campo"
          count={inField}
          tone="phos"
          aside={<SourceLine s={s} deleg={deleg} />}
        >
          {!inField ? (
            <EmptyState
              compact
              title="ninguém em campo"
              detail="Delegue uma tarefa ou peça a um bot (claude_spawn / delegate_tool). Ela aparece aqui com o último passo ao vivo."
            />
          ) : (
            <>
              {active.map((r) => (
                <LiveRunCard key={r.id} run={r} approvals={s.approvals} now={now} onOpen={() => onOpenRun(r.id)} />
              ))}
              {subs.map(({ a, lvl }) => (
                <SubCard key={a.subagent_id} sub={a} info={deleg.live.get(a.subagent_id)} lvl={lvl} now={now} onOpen={() => onOpenSub(a.subagent_id)} />
              ))}
            </>
          )}
        </Column>

        <Column
          kicker="precisa de você"
          title={needYou ? 'Sua vez' : 'Nada pendente'}
          count={needYou}
          tone="warn"
          hot={needYou > 0}
          aside={
            deleg.status?.paused ? (
              <span className="text-warn">
                spawns de subagents Hermes pausados ·{' '}
                <button
                  type="button"
                  className="underline decoration-dotted hover:text-ink"
                  onClick={() => deleg.setPaused(false).catch((e: unknown) => toast({ title: 'delegation.pause falhou', detail: errMsg(e), tone: 'error' }))}
                >
                  retomar
                </button>
              </span>
            ) : undefined
          }
        >
          {approvals.map((a) => (
            <SwarmApprovalCard key={a.id} approval={a} run={s.runs.find((r) => r.id === a.runId)} compact onSelectRun={onOpenRun} />
          ))}
          {failures.length > 0 && (
            <div className="mt-1">
              <div className="label mb-1.5 text-alert/80">falhas recentes · revise ou repita</div>
              <div className="flex flex-col gap-1.5">
                {failures.map((r) => (
                  <FinishedRow key={r.id} run={r} now={now} onOpen={() => onOpenRun(r.id)} onRetried={onOpenRun} />
                ))}
              </div>
            </div>
          )}
          {!needYou && !failures.length && (
            <EmptyState compact art="done" title="tudo decidido" detail="Aprovações e perguntas do Claude Code caem aqui — e respondem aqui mesmo." />
          )}
        </Column>

        <Column kicker="terminou" title="Entregue" count={recent.length} tone="cyanic">
          {!finished.length ? (
            <EmptyState compact title="nada terminou ainda" detail="Resultados, falhas e cancelamentos aparecem aqui com resumo e tokens." />
          ) : (
            finished.map((r) => <FinishedRow key={r.id} run={r} now={now} onOpen={() => onOpenRun(r.id)} onRetried={onOpenRun} />)
          )}
        </Column>
      </div>

      {/* ── diário de bordo ──────────────────────────────────────────────── */}
      <section className="relative px-6 pb-8">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="label">diário de bordo</span>
          <span className="text-[10px] text-faint">transições reais das runs · clique para abrir</span>
        </div>
        <LogFeed entries={log} onOpen={onOpenRun} />
      </section>
    </div>
  )
}

function Stat({ label, value, tone, format, hint }: { label: string; value: number | null; tone: string; format?: (n: number) => string; hint?: string }) {
  return (
    <div className="hc-card min-w-[92px] px-3 py-2" title={hint}>
      <dt className="font-mono text-[9px] uppercase tracking-[0.18em] text-faint">{label}</dt>
      <dd className={cx('mt-0.5 font-mono text-[22px] leading-none', tone)}>
        <CountUp value={value} format={format} />
      </dd>
    </div>
  )
}

/** Linha de pulso estilo ECG: corre enquanto há trabalho; âmbar se algo espera você. */
function Pulse({ state }: { state: 'you' | 'live' | 'idle' }) {
  const color = state === 'you' ? 'var(--color-amber)' : state === 'live' ? 'var(--color-phos)' : 'var(--color-edge2)'
  // batimento repetido: plano · pico · plano
  const beat = (x: number) => `L${x} 20 L${x + 6} 20 L${x + 9} 8 L${x + 13} 32 L${x + 16} 14 L${x + 19} 20`
  const d = `M0 20 ${[40, 140, 240, 340, 440, 540].map(beat).join(' ')} L600 20`
  return (
    <div className="relative mx-6 h-8 overflow-hidden" aria-hidden>
      <svg viewBox="0 0 600 40" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <line x1="0" y1="20" x2="600" y2="20" stroke="var(--color-edge)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      <svg viewBox="0 0 600 40" preserveAspectRatio="none" className="hc-ecg absolute inset-0 h-full w-full" data-live={state !== 'idle' || undefined}>
        <path
          d={state === 'idle' ? 'M0 20 L600 20' : d}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          style={{ filter: state === 'idle' ? undefined : `drop-shadow(0 0 4px ${color})`, transition: 'stroke var(--hc-dur-5) ease' }}
        />
      </svg>
    </div>
  )
}

/** saúde das duas fontes, sem derrubar a coluna */
function SourceLine({ s, deleg }: { s: SwarmState; deleg: HermesDelegation }) {
  const issue = swarmIssue(s)
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-faint">
      <span className={issue ? 'text-amber' : ''} title={issue ?? s.error ?? undefined}>
        <span className={cx('mr-1 inline-block h-1.5 w-1.5 rounded-full', issue ? 'bg-amber' : s.error ? 'bg-alert' : 'bg-phos')} />
        claude code{issue ? ` · ${issue}` : s.error ? ' · falha ao atualizar' : ''}
      </span>
      <span className={!deleg.online ? 'text-amber' : deleg.error ? 'text-alert' : ''} title={deleg.error ?? undefined}>
        <span className={cx('mr-1 inline-block h-1.5 w-1.5 rounded-full', !deleg.online ? 'bg-amber' : deleg.error ? 'bg-alert' : 'bg-phos')} />
        hermes{!deleg.online ? ' · gateway desconectado' : deleg.error ? ' · delegation.status falhou' : ''}
      </span>
    </span>
  )
}

function swarmIssue(s: SwarmState): string | null {
  if (s.phase === 'loading' && !s.updatedAt) return 'carregando'
  if (s.phase === 'unavailable') return s.error ?? 'indisponível'
  if (s.phase === 'error' && !s.updatedAt) return s.error ?? 'erro'
  if (s.status && !s.status.installed) return 'não instalado (npm run swarm:install)'
  return null
}

/** A frase do momento — personalidade com informação, nunca enfeite vazio. */
function headline(x: { inField: number; needYou: number; doneToday: number; lastFailed?: RunMeta; swarmDown: string | null }): {
  title: string
  sub: string
} {
  const field = x.inField === 1 ? 'um agente em campo' : `${x.inField} agentes em campo`
  if (x.needYou) {
    const what = x.needYou === 1 ? 'Uma decisão espera você.' : `${x.needYou} decisões esperam você.`
    return {
      title: what,
      sub: x.inField
        ? `Com ${field}. Quem está parado só volta a andar quando você aprovar ou responder — está tudo na coluna do meio.`
        : 'Responda na coluna do meio; a run retoma sozinha.',
    }
  }
  if (x.inField) {
    return {
      title: x.inField === 1 ? 'Um agente em campo.' : `${x.inField} agentes em campo.`,
      sub: 'Ninguém precisa de você agora. Acompanhe o último passo de cada um ou abra para ver o stream completo.',
    }
  }
  if (x.lastFailed) {
    return {
      title: 'Silêncio no rádio — mas algo caiu.',
      sub: `“${(x.lastFailed.title || x.lastFailed.task).slice(0, 70)}” falhou. Revise o motivo ou repita com um clique.`,
    }
  }
  if (x.doneToday) {
    return {
      title: x.doneToday === 1 ? 'Missão cumprida.' : `${x.doneToday} entregas nas últimas 24h.`,
      sub: 'Esquadrão em repouso. Revise os diffs em “Entregue” ou delegue a próxima.',
    }
  }
  if (x.swarmDown) return { title: 'Ponte silenciosa.', sub: `Swarm do Claude Code: ${x.swarmDown}. Subagents do Hermes seguem visíveis aqui.` }
  return { title: 'Ponte silenciosa.', sub: 'Nenhum agente em campo. Delegue uma tarefa e acompanhe daqui: criar → executar → decidir → entregar.' }
}
