import { useEffect, useState } from 'react'
import type { HermesRpc } from '../../lib/rpc'
import { fmtDuration, isActive, runElapsedMs, runHandle, useNow, useSwarm } from '../../lib/swarm'
import { RunDetail } from './RunDetail'
import { SwarmApprovalCard } from './SwarmApproval'
import { RunBar, StatusDot, SwarmGate } from './ui'

// Aba 'Swarm' do dock: lista compacta + stream da run selecionada + aprovações.
// CONTRATO: nome do export e props são fixos (App/registry já montam assim).
export function SwarmDockTab(props: { rpc: HermesRpc | null }) {
  void props.rpc
  const s = useSwarm()
  const [sel, setSel] = useState<string | null>(null)
  const anyActive = s.runs.some((r) => isActive(r.status))
  const now = useNow(1000, anyActive)

  useEffect(() => {
    if (!s.runs.length) return
    if (sel && s.runs.some((r) => r.id === sel)) return
    setSel((s.runs.find((r) => isActive(r.status)) ?? s.runs[0]).id)
  }, [s.runs, sel])

  const list = s.runs.slice(0, 12)
  const selected = s.runs.find((r) => r.id === sel) ?? null
  const orphanApprovals = s.approvals.filter((a) => a.runId !== sel)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SwarmGate s={s} compact>
        {orphanApprovals.length > 0 && (
          <div className="max-h-[35%] space-y-1.5 overflow-y-auto border-b border-edge px-3 py-2">
            {orphanApprovals.map((a) => (
              <SwarmApprovalCard
                key={a.id}
                approval={a}
                run={s.runs.find((r) => r.id === a.runId)}
                compact
                onSelectRun={setSel}
              />
            ))}
          </div>
        )}
        <ul className="max-h-[38%] shrink-0 overflow-y-auto border-b border-edge px-1.5 py-1.5">
          {!list.length ? (
            <li className="px-2 py-1 text-[11px] text-faint">nenhuma run</li>
          ) : (
            list.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSel(r.id)}
                  className={`grid w-full grid-cols-[auto_minmax(0,1fr)_4rem_auto] items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors ${
                    sel === r.id ? 'bg-panel2 text-ink' : 'text-dim hover:bg-hover/60'
                  }`}
                  title={r.task}
                >
                  <StatusDot status={r.status} />
                  <span className="truncate">
                    <span className="text-faint">{runHandle(r)}</span> {r.title && r.title !== runHandle(r) ? r.title : ''}
                  </span>
                  <RunBar status={r.status} />
                  <span className="tabular-nums text-[10px] text-faint">{fmtDuration(runElapsedMs(r, now))}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        {selected ? (
          <RunDetail key={selected.id} run={selected} approvals={s.approvals} compact onSelectRun={setSel} />
        ) : (
          <div className="p-3 text-[11px] text-faint">crie runs pela aba Swarm (área central) ou pelos bots</div>
        )}
      </SwarmGate>
    </div>
  )
}
