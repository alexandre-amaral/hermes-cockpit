import { execFile } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IS_MAC, resolveHermesHome } from './platform.ts'

// Cota dos provedores de IA, coletada PELO MAIN PROCESS.
//
// Por que aqui e não no plugin `cockpit` do Hermes: o plugin só existe na
// máquina onde foi instalado à mão (`<hermes>/plugins/cockpit`); num host sem
// ele, `/api/plugins/cockpit/quota` responde 404 {"detail":"Plugin not found"}
// e TODO o widget cai. As janelas de uso que interessam (Claude Code OAuth,
// Codex/ChatGPT) são locais da máquina, então coletar no main é mais direto —
// e os segredos ficam onde devem.
//
// SEGREDOS: o access token do Claude Code / Codex é lido do disco, usado no
// header Authorization e descartado. Nunca é devolvido ao renderer, nunca é
// logado, nem em mensagem de erro (ver `scrub()`).

export type QuotaWindowKind = '5h' | 'weekly' | 'weekly-model' | 'monthly' | 'other'

export interface QuotaWindow {
  /** '5h' = janela curta (sessão); 'weekly' = janela semanal principal */
  kind: QuotaWindowKind
  /** rótulo curto para a UI ('5 horas', 'semanal', 'semanal · Opus') */
  label: string
  /** uso em % (0–100+; alguns provedores passam de 100) */
  usedPct: number
  /** ISO 8601 do reset, ou null quando o provedor não informa */
  resetsAt: string | null
  /** o provedor marcou esta janela como a que está limitando agora */
  active?: boolean
}

export interface ProviderQuota {
  /** id estável: 'claude', 'codex', 'huggingface', … */
  provider: string
  label: string
  plan: string | null
  windows: QuotaWindow[]
  /** de onde o número veio (mostrado como "fonte" no painel) */
  source: string
  /** ISO do instante a que os números se referem (snapshot local pode ser antigo) */
  asOf: string | null
  /** erro SÓ deste provedor — os outros continuam aparecendo */
  error: string | null
  /** observação honesta (ex.: configurado, mas sem API de cota) */
  note: string | null
}

export interface QuotaSnapshot {
  providers: ProviderQuota[]
  collectedAt: string
}

const KIND_RANK: Record<QuotaWindowKind, number> = { '5h': 0, weekly: 1, 'weekly-model': 2, monthly: 3, other: 4 }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** Epoch (s ou ms) / ISO → ISO 8601; null quando não dá para interpretar. */
function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v < 1e12 ? v * 1000 : v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const s = str(v)
  if (!s) return null
  const d = new Date(/^\d{9,13}$/.test(s) ? Number(s) * (s.length <= 10 ? 1000 : 1) : s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function sortWindows(ws: QuotaWindow[]): QuotaWindow[] {
  return ws.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.usedPct - a.usedPct)
}

/** Mensagem de erro sem segredo: tokens longos (sk-…, JWT, Bearer) viram '***'. */
export function scrub(msg: string): string {
  return msg
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}/g, '***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*/g, '***')
    .replace(/\bBearer\s+\S+/gi, 'Bearer ***')
}

const errMsg = (e: unknown, max = 160): string => scrub(e instanceof Error ? e.message : String(e)).slice(0, max)

// ─── Normalizadores (puros — testados em quota.test.ts) ──────────────────────

/** Rótulo do escopo de uma janela `weekly_scoped` do Anthropic. */
function anthropicScopeLabel(scope: unknown): string {
  const s = obj(scope)
  const model = str(obj(s?.model)?.display_name) ?? str(obj(s?.model)?.id)
  const surface = str(obj(s?.surface)?.display_name) ?? str(s?.surface)
  return model ?? surface ?? 'escopo'
}

const ANTHROPIC_FALLBACK: Array<[string, QuotaWindowKind, string]> = [
  ['five_hour', '5h', '5 horas'],
  ['seven_day', 'weekly', 'semanal'],
  ['seven_day_opus', 'weekly-model', 'semanal · Opus'],
  ['seven_day_sonnet', 'weekly-model', 'semanal · Sonnet'],
  ['seven_day_cowork', 'weekly-model', 'semanal · Cowork'],
  ['seven_day_oauth_apps', 'weekly-model', 'semanal · apps OAuth'],
]

/**
 * `GET https://api.anthropic.com/api/oauth/usage` → `{provider, windows}`.
 * Prefere o array `limits` (formato atual: kind/group/percent/resets_at) e cai
 * para os campos nomeados (`five_hour`, `seven_day`, …) quando ele não vem.
 * `extra_usage` só entra quando os créditos extras estão habilitados.
 */
export function normalizeAnthropicUsage(
  raw: unknown,
  opts: { plan?: string | null; asOf?: string | null } = {},
): Pick<ProviderQuota, 'provider' | 'label' | 'plan' | 'windows' | 'asOf'> {
  const r = obj(raw) ?? {}
  const windows: QuotaWindow[] = []
  const limits = Array.isArray(r.limits) ? r.limits : []
  for (const item of limits) {
    const l = obj(item)
    if (!l) continue
    const pct = num(l.percent) ?? num(l.utilization)
    if (pct == null) continue
    const kindRaw = str(l.kind) ?? ''
    const group = str(l.group) ?? ''
    let kind: QuotaWindowKind
    let label: string
    if (kindRaw === 'session' || group === 'session') {
      kind = '5h'
      label = '5 horas'
    } else if (kindRaw === 'weekly_scoped') {
      kind = 'weekly-model'
      label = `semanal · ${anthropicScopeLabel(l.scope)}`
    } else if (kindRaw === 'weekly_all' || group === 'weekly') {
      kind = 'weekly'
      label = 'semanal'
    } else {
      kind = 'other'
      label = kindRaw || group || 'janela'
    }
    windows.push({ kind, label, usedPct: Math.max(0, pct), resetsAt: toIso(l.resets_at), active: l.is_active === true })
  }
  if (windows.length === 0) {
    for (const [key, kind, label] of ANTHROPIC_FALLBACK) {
      const w = obj(r[key])
      const pct = num(w?.utilization)
      if (pct == null) continue
      windows.push({ kind, label, usedPct: Math.max(0, pct), resetsAt: toIso(w?.resets_at) })
    }
  }
  const extra = obj(r.extra_usage)
  if (extra?.is_enabled === true) {
    const pct = num(extra.utilization)
    if (pct != null) windows.push({ kind: 'monthly', label: 'créditos extras', usedPct: Math.max(0, pct), resetsAt: null })
  }
  return { provider: 'claude', label: 'Claude', plan: opts.plan ?? null, windows: sortWindows(windows), asOf: opts.asOf ?? null }
}

/** `window_minutes` → (kind, rótulo). 300 → '5 horas'; 10080 → 'semanal'. */
function minutesToKind(minutes: number | null, fallback: string): { kind: QuotaWindowKind; label: string } {
  if (minutes == null) return { kind: 'other', label: fallback }
  if (minutes >= 10080) return { kind: 'weekly', label: minutes === 10080 ? 'semanal' : `${Math.round(minutes / 1440)} dias` }
  if (minutes >= 1440) return { kind: 'other', label: `${Math.round(minutes / 1440)} dias` }
  if (minutes % 60 === 0) return { kind: '5h', label: `${minutes / 60} horas` }
  return { kind: '5h', label: `${minutes} min` }
}

/**
 * `rate_limits` do Codex CLI (evento `token_count` do rollout, ou resposta
 * equivalente) → `{provider, windows}`. `primary` é a janela curta e
 * `secondary` a semanal; o reset vem como epoch (`resets_at`) ou relativo
 * (`resets_in_seconds`, ancorado em `asOf`).
 */
export function normalizeCodexRateLimits(
  raw: unknown,
  opts: { asOf?: string | null } = {},
): Pick<ProviderQuota, 'provider' | 'label' | 'plan' | 'windows' | 'asOf'> {
  const r = obj(raw) ?? {}
  const anchor = opts.asOf ? Date.parse(opts.asOf) : Number.NaN
  const base = Number.isNaN(anchor) ? Date.now() : anchor
  const windows: QuotaWindow[] = []
  const slots: Array<[string, string]> = [
    ['primary', '5 horas'],
    ['secondary', 'semanal'],
  ]
  for (const [key, fallback] of slots) {
    const w = obj(r[key])
    const pct = num(w?.used_percent) ?? num(w?.usedPercent)
    if (w == null || pct == null) continue
    const minutes = num(w.window_minutes) ?? num(w.windowMinutes)
    const { kind, label } = minutesToKind(minutes, fallback)
    const inSec = num(w.resets_in_seconds) ?? num(w.resetsInSeconds)
    const resetsAt = toIso(w.resets_at ?? w.resetsAt) ?? (inSec != null ? new Date(base + inSec * 1000).toISOString() : null)
    windows.push({ kind, label, usedPct: Math.max(0, pct), resetsAt })
  }
  const plan = str(r.plan_type) ?? str(r.planType)
  return {
    provider: 'codex',
    label: 'Codex',
    plan: plan ? plan.replace(/^\w/, (c) => c.toUpperCase()) : null,
    windows: sortWindows(windows),
    asOf: opts.asOf ?? null,
  }
}

// ─── Claude Code (OAuth do plano Max/Pro) ────────────────────────────────────

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const HTTP_TIMEOUT_MS = 8_000

interface ClaudeCreds {
  accessToken: string
  expiresAt: number | null
  subscriptionType: string | null
  rateLimitTier: string | null
}

function parseClaudeCreds(text: string): ClaudeCreds | null {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  const o = obj(obj(j)?.claudeAiOauth) ?? obj(j)
  const token = str(o?.accessToken)
  if (!token) return null
  return {
    accessToken: token,
    expiresAt: num(o?.expiresAt),
    subscriptionType: str(o?.subscriptionType),
    rateLimitTier: str(o?.rateLimitTier),
  }
}

/** Keychain do macOS (onde o Claude Code guarda as credenciais quando não há arquivo). */
function keychainCreds(): Promise<ClaudeCreds | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 4_000 },
      (err, stdout) => resolve(err ? null : parseClaudeCreds(stdout)),
    )
  })
}

/** Credenciais do Claude Code: env → `$CLAUDE_CONFIG_DIR/.credentials.json` → Keychain (macOS). */
async function readClaudeCreds(): Promise<ClaudeCreds | null> {
  const envTok = str(process.env.CLAUDE_CODE_OAUTH_TOKEN)
  if (envTok) return { accessToken: envTok, expiresAt: null, subscriptionType: null, rateLimitTier: null }
  const dir = str(process.env.CLAUDE_CONFIG_DIR) ?? join(homedir(), '.claude')
  const file = join(dir, '.credentials.json')
  if (existsSync(file)) {
    try {
      const creds = parseClaudeCreds(readFileSync(file, 'utf8'))
      if (creds) return creds
    } catch {
      /* arquivo ilegível: cai para o Keychain */
    }
  }
  return IS_MAC ? keychainCreds() : null
}

/** 'max' + 'default_claude_max_5x' → 'Max 5x'. */
function claudePlan(c: ClaudeCreds): string | null {
  if (!c.subscriptionType) return null
  const name = c.subscriptionType.replace(/^\w/, (ch) => ch.toUpperCase())
  const mult = c.rateLimitTier?.match(/(\d+)x/)?.[1]
  return mult ? `${name} ${mult}x` : name
}

const CLAUDE_SOURCE = 'Claude Code OAuth · api.anthropic.com'

async function collectClaude(): Promise<ProviderQuota | null> {
  const creds = await readClaudeCreds()
  // Sem credencial = provedor não configurado nesta máquina: não inventa aba.
  if (!creds) return null
  const base: ProviderQuota = {
    provider: 'claude',
    label: 'Claude',
    plan: claudePlan(creds),
    windows: [],
    source: CLAUDE_SOURCE,
    asOf: null,
    error: null,
    note: null,
  }
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) {
      return { ...base, error: 'token do Claude Code expirado — rode `claude` para renovar' }
    }
    if (!res.ok) return { ...base, error: `uso do Claude: HTTP ${res.status}` }
    const raw = (await res.json()) as unknown
    const norm = normalizeAnthropicUsage(raw, { plan: base.plan, asOf: new Date().toISOString() })
    return {
      ...base,
      ...norm,
      source: CLAUDE_SOURCE,
      error: null,
      note: norm.windows.length === 0 ? 'a conta não expõe janelas de uso' : null,
    }
  } catch (e) {
    const expired = creds.expiresAt != null && creds.expiresAt < Date.now()
    return {
      ...base,
      error: expired ? 'token do Claude Code expirado — rode `claude` para renovar' : errMsg(e),
    }
  }
}

// ─── Codex / ChatGPT ─────────────────────────────────────────────────────────
//
// O backend do ChatGPT não expõe cota por API para o token do Codex (responde
// 403 do Cloudflare). A fonte honesta é o snapshot que o próprio Codex CLI
// grava nos rollouts da sessão (evento `token_count` → `rate_limits`), por isso
// o painel mostra "desde <hora>".

const CODEX_TAIL_BYTES = 512 * 1024
const CODEX_MAX_FILES = 12

function codexHome(): string {
  return str(process.env.CODEX_HOME) ?? join(homedir(), '.codex')
}

function listDirDesc(dir: string): string[] {
  try {
    return readdirSync(dir).sort().reverse()
  } catch {
    return []
  }
}

/** Rollouts mais recentes de `<codex>/sessions/AAAA/MM/DD/` (o nome ordena por data). */
export function latestCodexRollouts(sessionsDir: string, max = CODEX_MAX_FILES): string[] {
  const out: string[] = []
  for (const y of listDirDesc(sessionsDir)) {
    for (const m of listDirDesc(join(sessionsDir, y))) {
      for (const d of listDirDesc(join(sessionsDir, y, m))) {
        const dir = join(sessionsDir, y, m, d)
        for (const f of listDirDesc(dir)) {
          if (!f.endsWith('.jsonl')) continue
          out.push(join(dir, f))
          if (out.length >= max) return out
        }
      }
    }
  }
  return out
}

/** Últimos bytes de um arquivo como texto (sem carregar rollouts de centenas de MB). */
function tail(file: string, bytes: number): string {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, bytes)
    const buf = Buffer.allocUnsafe(len)
    readSync(fd, buf, 0, len, size - len)
    const text = buf.toString('utf8')
    // a primeira linha pode estar cortada ao meio
    return len < size ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(fd)
  }
}

export interface CodexSnapshot {
  rateLimits: unknown
  asOf: string | null
}

/** Último `rate_limits` gravado pelo Codex CLI, do rollout mais novo para o mais velho. */
export function readCodexSnapshot(sessionsDir: string): CodexSnapshot | null {
  for (const file of latestCodexRollouts(sessionsDir)) {
    let lines: string[]
    try {
      lines = tail(file, CODEX_TAIL_BYTES).split('\n')
    } catch {
      continue
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"rate_limits"')) continue
      let ev: Record<string, unknown> | null
      try {
        ev = obj(JSON.parse(line))
      } catch {
        continue
      }
      const payload = obj(ev?.payload) ?? ev
      const rl = obj(payload?.rate_limits) ?? obj(obj(payload?.info)?.rate_limits)
      if (!rl) continue
      return { rateLimits: rl, asOf: toIso(ev?.timestamp) }
    }
  }
  return null
}

/** `chatgpt_plan_type` do id_token (claim pública; o token em si não sai daqui). */
function codexPlanFromAuth(authFile: string): string | null {
  try {
    const tokens = obj(obj(JSON.parse(readFileSync(authFile, 'utf8')))?.tokens)
    const idToken = str(tokens?.id_token)
    if (!idToken) return null
    const payload = obj(JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')))
    const plan = str(obj(payload?.['https://api.openai.com/auth'])?.chatgpt_plan_type)
    return plan ? plan.replace(/^\w/, (c) => c.toUpperCase()) : null
  } catch {
    return null
  }
}

const CODEX_SOURCE = 'Codex CLI · snapshot local'

function collectCodex(): ProviderQuota | null {
  const home = codexHome()
  const authFile = join(home, 'auth.json')
  // Sem login do Codex nesta máquina: não cria aba.
  if (!existsSync(authFile)) return null
  const base: ProviderQuota = {
    provider: 'codex',
    label: 'Codex',
    plan: codexPlanFromAuth(authFile),
    windows: [],
    source: CODEX_SOURCE,
    asOf: null,
    error: null,
    note: null,
  }
  let snap: CodexSnapshot | null = null
  try {
    snap = readCodexSnapshot(join(home, 'sessions'))
  } catch (e) {
    return { ...base, error: errMsg(e) }
  }
  if (!snap) return { ...base, error: 'sem snapshot de uso — use o `codex` uma vez para ele gravar os limites' }
  const norm = normalizeCodexRateLimits(snap.rateLimits, { asOf: snap.asOf })
  return {
    ...base,
    ...norm,
    plan: norm.plan ?? base.plan,
    source: CODEX_SOURCE,
    note: 'o ChatGPT não expõe cota por API — número do último uso do Codex CLI',
  }
}

// ─── Provedores configurados no Hermes (sem API de uso) ──────────────────────

const PRETTY: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  chatgpt: 'Codex',
  huggingface: 'Hugging Face',
  nous: 'Nous Portal',
  nousresearch: 'Nous Portal',
  openrouter: 'OpenRouter',
  google: 'Google',
  gemini: 'Gemini',
  groq: 'Groq',
  xai: 'xAI',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
  moonshot: 'Moonshot',
}

/** Provedor do Hermes que já é coberto por um coletor dedicado. */
const COVERED_BY: Record<string, string> = { anthropic: 'claude', openai: 'codex', chatgpt: 'codex' }

const pretty = (id: string): string =>
  PRETTY[id.toLowerCase()] ?? id.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/**
 * Provedores do `auth.json` do Hermes que ninguém mais cobre. Viram aba com
 * estado honesto ("configurado, sem API de cota") — nunca com número
 * inventado. O que já tem coletor dedicado (anthropic→Claude) é ignorado.
 */
export function hermesConfiguredProviders(hermesHome: string, already: Set<string>): ProviderQuota[] {
  let auth: Record<string, unknown> | null
  try {
    auth = obj(JSON.parse(readFileSync(join(hermesHome, 'auth.json'), 'utf8')))
  } catch {
    return []
  }
  const pool = obj(auth?.credential_pool) ?? {}
  const configured = obj(auth?.providers) ?? {}
  const ids = new Set([...Object.keys(pool), ...Object.keys(configured)])
  const out: ProviderQuota[] = []
  for (const id of ids) {
    const low = id.toLowerCase()
    const covered = COVERED_BY[low]
    if (covered && already.has(covered)) continue
    if (already.has(low)) continue
    const entry = Array.isArray(pool[id]) ? obj((pool[id] as unknown[])[0]) : null
    const authType = str(entry?.auth_type)
    out.push({
      provider: low,
      label: pretty(id),
      plan: authType ? (authType === 'oauth' ? 'OAuth' : 'API key') : null,
      windows: [],
      source: 'Hermes · auth.json',
      asOf: null,
      error: null,
      note: 'configurado no Hermes, mas o provedor não expõe janelas de cota',
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))
}

// ─── Coleta com cache ────────────────────────────────────────────────────────

/** Cache mínimo do snapshot. Todo widget que assina a cota cai no mesmo cache. */
export const QUOTA_TTL_MS = 90_000

let cache: { snap: QuotaSnapshot; at: number } | null = null
let inflight: Promise<QuotaSnapshot> | null = null

async function collect(): Promise<QuotaSnapshot> {
  const settled = await Promise.allSettled<ProviderQuota | null>([collectClaude(), Promise.resolve().then(collectCodex)])
  const providers: ProviderQuota[] = []
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      if (r.value) providers.push(r.value)
    } else {
      console.error('[cockpit] coleta de cota falhou:', errMsg(r.reason))
    }
  }
  const seen = new Set(providers.map((p) => p.provider))
  providers.push(...hermesConfiguredProviders(resolveHermesHome(), seen))
  return { providers, collectedAt: new Date().toISOString() }
}

/** Snapshot de cota (cache de QUOTA_TTL_MS; `force` ignora o cache). */
export function collectQuota(force = false): Promise<QuotaSnapshot> {
  if (!force && cache && Date.now() - cache.at < QUOTA_TTL_MS) return Promise.resolve(cache.snap)
  if (inflight) return inflight
  inflight = collect()
    .then((snap) => {
      cache = { snap, at: Date.now() }
      return snap
    })
    .catch((e) => {
      // Nunca lança para o renderer: devolve snapshot vazio e loga a causa.
      console.error('[cockpit] cota indisponível:', errMsg(e))
      return { providers: [], collectedAt: new Date().toISOString() } satisfies QuotaSnapshot
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
