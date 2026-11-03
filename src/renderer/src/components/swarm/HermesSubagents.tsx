import { useEffect, useRef, useState } from 'react'
import { SUB_TERMINAL, epochMs, subLabel, subTone, type ActiveSub, type HermesDelegation } from '../../lib/delegation'
import type { HermesRpc } from '../../lib/rpc'
import { errMsg, fmtDuration, useNow } from '../../lib/swarm'
import { toast } from '../../lib/toast'
import { useViewActive } from '../layout/views'
import { EmptyState } from '../ui'
import { Btn, ConfirmButton, SkeletonRows } from './ui'

// Aba "Subagents Hermes": árvore viva + transcript/steer/interrupt do subagent
// selecionado. O estado (delegation.status + eventos subagent.*) vem de
// lib/delegation (dono: SwarmView), compartilhado com a masterview.

interface TreeEntry {
  path: string
  session_id?: string | null
  started_at?: number | null
  finished_at?: number | null
  label?: string
  count?: number
}

export function HermesSubagents({
  rpc,
  deleg,
  sel,
  onSelect,
}: {
  rpc: HermesRpc | null
  deleg: HermesDelegation
  sel: string | null
  onSelect: (id: string | null) => void
}) {
  const { status: st, error: err, loading, live, tree } = deleg
  const now = useNow(1000, Boolean(st?.active.length))
  const selected = st?.active.find((a) => a.subagent_id === sel) ?? null

  if (!rpc || !deleg.online) {
    return (
      <EmptyState
        tone="warn"
        art="offline"
        title="subagents hermes · gateway desconectado"
        detail="A árvore de delegação aparece quando o WebSocket do hermes serve estiver aberto. Nada a fazer aqui — reconecta sozinho."
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[360px] shrink-0 flex-col border-r border-edge bg-panel/30">
        <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
          <span className="label">delegação ao vivo</span>
          {st && (
            <span className="text-[10px] text-faint">
              prof. máx {st.max_spawn_depth} · {st.max_concurrent_children} simultâneos
            </span>
          )}
          {st && (
            <Btn
              className="ml-auto"
              tone={st.paused ? 'primary' : 'default'}
              title="bloqueia/libera NOVOS spawns (os ativos continuam)"
              onClick={async () => {
                try {
                  await deleg.setPaused(!st.paused)
                } catch (e) {
                  toast({ title: 'delegation.pause falhou', detail: errMsg(e), tone: 'error' })
                }
              }}
            >
              {st.paused ? 'spawns pausados · retomar' : 'pausar spawns'}
            </Btn>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {loading && !st ? (
            <SkeletonRows n={3} className="px-2" />
          ) : err && !st ? (
            <EmptyState compact tone="error" title="delegation.status falhou" detail={err} />
          ) : !tree.length ? (
            <EmptyState
              compact
              title="nenhum subagent em campo"
              detail="Quando um bot usar delegate_tool, cada subagent aparece aqui com o último passo ao vivo."
            />
          ) : (
            <div className="hc-stagger">
              {tree.map(({ a, lvl }) => {
                const info = live.get(a.subagent_id)
                const status = info?.status ?? a.status ?? 'running'
                const start = epochMs(a.started_at)
                const on = sel === a.subagent_id
                return (
                  <button
                    key={a.subagent_id}
                    type="button"
                    onClick={() => onSelect(a.subagent_id)}
                    style={{ paddingLeft: 8 + lvl * 14 }}
                    data-active={on || undefined}
                    className={`hc-rail-item hc-press mb-0.5 flex w-full min-w-0 flex-col rounded py-1.5 pr-2 text-left ${
                      on ? 'bg-panel2' : 'hover:bg-hover/60'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {lvl > 0 && <span className="text-faint">└</span>}
                      <span
                        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${subTone(status)} ${
                          SUB_TERMINAL.has(status) ? '' : 'hc-pulse-dot'
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">{a.goal || info?.goal || a.subagent_id}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-faint">{start ? fmtDuration(now - start) : ''}</span>
                    </span>
                    <span className="ml-3.5 flex min-w-0 gap-2 text-[10px] text-faint">
                      <span>{subLabel(status)}</span>
                      {a.model && <span className="truncate">{a.model}</span>}
                      {a.tool_count != null && <span>{a.tool_count} tools</span>}
                      {(info?.lastTool ?? a.last_tool) && <span className="truncate text-cyanic/80">→ {info?.lastTool ?? a.last_tool}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {err && st && <div className="px-2 pt-2 text-[10.5px] text-alert">última atualização falhou: {err}</div>}
        </div>
        <SpawnTrees rpc={rpc} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <SubagentDetail
            key={selected.subagent_id}
            rpc={rpc}
            sub={selected}
            sessionId={live.get(selected.subagent_id)?.sessionId ?? selected.owner_agent_session_id ?? null}
            lastText={live.get(selected.subagent_id)?.lastText}
          />
        ) : (
          <EmptyState
            title={tree.length ? 'escolha um subagent' : 'nada delegado agora'}
            detail={
              tree.length
                ? 'Selecione à esquerda para ver o transcript ao vivo, direcionar (steer) ou interromper.'
                : 'Quando um bot delegar, a árvore aparece à esquerda. Histórico de árvores salvas fica no rodapé.'
            }
          />
        )}
      </div>
    </div>
  )
}

function SubagentDetail({
  rpc,
  sub,
  sessionId,
  lastText,
}: {
  rpc: HermesRpc
  sub: ActiveSub
  sessionId: string | null
  lastText?: string
}) {
  const [tail, setTail] = useState<{ text: string; available: boolean; truncated: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [steer, setSteer] = useState('')
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLPreElement>(null)
  const viewActive = useViewActive()

  useEffect(() => {
    if (!sessionId || !viewActive) return
    let cancel = false
    const pull = async () => {
      try {
        const r = await rpc.call<{ text?: string; available?: boolean; truncated?: boolean }>('subagent.tail', {
          session_id: sessionId,
          subagent_id: sub.subagent_id,
        })
        if (cancel) return
        setTail({ text: r?.text ?? '', available: Boolean(r?.available), truncated: Boolean(r?.truncated) })
        setErr(null)
      } catch (e) {
        if (!cancel) setErr(errMsg(e))
      }
    }
    void pull()
    const iv = setInterval(() => void pull(), 2000)
    return () => {
      cancel = true
      clearInterval(iv)
    }
  }, [rpc, sessionId, sub.subagent_id, viewActive])

  useEffect(() => {
    const el = box.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight
  }, [tail?.text])

  const noOwner = !sessionId
  const doSteer = async () => {
    const text = steer.trim()
    if (!text || !sessionId) return
    setBusy(true)
    try {
      const r = await rpc.call<{ status: string }>('subagent.steer', { session_id: sessionId, subagent_id: sub.subagent_id, text })
      toast({
        title: r?.status === 'queued' ? 'Direcionamento enfileirado' : `Direcionamento ${r?.status ?? 'enviado'}`,
        detail: r?.status === 'queued' ? 'entregue no próximo lote de ferramentas' : undefined,
        tone: r?.status === 'rejected' ? 'warn' : 'ok',
      })
      if (r?.status !== 'rejected') setSteer('')
    } catch (e) {
      toast({ title: 'steer falhou', detail: errMsg(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hc-fade-in flex min-h-0 flex-1 flex-col">
      <div className="border-b border-edge px-5 py-3">
        <div className="text-[12.5px] text-ink">{sub.goal || sub.subagent_id}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[10.5px] text-faint">
          <span>{sub.subagent_id}</span>
          {sub.model && <span>{sub.model}</span>}
          {sub.depth != null && <span>profundidade {sub.depth}</span>}
          {sessionId && <span title="sessão dona">sessão {sessionId.slice(0, 10)}</span>}
        </div>
      </div>
      <pre
        ref={box}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-3 text-[11.5px] leading-relaxed text-ink/85"
      >
        {noOwner
          ? 'sessão dona desconhecida — o transcript fica disponível depois do primeiro evento subagent.* recebido por este cockpit (subagents de sessões abertas em outro cliente não são controláveis daqui).'
          : err
            ? `subagent.tail: ${err}`
            : !tail
              ? 'carregando…'
              : tail.available
                ? `${tail.truncated ? '… (últimos 16KB)\n' : ''}${tail.text}`
                : lastText || 'sem transcript ao vivo ainda'}
      </pre>
      <div className="flex items-center gap-2 border-t border-edge px-5 py-2.5">
        <input
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void doSteer()}
          disabled={noOwner || busy}
          placeholder={noOwner ? 'steer indisponível (sessão dona desconhecida)' : 'direcionar o subagent (steer)…'}
          className="min-w-0 flex-1 rounded border border-edge2 bg-void px-2 py-1.5 text-[11.5px] text-ink outline-none placeholder:text-faint focus:border-amber/60 disabled:opacity-50"
        />
        <Btn onClick={() => void doSteer()} disabled={noOwner || busy || !steer.trim()}>
          enviar
        </Btn>
        <ConfirmButton
          label="interromper"
          confirmLabel="interromper mesmo?"
          disabled={noOwner}
          onConfirm={async () => {
            try {
              const r = await rpc.call<{ found: boolean }>('subagent.interrupt', {
                session_id: sessionId,
                subagent_id: sub.subagent_id,
              })
              toast({ title: r?.found ? 'Subagent interrompido' : 'Subagent já tinha terminado', tone: r?.found ? 'ok' : 'info' })
            } catch (e) {
              toast({ title: 'interrupt falhou', detail: errMsg(e), tone: 'error' })
            }
          }}
        />
      </div>
    </div>
  )
}

function SpawnTrees({ rpc }: { rpc: HermesRpc }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<TreeEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ path: string; subs: Record<string, unknown>[] } | null>(null)

  useEffect(() => {
    if (!open) return
    let cancel = false
    rpc.call<{ entries: TreeEntry[] }>('spawn_tree.list', { cross_session: true, limit: 25 }).then(
      (r) => !cancel && setRows(Array.isArray(r?.entries) ? r.entries : []),
      (e) => !cancel && setErr(errMsg(e)),
    )
    return () => {
      cancel = true
    }
  }, [open, rpc])

  return (
    <div className="border-t border-edge">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="label flex w-full items-center gap-2 px-4 py-2 text-left hover:text-dim"
      >
        {open ? '▾' : '▸'} histórico de árvores
      </button>
      {open && (
        <div className="hc-fade-in max-h-64 overflow-y-auto px-2 pb-2">
          {err ? (
            <div className="px-2 text-[11px] text-alert">{err}</div>
          ) : !rows ? (
            <SkeletonRows n={2} className="px-2" />
          ) : !rows.length ? (
            <div className="px-2 text-[11px] text-faint">nenhum snapshot salvo</div>
          ) : (
            rows.map((r) => (
              <div key={r.path}>
                <button
                  type="button"
                  onClick={async () => {
                    if (detail?.path === r.path) return setDetail(null)
                    try {
                      const d = await rpc.call<{ subagents?: Record<string, unknown>[] }>('spawn_tree.load', { path: r.path })
                      setDetail({ path: r.path, subs: Array.isArray(d?.subagents) ? d.subagents : [] })
                    } catch (e) {
                      toast({ title: 'spawn_tree.load falhou', detail: errMsg(e), tone: 'error' })
                    }
                  }}
                  className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-[11px] text-dim hover:bg-hover/60 hover:text-ink"
                >
                  <span className="min-w-0 flex-1 truncate">{r.label || r.path.split('/').pop()}</span>
                  <span className="shrink-0 text-[10px] text-faint">{r.count ?? 0}</span>
                  <span className="shrink-0 text-[10px] text-faint">
                    {r.started_at ? new Date(epochMs(r.started_at) ?? 0).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''}
                  </span>
                </button>
                {detail?.path === r.path && (
                  <ul className="hc-fade-in mb-1 ml-4 border-l border-edge pl-2">
                    {detail.subs.length ? (
                      detail.subs.map((s, i) => (
                        <li key={i} className="py-0.5 text-[10.5px] text-faint">
                          <span className="text-dim">{String(s.goal ?? s.subagent_id ?? `#${i + 1}`).slice(0, 120)}</span>
                          {s.status != null && <span> · {String(s.status)}</span>}
                        </li>
                      ))
                    ) : (
                      <li className="text-[10.5px] text-faint">snapshot vazio</li>
                    )}
                  </ul>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
