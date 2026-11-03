import { useEffect, useMemo, useState } from 'react'
import { errMsg, ops, type PortRow } from '../../lib/ops'
import { toast } from '../../lib/toast'
import { IS_MAC } from '../../lib/platform'
import { Btn, ConfirmBtn, EmptyState, ErrorState, SectionHeader, SkeletonRows, Tag, Th, useAsync } from './ui'

// Portas TCP em LISTEN (lsof). Abrir no navegador, matar o processo dono
// (confirmação de 2 cliques; o main recusa pids do sistema e do próprio app).

const WELL_KNOWN: Record<number, string> = {
  3000: 'dev',
  5173: 'vite',
  5432: 'postgres',
  6379: 'redis',
  8000: 'http',
  8080: 'http',
  11434: 'ollama',
  27017: 'mongo',
  3306: 'mysql',
}

const isLocalAddr = (a: string) => a === '*' || a === '127.0.0.1' || a === '[::1]' || a === 'localhost' || a === '[::]' || a === '0.0.0.0'

export function PortsSection({ onCount }: { onCount?: (n: number) => void }) {
  const s = useAsync(ops.ports, [], 10_000)
  const [q, setQ] = useState('')
  const [hideSystem, setHideSystem] = useState(IS_MAC)

  // agrupa IPv4/IPv6 da mesma porta+pid numa linha
  const rows = useMemo(() => {
    const m = new Map<string, PortRow & { addrs: string[] }>()
    for (const r of s.data ?? []) {
      const k = `${r.pid}:${r.port}`
      const cur = m.get(k)
      if (cur) cur.addrs.push(r.address)
      else m.set(k, { ...r, addrs: [r.address] })
    }
    return [...m.values()]
  }, [s.data])

  useEffect(() => {
    if (s.data) onCount?.(rows.length)
  }, [s.data, rows.length, onCount])

  const f = q.trim().toLowerCase()
  const shown = rows.filter((r) => {
    if (hideSystem && /^(ControlCe|rapportd|sharingd|identitys|remoted|AirPlayXP)/.test(r.command)) return false
    if (!f) return true
    return String(r.port).includes(f) || r.command.toLowerCase().includes(f) || String(r.pid).includes(f) || r.addrs.some((a) => a.includes(f))
  })

  const kill = async (r: PortRow, sig: 'SIGTERM' | 'SIGKILL') => {
    try {
      await ops.kill(r.pid, sig)
      toast({ title: `${sig === 'SIGKILL' ? 'forcei' : 'sinalizei'} ${r.command} (${r.pid})`, detail: `porta ${r.port}`, tone: 'ok' })
      setTimeout(() => void s.reload(), 600)
    } catch (e) {
      toast({ title: `não matei ${r.pid}`, detail: errMsg(e), tone: 'error' })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        title="Portas"
        subtitle={s.data ? `${rows.length} em LISTEN · ${shown.length} visíveis` : 'TCP em LISTEN (lsof)'}
        query={q}
        onQuery={setQ}
        placeholder="porta, processo, pid…"
        loading={s.loading}
        at={s.at}
        onRefresh={() => void s.reload()}
      >
        {IS_MAC && (
          // O filtro conhece só nomes de daemon do macOS; fora dele não teria o que ocultar.
          <label className="flex cursor-pointer items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-faint">
            <input type="checkbox" checked={hideSystem} onChange={(e) => setHideSystem(e.target.checked)} className="accent-amber" />
            ocultar macOS
          </label>
        )}
      </SectionHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {s.initial ? (
          <SkeletonRows rows={8} cols={5} />
        ) : s.error && !s.data ? (
          <ErrorState error={s.error} onRetry={() => void s.reload()} />
        ) : !shown.length ? (
          <EmptyState>{f ? 'nada com esse filtro' : 'nenhuma porta em LISTEN'}</EmptyState>
        ) : (
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr>
                <Th className="w-20 text-right">porta</Th>
                <Th>processo</Th>
                <Th className="text-right">pid</Th>
                <Th>endereço</Th>
                <Th>usuário</Th>
                <Th className="text-right">ações</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const local = r.addrs.some(isLocalAddr)
                const exposed = r.addrs.some((a) => a === '*' || a === '[::]' || a === '0.0.0.0')
                return (
                  <tr key={`${r.pid}:${r.port}`} className="border-b border-edge/60 hover:bg-hover/60">
                    <td className="px-2 py-1 text-right tabular-nums text-amber">{r.port}</td>
                    <td className="px-2 py-1">
                      <span className="text-ink">{r.command}</span>
                      {WELL_KNOWN[r.port] && <span className="ml-1.5 text-[10px] text-faint">{WELL_KNOWN[r.port]}</span>}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-dim">{r.pid}</td>
                    <td className="px-2 py-1">
                      <div className="flex flex-wrap items-center gap-1">
                        {r.addrs.map((a) => (
                          <span key={a} className="text-dim">
                            {a}
                          </span>
                        ))}
                        {exposed && (
                          <Tag tone="warn" title="escutando em todas as interfaces (visível na rede)">
                            rede
                          </Tag>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-1 text-faint">{r.user ?? '—'}</td>
                    <td className="px-2 py-1">
                      <div className="flex justify-end gap-1">
                        {local && (
                          <Btn
                            onClick={() => void ops.open({ kind: 'url', url: `http://localhost:${r.port}` }).catch((e) => toast({ title: 'abrir falhou', detail: errMsg(e), tone: 'error' }))}
                            title={`http://localhost:${r.port}`}
                          >
                            ↗ abrir
                          </Btn>
                        )}
                        <ConfirmBtn label="matar" confirmLabel={`SIGTERM ${r.pid}?`} onConfirm={() => kill(r, 'SIGTERM')} />
                        <ConfirmBtn label="-9" confirmLabel="SIGKILL?" title="forçar (SIGKILL)" onConfirm={() => kill(r, 'SIGKILL')} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
