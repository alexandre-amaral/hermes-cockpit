// Geometria e cores dos medidores de uso (barra `Meter` e donut `RadialMeter`).
// Puro: sem DOM e sem React, para ser testável em node:test — ver radial.test.ts.
//
// Regra de cor (vale para donut, rótulo, barra e pontinho do StatusCenter):
//   <80%  verde  (phos)  — uso normal
//   ≥80%  laranja (warn) — atenção
//   ≥90%  vermelho (alert) — crítico
//   sem semântica de uso → accent do tema (amber)

export type MeterTone = 'amber' | 'phos' | 'cyanic' | 'alert' | 'warn'

/** Limiares da regra de cor; exportados para o teste e para quem precisar comparar. */
export const USAGE_WARN_PCT = 80
export const USAGE_ALERT_PCT = 90

/**
 * Tom "informativo": métrica sem semântica de uso (GPU sem % disponível, VRAM
 * só informativa, contagem de núcleos). É o accent do tema.
 */
export const INFO_TONE: MeterTone = 'amber'

/** Tom de uso: ≥90% alerta, ≥80% aviso, resto fósforo (tokens do tema). */
export const usageTone = (pct: number): MeterTone =>
  !Number.isFinite(pct) ? INFO_TONE : pct >= USAGE_ALERT_PCT ? 'alert' : pct >= USAGE_WARN_PCT ? 'warn' : 'phos'

/** Tom de uso aceitando ausência de dado (null → informativo, anel vazio). */
export const usageToneOf = (pct: number | null | undefined): MeterTone =>
  typeof pct === 'number' && Number.isFinite(pct) ? usageTone(pct) : INFO_TONE

/**
 * Tom coerente com a % ARREDONDADA que o anel mostra. Sem isso 89.6% aparece
 * como "90%" pintado de laranja — o número diz crítico e a cor diz atenção.
 */
export const displayTone = (pct: number | null | undefined): MeterTone =>
  typeof pct === 'number' && Number.isFinite(pct) ? usageTone(Math.round(pct)) : INFO_TONE

const TONE_VARS: Record<MeterTone, string> = {
  amber: 'var(--color-amber)',
  phos: 'var(--color-phos)',
  cyanic: 'var(--color-cyanic)',
  alert: 'var(--color-alert)',
  warn: 'var(--color-warn)',
}

/** Cor CSS (token do tema) de um tom — usada no stroke do SVG. */
export const toneColor = (tone: MeterTone): string => TONE_VARS[tone]

/** A partir deste valor o anel é tratado como cheio (fecha sem gap/ponta estranha). */
export const RADIAL_FULL_PCT = 99.5

export interface RadialGeom {
  /** raio do círculo do arco (centro do traço) */
  r: number
  /** circunferência = comprimento total do traço */
  circumference: number
  /** stroke-dasharray do arco e do trilho */
  dasharray: number
  /** stroke-dashoffset do arco: circunferência (0%) → 0 (100%) */
  dashoffset: number
  /** valor já normalizado (0–100) ou null quando indisponível */
  pct: number | null
  /** false em 0% e em null — não desenhar o arco (evita o pontinho do cap) */
  showArc: boolean
  /** ponta arredondada, menos no anel cheio (onde "round" faria um calombo) */
  linecap: 'round' | 'butt'
}

/**
 * Geometria do donut. O arco é um <circle> girado −90° (começa às 12h, segue
 * horário): dasharray = circunferência, dashoffset anima de C (vazio) a 0 (cheio).
 */
export function radialGeometry(value: number | null | undefined, size: number, strokeWidth: number): RadialGeom {
  const r = Math.max(0, (size - strokeWidth) / 2)
  const circumference = 2 * Math.PI * r
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
  const pct = raw == null ? null : raw >= RADIAL_FULL_PCT ? 100 : raw
  const frac = pct == null ? 0 : pct / 100
  return {
    r,
    circumference,
    dasharray: circumference,
    dashoffset: circumference * (1 - frac),
    pct,
    showArc: pct != null && pct > 0,
    linecap: pct === 100 ? 'butt' : 'round',
  }
}

/** Texto central do donut: % inteira ou travessão quando não há dado. */
export const radialLabel = (pct: number | null): string => (pct == null ? '—' : `${Math.round(pct)}%`)
