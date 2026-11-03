import { useEffect, useMemo, useState } from 'react'
import { errMsg, fmtBytes, ops, type ProcRow } from '../../lib/ops'
import { toast } from '../../lib/toast'
import { ConfirmBtn, EmptyState, ErrorState, SectionHeader, SkeletonRows, Tag, Th, useAsync } from './ui'

// Aplicações GUI abertas (System Events) + processos relevantes (node, python,
// hermes, claude, ollama, docker, dev servers) com CPU/memória.

const KIND_TONE: Record<string, 'amber' | 'phos' | 'cyanic' | 'neutral'> = {
  hermes: 'amber',
  claude: 'amber',
  ollama: 'phos',
  docker: 'cyanic',
  dev: 'phos',
  node: 'neutral',
  python: 'neutral',
}

type SortKey = 'cpu' | 'mem' | 'name' | 'pid'

export function ProcessesSection({ onCount }: { onCount?: (n: number) => void }) {
  const procs = useAsync(ops.processes, [], 5_000)
  const apps = useAsync(ops.apps, [], 20_000)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<string>('todos')
  const [sort, setSort] = useState<SortKey>('cpu')

  useEffect(() => {
    if (procs.data) onCount?.(procs.data.length)
  }, [procs.data, onCount])

  const kinds = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of procs.data ?? []) m.set(p.kind, (m.get(p.kind) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [procs.data])

  const f = q.trim().toLowerCase()
  const shown = useMemo(() => {
    const list = (procs.data ?? []).filter(
      (p) => (kind === 'todos' || p.kind === kind) && (!f || p.args.toLowerCase().includes(f) || String(p.pid).includes(f)),
    )
    const cmp: Record<SortKey, (a: ProcRow, b: ProcRow) => number> = {
      cpu: (a, b) => b.cpu - a.cpu,
      mem: (a, b) => b.rssKb - a.rssKb,
      name: (a, b) => a.name.localeCompare(b.name),
      pid: (a, b) => a.pid - b.pid,
    }
    return [...list].sort(cmp[sort])
  }, [procs.data, kind, f, sort])

  const totalCpu = shown.reduce((s, p) => s + p.cpu, 0)
  const totalMem = shown.reduce((s, p) => s + p.rssKb * 1024, 0)

  const kill = async (p: ProcRow, sig: 'SIGTERM' | 'SIGKILL') => {
    try {
      await ops.kill(p.pid, sig)
      toast({ title: `${sig} → ${p.name} (${p.pid})`, tone: 'ok' })
      setTimeout(() => void procs.reload(), 600)
    } catch (e) {
      toast({ title: `não matei ${p.pid}`, detail: errMsg(e), tone: 'error' })
    }
  }

  const quit = async (name: string) => {
    try {
      await ops.quitApp(name)
      toast({ title: `${name} fechado`, tone: 'ok' })
      setTimeout(() => void apps.reload(), 800)
    } catch (e) {
      toast({ title: `não fechei ${name}`, detail: errMsg(e), tone: 'error' })
    }
  }

  const appList = apps.data?.apps ?? []
  const shownApps = f ? appList.filter((a) => a.name.toLowerCase().includes(f)) : appList

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        title="Aplicações & processos"
        subtitle={procs.data ? `${shown.length} processos · ${totalCpu.toFixed(1)}% CPU · ${fmtBytes(totalMem)} RSS` : 'apps GUI + processos de dev/IA'}
        query={q}
        onQuery={setQ}
        placeholder="comando, pid, app…"
        loading={procs.loading || apps.loading}
        at={procs.at}
        onRefresh={() => {
          void procs.reload()
          void apps.reload()
        }}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {/* apps GUI */}
        <section className="border-b border-edge px-4 py-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="label">Aplicações abertas</span>
            <span className="text-[10px] text-faint">{appList.length || ''}</span>
          </div>
          {apps.initial ? (
            <div className="flex gap-1.5">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="hc-shimmer h-6 w-24 rounded bg-panel2" />
              ))}
            </div>
          ) : apps.error ? (
            <div className="text-[11px] text-alert">{apps.error}</div>
          ) : apps.data?.error ? (
            <div className="text-[11px] text-amber">{apps.data.error}</div>
          ) : !shownApps.length ? (
            <div className="text-[11px] text-faint">nenhuma</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {shownApps.map((a) => (
                <div key={`${a.name}:${a.pid ?? ''}`} className="hc-fade-in flex items-center gap-1 rounded border border-edge2 bg-panel2/50 py-0.5 pl-2 pr-0.5 text-[11px]">
                  <span className="text-ink">{a.name}</span>
                  {a.pid && <span className="text-[10px] tabular-nums text-faint">{a.pid}</span>}
                  {a.name === 'Hermes Cockpit' || a.name === 'Electron' || a.name === 'Finder' ? (
                    <span className="px-1 text-[10px] text-faint">—</span>
                  ) : (
                    <ConfirmBtn label="✕" confirmLabel="fechar?" title={`fechar ${a.name} (pede para o app sair)`} onConfirm={() => quit(a.name)} />
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* filtro por tipo */}
        <div className="flex flex-wrap items-center gap-1 px-4 pt-2.5">
          {[['todos', procs.data?.length ?? 0] as [string, number], ...kinds].map(([k, n]) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded border px-2 py-0.5 text-[10.5px] ${kind === k ? 'border-amber/60 bg-amber/10 text-amber' : 'border-edge2 text-dim hover:text-ink'}`}
            >
              {k} <span className="tabular-nums text-faint">{n}</span>
            </button>
          ))}
        </div>

        {procs.initial ? (
          <SkeletonRows rows={10} cols={6} />
        ) : procs.error && !procs.data ? (
          <ErrorState error={procs.error} onRetry={() => void procs.reload()} />
        ) : !shown.length ? (
          <EmptyState>nenhum processo relevante</EmptyState>
        ) : (
          <table className="mt-2 w-full border-collapse text-[11.5px]">
            <thead>
              <tr>
                <Th className="text-right" onClick={() => setSort('pid')} active={sort === 'pid'}>
                  pid
                </Th>
                <Th onClick={() => setSort('name')} active={sort === 'name'}>
                  processo
                </Th>
                <Th className="text-right" onClick={() => setSort('cpu')} active={sort === 'cpu'}>
                  cpu
                </Th>
                <Th className="text-right" onClick={() => setSort('mem')} active={sort === 'mem'}>
                  mem
                </Th>
                <Th className="text-right">tempo</Th>
                <Th>comando</Th>
                <Th className="text-right">ações</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.pid} className="border-b border-edge/60 hover:bg-hover/60">
                  <td className="px-2 py-1 text-right tabular-nums text-dim">{p.pid}</td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <Tag tone={KIND_TONE[p.kind] ?? 'neutral'}>{p.kind}</Tag>
                      <span className="truncate text-ink">{p.name}</span>
                      {p.own && (
                        <Tag tone="amber" title="processo do próprio cockpit — protegido">
                          cockpit
                        </Tag>
                      )}
                    </div>
                  </td>
                  <td className={`px-2 py-1 text-right tabular-nums ${p.cpu > 50 ? 'text-alert' : p.cpu > 10 ? 'text-amber' : 'text-dim'}`}>{p.cpu.toFixed(1)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-dim">{fmtBytes(p.rssKb * 1024)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-faint">{p.elapsed}</td>
                  <td className="max-w-[420px] truncate px-2 py-1 text-faint" title={p.args}>
                    {p.args}
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex justify-end gap-1">
                      {p.own ? (
                        <span className="text-[10px] text-faint">protegido</span>
                      ) : (
                        <>
                          <ConfirmBtn label="matar" confirmLabel={`SIGTERM?`} onConfirm={() => kill(p, 'SIGTERM')} />
                          <ConfirmBtn label="-9" confirmLabel="SIGKILL?" title="forçar (SIGKILL)" onConfirm={() => kill(p, 'SIGKILL')} />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
