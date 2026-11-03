// Modelo de cota do renderer: espelho dos tipos de src/main/quota.ts (o
// renderer é empacotado à parte e não importa do main) + formatação pura.
// Tudo aqui é testável sem DOM — ver quota-model.test.ts.

export type QuotaWindowKind = '5h' | 'weekly' | 'weekly-model' | 'monthly' | 'other'

export interface QuotaWindow {
  kind: QuotaWindowKind
  label: string
  usedPct: number
  resetsAt: string | null
  active?: boolean
}

export interface ProviderQuota {
  provider: string
  label: string
  plan: string | null
  windows: QuotaWindow[]
  source: string
  asOf: string | null
  error: string | null
  note: string | null
}

export interface QuotaSnapshot {
  providers: ProviderQuota[]
  collectedAt: string
}

/** Tom pelos limiares do app: ≥90% alerta, ≥80% aviso, resto accent. */
export type QuotaTone = 'accent' | 'warn' | 'alert'

export function pctTone(pct: number | null | undefined): QuotaTone {
  if (pct == null || !Number.isFinite(pct)) return 'accent'
  if (pct >= 90) return 'alert'
  if (pct >= 80) return 'warn'
  return 'accent'
}

/** Token de tema da cor do tom (barras, textos de destaque). */
export const TONE_VAR: Record<QuotaTone, string> = {
  accent: 'var(--color-space)',
  warn: 'var(--color-warn)',
  alert: 'var(--color-alert)',
}

const KIND_RANK: Record<QuotaWindowKind, number> = { '5h': 0, weekly: 1, 'weekly-model': 2, monthly: 3, other: 4 }

/** Primeira janela de um tipo (as duas principais do widget: '5h' e 'weekly'). */
export function windowOf(p: ProviderQuota | null | undefined, kind: QuotaWindowKind): QuotaWindow | null {
  return p?.windows.find((w) => w.kind === kind) ?? null
}

/** Janelas que não são as duas principais (semanal por modelo, créditos…), já ordenadas. */
export function extraWindows(p: ProviderQuota | null | undefined): QuotaWindow[] {
  const main = new Set<QuotaWindowKind>(['5h', 'weekly'])
  const seen = { '5h': false, weekly: false } as Record<string, boolean>
  const out: QuotaWindow[] = []
  for (const w of p?.windows ?? []) {
    if (main.has(w.kind) && !seen[w.kind]) {
      seen[w.kind] = true
      continue
    }
    out.push(w)
  }
  return out.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.usedPct - a.usedPct)
}

/** Maior uso entre as janelas de um provedor (para o tom da aba), ou null. */
export function worstPct(p: ProviderQuota | null | undefined): number | null {
  const pcts = (p?.windows ?? []).map((w) => w.usedPct).filter((n) => Number.isFinite(n))
  return pcts.length ? Math.max(...pcts) : null
}

/** Maior uso do snapshot inteiro (strip/topbar), ou null se ninguém informou. */
export function snapshotWorstPct(providers: ProviderQuota[] | null | undefined): number | null {
  const pcts = (providers ?? []).map(worstPct).filter((n): n is number => n != null)
  return pcts.length ? Math.max(...pcts) : null
}

const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

/**
 * Contagem para o reset: `in` relativo ("2h 13m", "3d 4h", "agora") e `at`
 * absoluto ("hoje 18:30", "sex 09:00", "07/11 09:00"). null quando o provedor
 * não informou o reset.
 */
export function fmtResetParts(resetsAt: string | null | undefined, now = Date.now()): { in: string; at: string } | null {
  if (!resetsAt) return null
  const t = Date.parse(resetsAt)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const nd = new Date(now)
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(nd.getFullYear(), nd.getMonth(), nd.getDate()).getTime()) /
      86_400_000,
  )
  const at =
    dayDiff === 0
      ? `hoje ${hm}`
      : dayDiff === 1
        ? `amanhã ${hm}`
        : dayDiff > 1 && dayDiff < 7
          ? `${WD[d.getDay()]} ${hm}`
          : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`
  const mins = Math.floor((t - now) / 60_000)
  if (mins <= 0) return { in: 'agora', at }
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const inTxt = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${String(m).padStart(2, '0')}m` : `${m}m`
  return { in: inTxt, at }
}

/** "reinicia em 2h 13m · hoje 18:30" (para title/aria). */
export function fmtResetLong(resetsAt: string | null | undefined, now = Date.now()): string | null {
  const r = fmtResetParts(resetsAt, now)
  return r ? `reinicia em ${r.in} · ${r.at}` : null
}

// ─── Fonte legada: /api/plugins/cockpit/quota ────────────────────────────────

interface PluginJanela {
  nome?: string
  pct?: number
  reset?: string | number | null
}

interface PluginProvedor {
  nome?: string
  plano?: string
  janelas?: PluginJanela[]
  aviso?: string
}

/** Nome de janela do plugin → kind do modelo novo ('5 horas' → '5h'…). */
export function kindFromLabel(label: string): QuotaWindowKind {
  const s = label.toLowerCase()
  if (/\b5\s*h|sess[ãa]o|session/.test(s)) return '5h'
  if (/seman|week/.test(s)) return (/opus|sonnet|haiku|fable|modelo|model/.test(s) ? 'weekly-model' : 'weekly')
  if (/m[êe]s|month|cr[ée]dit/.test(s)) return 'monthly'
  return 'other'
}

function pluginReset(v: string | number | null | undefined): string | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') {
    const d = new Date(v < 1e12 ? v * 1000 : v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const d = new Date(/^\d{9,13}$/.test(v.trim()) ? Number(v) * (v.trim().length <= 10 ? 1000 : 1) : v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Provedores do plugin cockpit no mesmo formato do coletor do main. Mantém o
 * macOS (onde o plugin existe e traz provedores que o main não cobre) sem
 * duplicar quem o main já coletou.
 */
export function providersFromPlugin(provedores: PluginProvedor[] | undefined | null): ProviderQuota[] {
  return (provedores ?? []).map((p) => {
    const label = (p.nome ?? '').trim() || 'provedor'
    const windows = (p.janelas ?? [])
      .filter((j): j is PluginJanela & { pct: number } => typeof j.pct === 'number' && Number.isFinite(j.pct))
      .map((j) => {
        const name = (j.nome ?? '').trim() || 'janela'
        return { kind: kindFromLabel(name), label: name, usedPct: Math.max(0, j.pct), resetsAt: pluginReset(j.reset) }
      })
      .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.usedPct - a.usedPct)
    return {
      provider: `plugin:${label.toLowerCase()}`,
      label,
      plan: (p.plano ?? '').trim() || null,
      windows,
      source: 'plugin cockpit do Hermes',
      asOf: null,
      error: null,
      note: (p.aviso ?? '').trim() || (windows.length === 0 ? 'sem janela de limite informada' : null),
    }
  })
}

/** Id "lógico" de um provedor para dedupe entre as duas fontes. */
const dedupeKey = (p: ProviderQuota): string => p.label.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Une coletor do main (preferido: dado ao vivo) com o plugin cockpit, sem
 * repetir provedor. Ordem: quem tem janela primeiro, depois alfabética.
 */
export function mergeProviders(fromMain: ProviderQuota[], fromPlugin: ProviderQuota[]): ProviderQuota[] {
  const seen = new Set(fromMain.map(dedupeKey))
  const out = [...fromMain]
  for (const p of fromPlugin) if (!seen.has(dedupeKey(p))) out.push(p)
  return out.sort((a, b) => {
    const wa = a.windows.length > 0 ? 0 : 1
    const wb = b.windows.length > 0 ? 0 : 1
    return wa - wb || a.label.localeCompare(b.label, 'pt-BR')
  })
}
