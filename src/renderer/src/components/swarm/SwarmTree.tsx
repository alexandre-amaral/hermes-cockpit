import { memo, useEffect, useMemo, useRef } from 'react'
import { botTitle } from '../../lib/bots'
import {
  STATUS_LABEL,
  STATUS_TONE,
  errMsg,
  fmtDuration,
  isActive,
  repoName,
  runElapsedMs,
  swarmApi,
  useNow,
  useRunEvents,
  type Approval,
  type RunMeta,
} from '../../lib/swarm'
import { fmtRunTokens } from '../../lib/swarm-tokens'
import { toast } from '../../lib/toast'
import { buildItems } from './RunStream'
import { ConfirmButton, StatusDot } from './ui'
import { SwarmApprovalCard } from './SwarmApproval'
import { invoke } from '../../lib/ipc'
import { requestTerminal } from '../devtools/TerminalTab'
import { useViewActive } from '../layout/views'

// Árvore ao vivo da delegação: Hermes → bot que pediu → grupo (multi-tarefa)
// → instâncias do Claude Code (continuações aninhadas sob a run-mãe). Cada nó
// é um "terminal" com o log ao vivo; conectores animados enquanto há trabalho.
// Botões abrem a instância num terminal de verdade do sistema (assistir / retomar).

const MAX_FINISHED = 12

interface Lane {
  key: string
  label: string
  groups: { key: string; runs: RunMeta[] }[]
  active: boolean
}

function buildLanes(runs: RunMeta[]): Lane[] {
  const active = runs.filter((r) => isActive(r.status))
  const finished = runs.filter((r) => !isActive(r.status)).slice(0, MAX_FINISHED)
  const shown = [...active, ...finished]
  const byLane = new Map<string, Lane>()
  for (const r of shown) {
    const who = r.requestedBy?.profile || (r.requestedBy?.via === 'mcp' ? 'hermes' : 'cockpit')
    const lane = byLane.get(who) ?? { key: who, label: who === 'cockpit' ? 'Cockpit (manual)' : botTitle(who), groups: [], active: false }
    const gkey = r.groupId || r.parentRunId || r.id
    let g = lane.groups.find((x) => x.key === gkey || x.runs.some((y) => y.id === r.parentRunId))
    if (!g) {
      g = { key: gkey, runs: [] }
      lane.groups.push(g)
    }
    g.runs.push(r)
    lane.active ||= isActive(r.status)
    byLane.set(who, lane)
  }
  for (const l of byLane.values()) for (const g of l.groups) g.runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return [...byLane.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label))
}

export function SwarmTree({
  runs,
  approvals,
  onOpen,
}: {
  runs: RunMeta[]
  approvals: Approval[]
  onOpen: (runId: string) => void
}) {
  const lanes = useMemo(() => buildLanes(runs), [runs])
  const anyActive = lanes.some((l) => l.active)
  const pendingBy = useMemo(() => {
    const m = new Map<string, Approval[]>()
    for (const a of approvals) m.set(a.runId, [...(m.get(a.runId) ?? []), a])
    return m
  }, [approvals])

  if (!lanes.length) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-[12px] text-faint">
        nenhuma instância ainda — peça a um bot (claude_spawn) ou use “Delegar tarefa”.
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-5">
      {/* raiz */}
      <div className="flex justify-center">
        <div
          className={`hc-rise flex items-center gap-2 rounded-full border px-4 py-1.5 text-[12px] font-semibold tracking-[0.18em] ${
            anyActive ? 'border-amber/70 text-amber shadow-[0_0_24px_-6px_var(--color-amber)]' : 'border-edge2 text-dim'
          }`}
        >
          <span className={`h-2 w-2 rotate-45 ${anyActive ? 'hc-pulse-dot bg-amber' : 'bg-faint'}`} />
          HERMES · ORQUESTRADOR
        </div>
      </div>
      <div className={`mx-auto h-5 w-px ${anyActive ? 'hc-flow-y' : 'bg-edge2'}`} />

      {/* faixas por bot */}
      <div className="flex min-w-max gap-5">
        {lanes.map((lane, li) => (
          <div key={lane.key} className="hc-rise relative w-[440px] shrink-0" style={{ animationDelay: `${li * 60}ms` }}>
            {/* barramento horizontal + descida */}
            <div className={`absolute -top-px left-0 right-0 h-px ${lane.active ? 'hc-flow-x' : 'bg-edge2'}`} />
            <div className={`mx-auto h-4 w-px ${lane.active ? 'hc-flow-y' : 'bg-edge2'}`} />
            <div className="mb-3 flex items-center justify-center gap-2">
              <span className={`rounded-md border px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] ${lane.active ? 'border-phos/50 text-phos' : 'border-edge2 text-dim'}`}>
                {lane.label}
              </span>
              <span className="text-[10px] text-faint">
                {lane.groups.reduce((n, g) => n + g.runs.length, 0)} instância(s)
              </span>
            </div>
            <div className="space-y-4 border-l border-edge2/70 pl-4">
              {lane.groups.map((g) => (
                <div key={g.key} className="relative">
                  {g.runs.length > 1 && (
                    <div className="label mb-1.5 text-[9.5px]">
                      {g.runs[0]?.groupId ? `grupo · ${g.runs.length} tarefas paralelas` : 'conversa continuada'}
                    </div>
                  )}
                  <div className="space-y-3">
                    {g.runs.map((r) => (
                      <div key={r.id} className={`relative ${r.parentRunId ? 'ml-6' : ''}`}>
                        <span className={`absolute -left-4 top-5 h-px w-4 ${isActive(r.status) ? 'hc-flow-x' : 'bg-edge2'}`} />
                        <RunNode run={r} pendingList={pendingBy.get(r.id) ?? []} onOpen={() => onOpen(r.id)} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const RunNode = memo(function RunNode({ run, pendingList, onOpen }: { run: RunMeta; pendingList: Approval[]; onOpen: () => void }) {
  const pending = pendingList.length
  const asks = pendingList.some((a) => a.toolName === 'AskUserQuestion')
  const active = isActive(run.status)
  const now = useNow(1000, active)
  const viewActive = useViewActive()
  const ev = useRunEvents(run.id, active && viewActive)
  const lines = useMemo(() => termLines(buildItems(ev.lines)), [ev.lines])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  const tone = STATUS_TONE[run.status]
  const open = (mode: 'watch' | 'resume') =>
    swarmApi.openTerminal(run.id, mode).catch((e: unknown) => toast({ title: 'Terminal não abriu', detail: errMsg(e), tone: 'error' }))

  return (
    <div
      className={`group overflow-hidden rounded-lg border bg-panel transition-shadow ${
        pending
          ? 'border-dashed border-amber/80 shadow-[0_0_22px_-8px_var(--color-amber)]'
          : active
            ? 'border-phos/40 shadow-[0_0_22px_-10px_var(--color-phos)]'
            : 'border-edge2'
      }`}
    >
      {/* barra de título estilo janela de terminal */}
      <div className="flex items-center gap-2 border-b border-edge bg-panel2 px-2.5 py-1.5">
        <span className="flex gap-1" aria-hidden>
          <span className="h-2 w-2 rounded-full bg-alert/70" />
          <span className="h-2 w-2 rounded-full bg-amber/70" />
          <span className="h-2 w-2 rounded-full bg-phos/70" />
        </span>
        <StatusDot status={run.status} />
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-[11.5px] text-ink hover:text-amber" title={run.task}>
          {run.title}
        </button>
        <span key={`${run.status}-${pending}`} className={`hc-pop shrink-0 text-[10px] ${pending ? 'text-warn' : tone.text}`}>
          {pending ? (asks ? 'pergunta pra você' : pending > 1 ? `${pending} aprovações · você` : 'aprovação · você') : STATUS_LABEL[run.status]}
        </span>
      </div>

      {/* terminal ao vivo */}
      <div ref={box} className="h-40 overflow-y-auto bg-void px-2.5 py-1.5 font-mono text-[10.5px] leading-[1.45]">
        {lines.length === 0 && <div className="text-faint">{ev.loading ? 'carregando…' : active ? 'iniciando claude…' : 'sem eventos'}</div>}
        {lines.map((l, i) => (
          <div key={i} className={`hc-fade-in truncate ${l.cls}`} title={l.text}>
            {l.text}
          </div>
        ))}
        {active && <span className="inline-block h-3 w-1.5 animate-pulse bg-phos align-middle" />}
      </div>

      {/* perguntas / aprovações pendentes desta instância, respondidas aqui mesmo */}
      {pendingList.length > 0 && (
        <div className="space-y-2 border-t border-edge bg-panel2/40 p-2">
          {pendingList.map((a) => (
            <SwarmApprovalCard key={a.id} approval={a} run={run} compact />
          ))}
        </div>
      )}

      {/* rodapé */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-edge px-2.5 py-1.5 text-[10px] text-faint">
        <span title={run.repo}>{repoName(run.repo)}</span>
        {run.branch && <span className="text-dim">⎇ {run.branch.replace('hermes/', '')}</span>}
        {run.model && <span>{run.model}</span>}
        {run.permissionMode && run.permissionMode !== 'manual' && (
          <span className={run.permissionMode === 'bypass' ? 'text-alert' : 'text-phos'}>{run.permissionMode}</span>
        )}
        <span className="tabular-nums">{fmtDuration(runElapsedMs(run, now))}</span>
        {run.tokensTotal != null && <span>{fmtRunTokens(run.tokensTotal)}</span>}
        <span className="ml-auto flex gap-1 opacity-70 transition-opacity group-hover:opacity-100">
          <MiniBtn onClick={() => openHere(run, active ? 'watch' : 'resume')} title={active ? 'seguir ao vivo no terminal do app (dock)' : 'claude --resume interativo no terminal do app (dock)'}>
            ▣ abrir aqui
          </MiniBtn>
          <MiniBtn onClick={() => void open('watch')} title="abrir num terminal de verdade do sistema seguindo ao vivo">
            ⧉ assistir
          </MiniBtn>
          {!active && run.claudeSessionId && (
            <MiniBtn onClick={() => void open('resume')} title="claude --resume interativo no worktree">
              ↻ retomar
            </MiniBtn>
          )}
          {active && (
            <ConfirmButton
              label="cancelar"
              confirmLabel="cancelar?"
              onConfirm={async () => {
                try {
                  await swarmApi.cancel(run.id)
                } catch (e) {
                  toast({ title: 'Falha ao cancelar', detail: errMsg(e), tone: 'error' })
                }
              }}
            />
          )}
          <MiniBtn onClick={onOpen} title="detalhes, diff e aprovações">
            detalhes
          </MiniBtn>
        </span>
      </div>
    </div>
  )
})

function MiniBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title} className="rounded border border-edge2 px-1.5 py-px text-[10px] text-dim hover:border-amber/60 hover:text-amber">
      {children}
    </button>
  )
}

type Item = ReturnType<typeof buildItems>[number]

/** Itens do stream → linhas de terminal (últimas 60). */
function termLines(items: Item[]): { text: string; cls: string }[] {
  const out: { text: string; cls: string }[] = []
  for (const it of items) {
    if (it.k === 'init') out.push({ text: `── init · ${it.model ?? '?'}`, cls: 'text-faint' })
    else if (it.k === 'text') for (const l of it.text.split('\n').filter(Boolean)) out.push({ text: l, cls: 'text-ink' })
    else if (it.k === 'thinking') out.push({ text: `∴ ${it.text.replace(/\s+/g, ' ')}`, cls: 'text-faint italic' })
    else if (it.k === 'tool') {
      out.push({ text: `→ ${it.name} ${shortInput(it.input)}`, cls: 'text-cyanic' })
      if (it.result) {
        const first = it.result.text.split('\n').find(Boolean)
        if (first) out.push({ text: `  │ ${first}`, cls: it.result.isError ? 'text-alert' : 'text-faint' })
      }
    } else if (it.k === 'task') {
      const meta = [it.tools != null ? `${it.tools} tools` : '', it.tokens != null ? `${Math.round(it.tokens / 1000)}k tok` : '', it.durationMs != null ? fmtDuration(it.durationMs) : '']
        .filter(Boolean)
        .join(' · ')
      out.push({ text: `${it.done ? '✓' : '⟳'} ${it.text}${meta ? `  [${meta}]` : ''}`, cls: it.done ? 'text-phos' : 'text-amber' })
    } else if (it.k === 'result')
      out.push({ text: `■ ${it.ok ? 'concluída' : it.subtype ?? 'erro'} · ${it.turns ?? '?'} turnos${it.tokens != null ? ` · ${fmtRunTokens(it.tokens)}` : ''}`, cls: it.ok ? 'text-phos' : 'text-alert' })
  }
  return out.slice(-60)
}

function shortInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 120) : ''
}

/** Abre a instância dentro do app: aba Terminal do dock, num shell com o comando da run. */
function openHere(run: RunMeta, mode: 'watch' | 'resume') {
  invoke<{ cwd: string; cmd: string; title: string }>('swarm:terminalCommand', run.id, mode)
    .then((t) => requestTerminal(t))
    .catch((e: unknown) => toast({ title: 'Não abriu no app', detail: errMsg(e), tone: 'error' }))
}
