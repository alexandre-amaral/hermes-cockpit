import { useEffect, useRef, useState } from 'react'
import { errMsg, ops, type ContainerAction, type ContainerRow } from '../../lib/ops'
import { toast } from '../../lib/toast'
import { Btn, ConfirmBtn, EmptyState, ErrorState, SectionHeader, SkeletonRows, Tag, Th, useAsync } from './ui'

// Containers Docker: status, start/stop/restart, remover (2 cliques), logs.
// Daemon parado → estado vazio honesto com a mensagem do CLI.

const stateTone = (s: string): 'phos' | 'amber' | 'alert' | 'neutral' =>
  s === 'running' ? 'phos' : s === 'paused' || s === 'restarting' ? 'amber' : s === 'dead' ? 'alert' : 'neutral'

export function ContainersSection({ onCount }: { onCount?: (n: number) => void }) {
  const s = useAsync(ops.containers, [], 10_000)
  const [q, setQ] = useState('')
  const [logs, setLogs] = useState<{ c: ContainerRow; text: string | null; error?: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const list = s.data?.daemon ? s.data.containers : []
  useEffect(() => {
    if (s.data) onCount?.(s.data.daemon ? s.data.containers.filter((c) => c.state === 'running').length : 0)
  }, [s.data, onCount])

  const act = async (c: ContainerRow, action: ContainerAction) => {
    if (action === 'logs') {
      setLogs({ c, text: null })
      try {
        const text = (await ops.container('logs', c.id)) ?? ''
        setLogs({ c, text: String(text) })
      } catch (e) {
        setLogs({ c, text: null, error: errMsg(e) })
      }
      return
    }
    setBusy(c.id)
    try {
      await ops.container(action, c.id)
      toast({ title: `docker ${action} ${c.name}`, tone: 'ok' })
      void s.reload()
    } catch (e) {
      toast({ title: `docker ${action} falhou`, detail: errMsg(e), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const f = q.trim().toLowerCase()
  const shown = f ? list.filter((c) => c.name.toLowerCase().includes(f) || c.image.toLowerCase().includes(f) || c.id.startsWith(f)) : list

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        title="Containers"
        subtitle={
          s.data?.daemon
            ? `${list.length} containers · ${list.filter((c) => c.state === 'running').length} rodando`
            : s.data
              ? 'Docker indisponível'
              : 'docker ps -a'
        }
        query={q}
        onQuery={setQ}
        placeholder="nome, imagem, id…"
        loading={s.loading}
        at={s.at}
        onRefresh={() => void s.reload()}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          {s.initial ? (
            <SkeletonRows rows={5} cols={5} />
          ) : s.error ? (
            <ErrorState error={s.error} onRetry={() => void s.reload()} />
          ) : s.data && !s.data.daemon ? (
            <div className="hc-fade-in mx-auto mt-10 max-w-md rounded-lg border border-edge bg-panel px-5 py-4 text-center">
              <div className="label mb-2">{s.data.installed ? 'daemon parado' : 'docker ausente'}</div>
              <div className="text-[12px] text-dim">{s.data.error}</div>
              <div className="mt-2 text-[11px] text-faint">
                {s.data.installed ? 'Inicie o Docker Desktop (ou `colima start`) e atualize.' : 'Instale o Docker Desktop ou colima.'}
              </div>
              <Btn className="mt-3" onClick={() => void s.reload()}>
                ↻ verificar de novo
              </Btn>
            </div>
          ) : !shown.length ? (
            <EmptyState>{f ? 'nada com esse filtro' : 'nenhum container'}</EmptyState>
          ) : (
            <table className="w-full border-collapse text-[11.5px]">
              <thead>
                <tr>
                  <Th>nome</Th>
                  <Th>imagem</Th>
                  <Th>estado</Th>
                  <Th>portas</Th>
                  <Th className="text-right">ações</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const running = c.state === 'running'
                  const b = busy === c.id
                  return (
                    <tr key={c.id} className="border-b border-edge/60 hover:bg-hover/60">
                      <td className="px-2 py-1">
                        <div className="text-ink">{c.name}</div>
                        <div className="text-[10px] text-faint">{c.id.slice(0, 12)}</div>
                      </td>
                      <td className="max-w-[240px] truncate px-2 py-1 text-dim" title={c.image}>
                        {c.image}
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1.5">
                          <Tag tone={stateTone(c.state)}>{c.state}</Tag>
                          <span className="truncate text-[10.5px] text-faint">{c.status}</span>
                        </div>
                      </td>
                      <td className="max-w-[220px] truncate px-2 py-1 text-faint" title={c.ports}>
                        {c.ports || '—'}
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex justify-end gap-1">
                          {running ? (
                            <>
                              <Btn disabled={b} onClick={() => void act(c, 'restart')}>
                                reiniciar
                              </Btn>
                              <ConfirmBtn label="parar" confirmLabel="parar?" disabled={b} onConfirm={() => act(c, 'stop')} />
                            </>
                          ) : (
                            <Btn tone="phos" disabled={b} onClick={() => void act(c, 'start')}>
                              iniciar
                            </Btn>
                          )}
                          <Btn onClick={() => void act(c, 'logs')}>logs</Btn>
                          {!running && <ConfirmBtn label="remover" confirmLabel="docker rm?" disabled={b} onConfirm={() => act(c, 'rm')} />}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        {logs && <LogsPane name={logs.c.name} text={logs.text} error={logs.error} onReload={() => void act(logs.c, 'logs')} onClose={() => setLogs(null)} />}
      </div>
    </div>
  )
}

function LogsPane({ name, text, error, onReload, onClose }: { name: string; text: string | null; error?: string; onReload: () => void; onClose: () => void }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  return (
    <div className="hc-rise flex h-[42%] min-h-[160px] shrink-0 flex-col border-t border-edge bg-void">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-1">
        <span className="label">logs · {name}</span>
        <span className="text-[10px] text-faint">últimas 400 linhas</span>
        <Btn className="ml-auto" onClick={onReload}>
          ↻
        </Btn>
        <button type="button" onClick={onClose} className="text-faint hover:text-ink" aria-label="fechar">
          ✕
        </button>
      </div>
      {error ? (
        <div className="px-3 py-2 text-[11px] text-alert">{error}</div>
      ) : text === null ? (
        <SkeletonRows rows={5} cols={1} />
      ) : (
        <pre ref={ref} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[11px] leading-snug text-dim">
          {text || '(sem saída)'}
        </pre>
      )}
    </div>
  )
}
