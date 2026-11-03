import { useCallback, useEffect, useState } from 'react'
import { usePluginSource } from '../components/panels/source'
import { API, type Quota } from '../components/panels/types'
import { hasMain, invoke } from './ipc'
import { mergeProviders, providersFromPlugin, type ProviderQuota, type QuotaSnapshot } from './quota-model'

// Cota no renderer: duas fontes, nenhuma obrigatória.
//
// 1. `quota:*` do main (src/main/quota.ts) — Claude Code OAuth e Codex, ao
//    vivo, com cache no main. É a fonte que funciona em qualquer máquina.
// 2. `/api/plugins/cockpit/quota` — o plugin do Hermes, que só existe onde foi
//    instalado (no Windows desta máquina responde 404 "Plugin not found").
//    Quando existe, acrescenta provedores e o gasto do mês.
//
// Erro de uma fonte NÃO derruba a outra; erro de um provedor fica no provedor.

export type { ProviderQuota, QuotaSnapshot } from './quota-model'

interface IpcState {
  snap: QuotaSnapshot | null
  error: string | null
  loading: boolean
  updatedAt: number | null
}

const EMPTY: IpcState = { snap: null, error: null, loading: true, updatedAt: null }

// Um poller só para todos os assinantes (strip, rail, dock e topbar leem a
// mesma cota). O main ainda tem cache próprio ≥60s, então refresh é barato.
const listeners = new Set<() => void>()
const periods = new Map<symbol, number>()
let state: IpcState = EMPTY
let timer: ReturnType<typeof setInterval> | null = null
let period = 0
let inflight = false

function emit(): void {
  for (const l of listeners) l()
}

async function fetchOnce(force: boolean): Promise<void> {
  if (!hasMain()) {
    state = { snap: null, error: null, loading: false, updatedAt: Date.now() }
    emit()
    return
  }
  if (inflight) return
  inflight = true
  try {
    const snap = await invoke<QuotaSnapshot>(force ? 'quota:refresh' : 'quota:get')
    state = { snap, error: null, loading: false, updatedAt: Date.now() }
  } catch (err) {
    state = {
      snap: state.snap,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      loading: false,
      updatedAt: Date.now(),
    }
  } finally {
    inflight = false
    emit()
  }
}

function reschedule(): void {
  const next = periods.size ? Math.max(30_000, Math.min(...periods.values())) : 0
  if (next === period) return
  if (timer) clearInterval(timer)
  timer = next ? setInterval(() => void fetchOnce(false), next) : null
  period = next
}

function subscribe(refreshMs: number, fn: () => void): () => void {
  const key = Symbol('quota')
  listeners.add(fn)
  periods.set(key, refreshMs)
  reschedule()
  if (state.updatedAt === null && !inflight) void fetchOnce(false)
  return () => {
    listeners.delete(fn)
    periods.delete(key)
    reschedule()
  }
}

/** Snapshot do coletor do main, com polling compartilhado. */
export function useQuotaIpc(refreshMs = 60_000): IpcState & { refresh: () => void } {
  const [, bump] = useState(0)
  useEffect(() => subscribe(refreshMs, () => bump((n) => n + 1)), [refreshMs])
  const refresh = useCallback(() => void fetchOnce(true), [])
  return { ...state, refresh }
}

export interface QuotaView {
  /** provedores das duas fontes, já unidos e ordenados */
  providers: ProviderQuota[]
  /** payload do plugin cockpit (gasto do mês), quando existe */
  plugin: Quota | null
  /** erro só quando NENHUMA fonte entregou provedor */
  error: string | null
  loading: boolean
  refresh: () => void
}

/**
 * Visão unificada da cota para os painéis. `error` só é preenchido quando as
 * duas fontes falharam (ou não há nenhum provedor): com Claude/Codex vivos, o
 * 404 do plugin não vira erro de widget.
 */
export function useQuota(refreshMs = 60_000): QuotaView {
  const ipc = useQuotaIpc(refreshMs)
  const plugin = usePluginSource<Quota>(API.quota, refreshMs)
  const fromMain = ipc.snap?.providers ?? []
  const fromPlugin = providersFromPlugin(plugin.data?.provedores)
  const providers = mergeProviders(fromMain, fromPlugin)
  const loading = (ipc.loading || plugin.loading) && providers.length === 0
  const refresh = () => {
    ipc.refresh()
    plugin.refresh()
  }
  return {
    providers,
    plugin: plugin.data ?? null,
    error: providers.length === 0 && !loading ? (ipc.error ?? plugin.error ?? null) : null,
    loading,
    refresh,
  }
}
