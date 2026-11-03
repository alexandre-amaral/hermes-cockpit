// Formatos das rotas do plugin cockpit (~/.hermes/plugins/cockpit/dashboard/plugin_api.py).
// Tudo opcional: o plugin pode evoluir e cada fonte pode falhar sozinha.

export interface AgendaEvent {
  summary?: string
  start?: string
  end?: string
  location?: string
  description?: string
  htmlLink?: string
  /** espaço da conta Google ('houer' = work; 'pessoal' = alexandre.slamaral@gmail.com) */
  conta?: 'houer' | 'pessoal' | string
  calendario?: 'Houer' | 'Pessoal' | 'FIAP' | string
}

export interface Agenda {
  events?: AgendaEvent[]
  date?: string
  conta?: string
  dias?: number
  /** falhas parciais por "conta/calendário" (os demais calendários ainda vêm) */
  erros?: Record<string, string>
  error?: string
}

/** Cor por calendário (timeline da agenda). */
export const CALENDAR_COLORS: Record<string, string> = {
  Houer: 'var(--color-amber)',
  Pessoal: 'var(--color-cyanic)',
  FIAP: 'var(--color-phos)',
}
export const calendarColor = (c?: string): string => CALENDAR_COLORS[c ?? ''] ?? 'var(--color-dim)'

/** Job de /api/cron/jobs (hermes_cli/web_routers/cron.py, anotado com profile). */
export interface CronJob {
  id: string
  name?: string | null
  enabled?: boolean
  state?: string | null
  schedule_display?: string | null
  schedule?: { display?: string; expr?: string; kind?: string }
  next_run_at?: string | null
  last_run_at?: string | null
  last_error?: string | null
  profile?: string
  profile_name?: string
  model?: string | null
}

export interface NotionTask {
  id?: string
  task?: string
  status?: string
  prioridade?: string[]
  categoria?: string[]
  date?: string | null
  end?: string | null
  url?: string
}

export interface Notion {
  hoje?: NotionTask[]
  backlog_high?: NotionTask[]
  in_progress?: NotionTask[]
  counts?: { total?: number; done?: number; abertas?: number }
  error?: string
}

export interface Foco {
  agora?: string
  janela?: string
  proximo_evento?: AgendaEvent | null
  blocos_livres?: Array<{ inicio?: string; fim?: string; minutos?: number }>
  top3_hoje?: NotionTask[]
  erros?: Record<string, string>
}

export interface QuotaJanela {
  nome?: string
  pct?: number
  reset?: string | null
}

// Formato do plugin cockpit. A conversão para o modelo de cota do app está em
// src/renderer/src/lib/quota-model.ts (`providersFromPlugin`), que é a única
// coisa que lê isto hoje.
export interface QuotaProvedor {
  nome?: string
  plano?: string
  janelas?: QuotaJanela[]
  aviso?: string
}

export interface Quota {
  mes?: string
  gasto_usd?: number
  gasto_brl?: number
  budget_brl?: number
  fx?: number
  provedores?: QuotaProvedor[]
}

export interface InboxItem {
  conta?: string
  from?: string
  subject?: string
  snippet?: string
  date?: string
}

export interface Inbox {
  responder?: InboxItem[]
  ler?: InboxItem[]
  error?: string
}

export interface Sistema {
  cpu_percent?: number
  mem_percent?: number
  mem_used_gb?: number
  mem_total_gb?: number
  disk_percent?: number
  disk_free_gb?: number
  load1?: number | null
  bateria_percent?: number | null
  bateria_carregando?: boolean | null
  ollama?: boolean
  hermes_processes?: number
  gateway?: { status?: string; pid?: number; started_at?: string; version?: string; code_version?: string } | null
}

export const API = {
  foco: '/api/plugins/cockpit/foco',
  agenda: '/api/plugins/cockpit/agenda',
  notion: '/api/plugins/cockpit/notion',
  sistema: '/api/plugins/cockpit/sistema',
  bots: '/api/plugins/cockpit/bots',
  quota: '/api/plugins/cockpit/quota',
  inbox: '/api/plugins/cockpit/inbox',
} as const

/** Tokens compactos: 999, 12k, 2.5M. */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}
