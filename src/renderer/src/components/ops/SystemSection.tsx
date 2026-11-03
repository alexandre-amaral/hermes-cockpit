import { useEffect, type ReactNode } from 'react'
import { fmtBytes, fmtUptime, ops, type GpuInfo, type SystemInfo } from '../../lib/ops'
import { HOST_LABEL } from '../../lib/platform'
import { displayTone } from '../../lib/radial'
import { systemCards, vramPct } from '../../lib/system-cards'
import { RadialMeter, RadialStat } from '../ui/RadialMeter'
import { ErrorState, SectionHeader, SkeletonRows, Tag, useAsync } from './ui'

// Seção "Sistema" da Central Ops: CPU (modelo, núcleos, uso total e por
// núcleo), RAM, volumes e GPU — tudo de ops:system (src/main/metrics.ts), que
// é multiplataforma. Fonte parcial (ex.: uso de GPU indisponível no macOS)
// aparece como chip honesto, nunca como erro.
//
// Os cartões de uso são donuts (components/ui/RadialMeter.tsx) com a MESMA
// lista do widget de painel (lib/system-cards.ts), só maiores.

const REFRESH_MS = 4000

export function SystemSection({ onCount }: { onCount?: (n: number) => void }) {
  const s = useAsync<SystemInfo>(ops.system, [], REFRESH_MS)
  const d = s.data
  useEffect(() => {
    if (d) onCount?.(d.cpu.cores)
  }, [d, onCount])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        title="Sistema"
        subtitle={
          d ? (
            <span title={[d.hostname, d.osVersion, d.osDetail].filter(Boolean).join(' · ')}>
              {d.hostname} · {d.osVersion}
              {d.osDetail ? ` · ${d.osDetail}` : ''} · no ar há {fmtUptime(d.uptimeSec)}
            </span>
          ) : (
            'CPU, memória, volumes e GPU'
          )
        }
        loading={s.loading}
        onRefresh={() => void s.reload()}
        at={s.at}
      >
        {d?.load && (
          <Tag tone="neutral" title="load average de 1, 5 e 15 minutos">
            load {d.load.map((x) => x.toFixed(2)).join(' ')}
          </Tag>
        )}
      </SectionHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {s.error && !d ? (
          <ErrorState error={s.error} onRetry={() => void s.reload()} />
        ) : !d ? (
          <SkeletonRows rows={6} cols={2} />
        ) : (
          <div className="hc-fade-in space-y-3">
            <ResourcesCard info={d} />
            <CoresCard info={d} />
            <GpuCard info={d} />
          </div>
        )}
      </div>
    </div>
  )
}

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-md border border-edge bg-panel/60 p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="label !text-[10px] !text-dim">{title}</h3>
        <div className="ml-auto flex items-center gap-1.5">{right}</div>
      </div>
      {children}
    </section>
  )
}

/** CPU · RAM · GPU · volumes em donuts grandes (mesma ordem do widget). */
function ResourcesCard({ info }: { info: SystemInfo }) {
  const cards = systemCards(info)
  return (
    <Card
      title="Recursos"
      right={
        <>
          <Tag tone="neutral">{info.cpu.cores} núcleos</Tag>
          <Tag tone="neutral" title="de onde veio o 'usado' da memória">
            mem {info.mem.source}
          </Tag>
          <Tag tone="neutral">{info.volumes.length === 1 ? '1 volume' : `${info.volumes.length} volumes`}</Tag>
        </>
      }
    >
      {info.volumesError && <div className="mb-2 text-[10.5px] text-faint">lista parcial de volumes: {info.volumesError}</div>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-2">
        {cards.map((c) => (
          <RadialStat
            key={c.key}
            icon={c.icon}
            label={c.label}
            value={c.pct}
            tone={c.tone}
            detail={c.detail}
            sub={c.sub}
            title={c.title}
            size={86}
            strokeWidth={7}
            className="!px-2 !py-3"
          />
        ))}
      </div>
    </Card>
  )
}

/** Uso por núcleo em mini-donuts (mesma janela de amostragem do uso total). */
function CoresCard({ info }: { info: SystemInfo }) {
  const c = info.cpu
  if (c.perCore.length <= 1) return null
  return (
    <Card
      title="Núcleos"
      right={
        <>
          {c.sampleMs ? <Tag tone="neutral">amostra de {(c.sampleMs / 1000).toFixed(1)}s</Tag> : null}
          {c.speedMhz ? <Tag tone="neutral">{(c.speedMhz / 1000).toFixed(2)} GHz</Tag> : null}
        </>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(60px,1fr))] justify-items-center gap-2">
        {c.perCore.map((p, i) => (
          <RadialMeter
            key={i}
            value={p}
            tone={displayTone(p)}
            size={54}
            strokeWidth={4}
            aria={`núcleo ${i}`}
            title={`núcleo ${i} · ${p.toFixed(1)}%`}
            caption={`#${i}`}
          />
        ))}
      </div>
    </Card>
  )
}

function GpuCard({ info }: { info: SystemInfo }) {
  const gpus = info.gpus
  return (
    <Card title="GPU" right={gpus[0] ? <Tag tone="neutral">{gpus[0].source}</Tag> : null}>
      {gpus.length === 0 ? (
        <div className="text-[11.5px] text-faint">{info.gpuError ?? `nenhum adaptador detectado neste ${HOST_LABEL}`}</div>
      ) : (
        <div className="space-y-3">
          {gpus.map((g, i) => (
            <GpuRow key={`${g.name}-${i}`} gpu={g} sum={info.gpu3dPct} />
          ))}
          {info.gpuError && <div className="text-[10.5px] text-faint">{info.gpuError}</div>}
        </div>
      )}
    </Card>
  )
}

function GpuRow({ gpu, sum }: { gpu: GpuInfo; sum?: number }) {
  const vp = vramPct(gpu)
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-2">
        <RadialMeter
          value={gpu.pct ?? null}
          tone={displayTone(gpu.pct)}
          size={62}
          strokeWidth={5}
          aria={`uso da GPU ${gpu.name}`}
          title={gpu.pct == null ? 'uso desta GPU indisponível nesta plataforma' : `${gpu.pct.toFixed(1)}%`}
          caption="uso"
        />
        {vp != null && (
          <RadialMeter
            value={vp}
            tone={displayTone(vp)}
            size={62}
            strokeWidth={5}
            aria={`VRAM da GPU ${gpu.name}`}
            title={`${fmtBytes(gpu.vramUsed)} / ${fmtBytes(gpu.vramTotal)}`}
            caption="vram"
          />
        )}
        {/* Win32_VideoController não expõe LUID: com mais de um adaptador o 3D
            somado não é atribuível a um deles — por isso só aparece quando o
            próprio adaptador não informa uso. */}
        {gpu.pct == null && sum != null && (
          <RadialMeter
            value={sum}
            tone={displayTone(sum)}
            size={62}
            strokeWidth={5}
            aria="uso 3D somado de todos os adaptadores"
            title="soma dos engines 3D de todos os adaptadores (não é atribuível a um deles)"
            caption="3d total"
          />
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[11.5px] text-ink" title={`${gpu.name} · ${gpu.source}`}>
          {gpu.name}
        </div>
        <div className="text-[10.5px] text-faint">
          {gpu.pct == null ? 'uso indisponível' : `${gpu.pct.toFixed(0)}% em uso`}
          {vp != null
            ? ` · vram ${fmtBytes(gpu.vramUsed)} / ${fmtBytes(gpu.vramTotal)}`
            : gpu.vramTotal
              ? ` · vram ${fmtBytes(gpu.vramTotal)} (uso não informado)`
              : ''}
        </div>
      </div>
    </div>
  )
}
