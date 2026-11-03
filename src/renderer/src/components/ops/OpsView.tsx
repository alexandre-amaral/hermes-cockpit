import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { hasMain } from '../../lib/ipc'
import { fmtBytes, fmtUptime, ops, type SystemInfo } from '../../lib/ops'
import type { HermesRpc } from '../../lib/rpc'
import { StoragePanel } from '../storage/StoragePanel'
import { ContainersSection } from './ContainersSection'
import { ModelsSection } from './ModelsSection'
import { PortsSection } from './PortsSection'
import { ProcessesSection } from './ProcessesSection'
import { ReposSection } from './ReposSection'
import { SystemSection } from './SystemSection'
import { displayTone } from '../../lib/radial'
import { RadialMeter } from '../ui/RadialMeter'
import { useAsync, useLocal } from './ui'

// Central Ops (área central): sidebar de seções com contadores + conteúdo.
// Só a seção ativa fica montada (o polling dela para quando sai de vista);
// os contadores das demais vêm de uma leitura única ao abrir a view.
// CONTRATO: nome do export e props são fixos (App/registry já montam assim).

type SectionId = 'models' | 'ports' | 'procs' | 'repos' | 'containers' | 'storage' | 'system'

const ICON: Record<SectionId, ReactNode> = {
  models: <path d="M8 1.5 14 5v6l-6 3.5L2 11V5zM2 5l6 3.5L14 5M8 8.5v6" />,
  ports: <path d="M3 2.5h10v4H3zM3 9.5h10v4H3zM5.5 4.5h.01M5.5 11.5h.01" />,
  procs: <path d="M2 3h12v10H2zM2 6h12M5 9l1.5 1.5L5 12M8 12h3" />,
  repos: <path d="M5 2.5v8M5 10.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM11 5.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5zM11 5.5c0 3-6 2-6 5" />,
  containers: <path d="M2 6h12v7.5H2zM2 6l2-3.5h8L14 6M6 9h4" />,
  storage: <path d="M2.5 4c0-1 2.5-1.75 5.5-1.75S13.5 3 13.5 4v8c0 1-2.5 1.75-5.5 1.75S2.5 13 2.5 12zM2.5 4c0 1 2.5 1.75 5.5 1.75S13.5 5 13.5 4M2.5 8c0 1 2.5 1.75 5.5 1.75S13.5 9 13.5 8" />,
  system: <path d="M5.5 5.5h5v5h-5zM6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2" />,
}

const SECTIONS: { id: SectionId; label: string; hint: string }[] = [
  { id: 'models', label: 'Modelos', hint: 'Ollama, providers, bot × modelo' },
  { id: 'ports', label: 'Portas', hint: 'TCP em LISTEN' },
  { id: 'procs', label: 'Aplicações', hint: 'apps e processos' },
  { id: 'repos', label: 'Projetos', hint: 'repos git' },
  { id: 'containers', label: 'Containers', hint: 'Docker' },
  { id: 'storage', label: 'Armazenamento', hint: 'sessões e disco' },
  { id: 'system', label: 'Sistema', hint: 'CPU, RAM, volumes e GPU do host' },
]

const IDS = new Set<string>(SECTIONS.map((s) => s.id))

export function OpsView({ rpc }: { rpc: HermesRpc | null }) {
  const [stored, setStored] = useLocal<string>('hc.ops.section', 'models')
  const active: SectionId = IDS.has(stored) ? (stored as SectionId) : 'models'
  const [counts, setCounts] = useState<Partial<Record<SectionId, number | 'off'>>>({})

  const setCount = useCallback((id: SectionId, n: number | 'off') => {
    setCounts((prev) => (prev[id] === n ? prev : { ...prev, [id]: n }))
  }, [])
  const counters = {
    models: useCallback((n: number) => setCount('models', n), [setCount]),
    ports: useCallback((n: number) => setCount('ports', n), [setCount]),
    procs: useCallback((n: number) => setCount('procs', n), [setCount]),
    repos: useCallback((n: number) => setCount('repos', n), [setCount]),
    containers: useCallback((n: number) => setCount('containers', n), [setCount]),
    system: useCallback((n: number) => setCount('system', n), [setCount]),
  }

  // leitura única para os contadores das seções fora de vista
  useEffect(() => {
    if (!hasMain()) return
    void ops.models().then((m) => setCount('models', m.running ? m.models.length : 'off'), () => setCount('models', 'off'))
    void ops.ports().then((p) => setCount('ports', new Set(p.map((r) => `${r.pid}:${r.port}`)).size), () => {})
    void ops.containers().then((c) => setCount('containers', c.daemon ? c.containers.filter((x) => x.state === 'running').length : 'off'), () => {})
    void ops.repos().then((r) => setCount('repos', r.length), () => {})
    void ops.processes().then((p) => setCount('procs', p.length), () => {})
    void ops.system().then((s) => setCount('system', s.cpu.cores), () => setCount('system', 'off'))
  }, [setCount])

  if (!hasMain()) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[12px] text-faint">
        Central Ops precisa do app (main process) — indisponível no navegador.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 bg-void">
      <nav className="flex w-[188px] shrink-0 flex-col border-r border-edge bg-panel">
        <div className="px-3 pb-1 pt-3">
          <div className="label">Central Ops</div>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 py-1">
          {SECTIONS.map((s) => {
            const c = counts[s.id]
            const on = s.id === active
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setStored(s.id)}
                title={s.hint}
                aria-current={on ? 'page' : undefined}
                className={`group relative mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                  on ? 'bg-amber/10 text-ink' : 'text-dim hover:bg-hover hover:text-ink'
                }`}
              >
                {on && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-amber" />}
                <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 shrink-0 ${on ? 'text-amber' : 'text-faint group-hover:text-dim'}`} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                  {ICON[s.id]}
                </svg>
                <span className="min-w-0 flex-1 truncate text-[11.5px] uppercase tracking-[0.12em]">{s.label}</span>
                {c !== undefined && (
                  <span
                    className={`shrink-0 rounded px-1 text-[10px] tabular-nums ${
                      c === 'off' ? 'text-faint' : on ? 'text-amber' : 'text-faint'
                    }`}
                    title={c === 'off' ? 'fonte indisponível' : undefined}
                  >
                    {c === 'off' ? '—' : c}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <SystemCard onOpen={() => setStored('system')} active={active === 'system'} />
      </nav>
      <main key={active} className="hc-fade-in relative min-h-0 min-w-0 flex-1">
        {active === 'models' && <ModelsSection rpc={rpc} onCount={counters.models} />}
        {active === 'ports' && <PortsSection onCount={counters.ports} />}
        {active === 'procs' && <ProcessesSection onCount={counters.procs} />}
        {active === 'repos' && <ReposSection onCount={counters.repos} />}
        {active === 'containers' && <ContainersSection onCount={counters.containers} />}
        {active === 'storage' && (
          <div className="h-full min-h-0 overflow-auto">
            <StoragePanel rpc={rpc} />
          </div>
        )}
        {active === 'system' && <SystemSection onCount={counters.system} />}
      </main>
    </div>
  )
}

/**
 * Rodapé da rail: resumo do host (CPU, RAM, volume do sistema e GPU) em donuts
 * pequenos, sem texto embaixo — o detalhe fica no title de cada anel.
 * Multiplataforma — os números vêm de ops:system (src/main/metrics.ts) e o
 * rótulo é o hostname + SO, não "Mac". Clicar abre a seção Sistema.
 */
function SystemCard({ onOpen, active }: { onOpen: () => void; active: boolean }) {
  const s = useAsync<SystemInfo>(ops.system, [], 5_000)
  const d = s.data
  const disk = d ? (d.volumes.find((v) => v.id === d.primaryVolume) ?? d.volumes[0] ?? null) : null
  const gpu = d?.gpus.find((g) => g.pct != null) ?? d?.gpus[0] ?? null
  const gpuPct = gpu?.pct ?? d?.gpu3dPct ?? null
  return (
    <button
      type="button"
      onClick={onOpen}
      title={d ? [d.hostname, d.osVersion, d.osDetail].filter(Boolean).join(' · ') : 'detalhes do sistema'}
      className={`w-full border-t border-edge px-3 py-2.5 text-left text-[10.5px] transition-colors ${
        active ? 'bg-amber/5' : 'hover:bg-hover'
      }`}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="label">Sistema</span>
        {d && <span className="ml-auto truncate text-faint">up {fmtUptime(d.uptimeSec)}</span>}
      </div>
      {s.error && !d ? (
        <div className="text-alert" title={s.error}>
          indisponível
        </div>
      ) : !d ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="hc-shimmer h-3 rounded bg-panel2" />
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-1">
            <Dial label="cpu" pct={d.cpu.pct} title={`CPU ${d.cpu.pct.toFixed(0)}% · ${d.cpu.cores} núcleos · ${d.cpu.model}`} />
            <Dial label="mem" pct={d.mem.pct} title={`RAM ${fmtBytes(d.mem.used)} / ${fmtBytes(d.mem.total)}`} />
            {disk && (
              <Dial
                label={disk.id === '/' ? 'disco' : disk.id.toLowerCase()}
                pct={disk.pct}
                title={`${disk.id} · ${fmtBytes(disk.used)} / ${fmtBytes(disk.total)} · ${fmtBytes(disk.free)} livres`}
              />
            )}
            {gpu && (
              <Dial
                label="gpu"
                pct={gpuPct}
                title={[
                  gpu.name,
                  gpuPct == null ? 'uso indisponível' : `${gpuPct.toFixed(0)}%`,
                  gpu.vramTotal && gpu.vramUsed != null ? `vram ${fmtBytes(gpu.vramUsed)} / ${fmtBytes(gpu.vramTotal)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            )}
          </div>
          <div className="truncate pt-0.5 text-faint">{d.hostname}</div>
          <div className="truncate text-faint">
            {d.osVersion}
            {d.load ? ` · load ${d.load[0].toFixed(1)}` : ''}
          </div>
        </div>
      )}
    </button>
  )
}

/** Donut pequeno da rail: só o anel + a % dentro; o rótulo vai no caption. */
function Dial({ label, pct, title }: { label: string; pct: number | null; title: string }) {
  return (
    <RadialMeter
      value={pct}
      tone={displayTone(pct)}
      size={40}
      strokeWidth={3.5}
      aria={label}
      title={title}
      caption={label}
    />
  )
}
