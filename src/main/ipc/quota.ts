import { collectQuota, type QuotaSnapshot } from '../quota.ts'
import { handle } from './index'

// Cota dos provedores (Claude Code OAuth, Codex, provedores do Hermes).
// O renderer recebe só percentuais/horários — token nenhum atravessa o IPC
// (ver src/main/quota.ts). `quota:get` usa o cache (≥60s); `quota:refresh`
// força uma coleta nova (botão ↻ do painel).

export function register(): void {
  handle<[], QuotaSnapshot>('quota:get', () => collectQuota(false))
  handle<[], QuotaSnapshot>('quota:refresh', () => collectQuota(true))
}
