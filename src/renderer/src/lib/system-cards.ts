import { fmtBytes } from './fmt.ts'
import type { SystemInfo } from './ops.ts'
import { displayTone, type MeterTone } from './radial.ts'

// Modelo dos cartões de recurso do host (CPU · RAM · GPU · volumes). Puro, sem
// React: o widget de painel (panels/widgets.tsx), a Ops › Sistema e o rodapé da
// rail consomem a MESMA lista, só com tamanhos diferentes de donut.
//
// Atenção ao detalhe dos volumes: é USADO / TOTAL (o que a % mede), com o
// livre na linha secundária — mostrar "livre / total" ao lado de 97% seria
// mentir sobre o que o anel representa.

export type SystemCardIcon = 'cpu' | 'ram' | 'disk' | 'gpu'

export interface SystemCard {
  key: string
  icon: SystemCardIcon
  /** rótulo curto do topo do cartão (pode truncar) */
  label: string
  /** 0–100, ou null quando a plataforma não expõe o uso */
  pct: number | null
  tone: MeterTone
  /** linha principal embaixo do anel */
  detail: string
  /** linha secundária (menor) */
  sub?: string
  /** tooltip completo (title) */
  title: string
}

/** Volumes do host com o volume de sistema na frente; resto na ordem da coleta. */
export function orderedVolumes(d: SystemInfo): SystemInfo['volumes'] {
  return [...d.volumes].sort((a, b) => Number(b.id === d.primaryVolume) - Number(a.id === d.primaryVolume))
}

/** Rótulo curto de um volume ("C: sistema", "D: INTEL", "E: Reservado…"). */
export function volumeLabel(v: SystemInfo['volumes'][number], primary?: string): string {
  if (v.id === primary) return `${v.id} sistema`
  return v.label ? `${v.id} ${v.label}` : v.id
}

/** GPU "principal": a primeira que reporta uso; se nenhuma reporta, a primeira. */
export function mainGpu(d: SystemInfo): SystemInfo['gpus'][number] | null {
  return d.gpus.find((g) => g.pct != null) ?? d.gpus[0] ?? null
}

/** % de VRAM usada da GPU, quando usado e total são conhecidos. */
export function vramPct(g: SystemInfo['gpus'][number] | null | undefined): number | null {
  return g?.vramTotal && g.vramUsed != null ? (g.vramUsed / g.vramTotal) * 100 : null
}

/** Cartões na ordem CPU → RAM → GPU → volumes (sistema primeiro). */
export function systemCards(d: SystemInfo): SystemCard[] {
  const cards: SystemCard[] = []

  const ghz = d.cpu.speedMhz ? ` @ ${(d.cpu.speedMhz / 1000).toFixed(2)} GHz` : ''
  cards.push({
    key: 'cpu',
    icon: 'cpu',
    label: 'CPU',
    pct: d.cpu.pct,
    tone: displayTone(d.cpu.pct),
    detail: d.cpu.model,
    sub: `${d.cpu.cores} núcleos${ghz}`,
    title: `CPU ${Math.round(d.cpu.pct)}% · ${d.cpu.model} · ${d.cpu.cores} núcleos${ghz}`,
  })

  cards.push({
    key: 'ram',
    icon: 'ram',
    label: 'RAM',
    pct: d.mem.pct,
    tone: displayTone(d.mem.pct),
    detail: `${fmtBytes(d.mem.used)} / ${fmtBytes(d.mem.total)}`,
    sub: `${fmtBytes(d.mem.free)} livres`,
    title: `RAM ${Math.round(d.mem.pct)}% · ${fmtBytes(d.mem.used)} em uso de ${fmtBytes(d.mem.total)} · ${fmtBytes(
      d.mem.free,
    )} livres · fonte ${d.mem.source}`,
  })

  const g = mainGpu(d)
  if (g) {
    // sem % própria: cai no 3D somado de todos os adaptadores; sem nenhum dos
    // dois o anel fica vazio e o tom vira "informativo" (accent), não verde.
    const pct = g.pct ?? d.gpu3dPct ?? null
    const vp = vramPct(g)
    const vram = vp != null ? `vram ${fmtBytes(g.vramUsed)} / ${fmtBytes(g.vramTotal)}` : g.vramTotal ? `vram ${fmtBytes(g.vramTotal)}` : undefined
    cards.push({
      key: 'gpu',
      icon: 'gpu',
      label: 'GPU',
      pct,
      tone: displayTone(pct),
      detail: g.name,
      sub: vram,
      title: [
        g.name,
        pct == null ? 'uso indisponível' : `${Math.round(pct)}%${g.pct == null ? ' (soma dos engines)' : ''}`,
        vram,
        g.source,
      ]
        .filter(Boolean)
        .join(' · '),
    })
  }

  for (const v of orderedVolumes(d)) {
    cards.push({
      key: `vol:${v.id}`,
      icon: 'disk',
      label: volumeLabel(v, d.primaryVolume),
      pct: v.pct,
      tone: displayTone(v.pct),
      detail: `${fmtBytes(v.used)} / ${fmtBytes(v.total)}`,
      sub: `${fmtBytes(v.free)} livres`,
      title: `${[v.id, v.label, v.fs].filter(Boolean).join(' · ')} · ${Math.round(v.pct)}% · ${fmtBytes(v.used)} usados de ${fmtBytes(
        v.total,
      )} · ${fmtBytes(v.free)} livres`,
    })
  }

  return cards
}
