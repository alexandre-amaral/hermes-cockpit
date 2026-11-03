// Swarm de Claude Code — tipos do contrato (docs/SWARM-SPEC.md), wrappers do IPC
// `swarm:*` e um store compartilhado (um único poller/assinatura para todos os
// componentes: SwarmView, SwarmCard, SwarmDockTab). Falha do main vira estado
// 'unavailable'/'error' — nunca dado inventado.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { inSpace, spaceOfBot, spaceOfPath, useSpace, type ItemSpace } from './space'
import { hasMain, invoke, onMain } from './ipc'
import { toast } from './toast'

// ── tipos (espelho da spec) ─────────────────────────────────────────────────

export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'done' | 'error' | 'cancelled'

export interface RunMeta {
  id: string
  parentRunId?: string
  permissionMode?: 'manual' | 'auto' | 'acceptEdits' | 'bypass'
  groupId?: string
  title: string
  task: string
  repo: string
  cwd: string
  branch?: string
  model?: string
  status: RunStatus
  pid?: number
  claudePid?: number
  claudeSessionId?: string
  requestedBy?: { profile?: string; sessionId?: string; via: 'mcp' | 'cockpit' }
  createdAt: string
  startedAt?: string
  endedAt?: string
  numTurns?: number
  /** Interno: US$ reportado pelo claude. Não exibir como consumo (regra: US$ só em cotas de créditos). */
  costUsd?: number
  /** Soma real input+output+cache_creation+cache_read do último result (ausente = sem dado). */
  tokensTotal?: number
  tokenUsage?: {
    inputTokens?: number
    outputTokens?: number
    cacheCreationInputTokens?: number
    cacheReadInputTokens?: number
  }
  durationMs?: number
  resultText?: string
  error?: string
  exitCode?: number
}

export interface Approval {
  id: string
  /** 'question' = AskUserQuestion do Claude Code (responder, não aprovar) */
  kind?: 'question'
  runId: string
  toolName: string
  input: unknown
  status: 'pending' | 'allow' | 'deny'
  createdAt: string
  decidedAt?: string
  reason?: string
  updatedInput?: unknown
}

export interface SwarmStatus {
  installed: boolean
  binDir: string
  claudeVersion?: string
  profilesRegistered: string[]
}

export interface SwarmEventLine {
  ts: string
  ev: unknown
}

export interface SpawnInput {
  task: string
  cwd: string
  title?: string
  model?: string
  groupId?: string
  permissionMode?: 'manual' | 'auto' | 'acceptEdits' | 'bypass'
}

// ── wrappers IPC ────────────────────────────────────────────────────────────

export const swarmApi = {
  status: () => invoke<SwarmStatus>('swarm:status'),
  list: (limit?: number) => invoke<RunMeta[]>('swarm:list', limit ? { limit } : {}),
  events: (runId: string, fromLine: number) =>
    invoke<{ lines: SwarmEventLine[]; next: number }>('swarm:events', runId, fromLine),
  approvals: () => invoke<Approval[]>('swarm:approvals'),
  decide: (approvalId: string, decision: 'allow' | 'deny', reason?: string, updatedInput?: unknown) =>
    invoke<void>('swarm:decide', approvalId, decision, reason, updatedInput),
  cancel: (runId: string) => invoke<void>('swarm:cancel', runId),
  /** abre terminal real (Ghostty/Terminal): watch = seguir ao vivo; resume = claude --resume interativo */
  openTerminal: (runId: string, mode: 'watch' | 'resume') => invoke<void>('swarm:openTerminal', runId, mode),
  spawn: (input: SpawnInput) => invoke<RunMeta>('swarm:spawn', input),
  send: (runId: string, message: string) => invoke<RunMeta>('swarm:send', runId, message),
  cleanup: (runId: string) => invoke<void>('swarm:cleanup', runId),
  config: () => invoke<{ defaultPermissionMode: SpawnInput['permissionMode'] }>('swarm:config'),
  setConfig: (defaultPermissionMode: NonNullable<SpawnInput['permissionMode']>) =>
    invoke<{ defaultPermissionMode: string }>('swarm:setConfig', { defaultPermissionMode }),
}

// ── helpers de apresentação ─────────────────────────────────────────────────

export const ACTIVE_STATUSES: RunStatus[] = ['queued', 'running', 'waiting_approval']

export function isActive(s: RunStatus): boolean {
  return ACTIVE_STATUSES.includes(s)
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'na fila',
  running: 'executando',
  waiting_approval: 'aguardando você',
  done: 'concluída',
  error: 'falhou',
  cancelled: 'cancelada',
}

/** classes Tailwind de cor (texto / fundo) por status */
export const STATUS_TONE: Record<RunStatus, { text: string; bg: string }> = {
  queued: { text: 'text-dim', bg: 'bg-edge2' },
  running: { text: 'text-phos', bg: 'bg-phos' },
  waiting_approval: { text: 'text-amber', bg: 'bg-amber' },
  done: { text: 'text-cyanic', bg: 'bg-cyanic' },
  error: { text: 'text-alert', bg: 'bg-alert' },
  cancelled: { text: 'text-faint', bg: 'bg-faint' },
}

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // ipcRenderer.invoke prefixa "Error invoking remote method 'x': Error: ..."
  return m.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

/** canal sem handler no main (domínio ainda não implementado / build antigo) */
export function isNoHandler(e: unknown): boolean {
  return /No handler registered/i.test(e instanceof Error ? e.message : String(e))
}

export function runElapsedMs(r: RunMeta, now = Date.now()): number | null {
  if (r.durationMs != null && !isActive(r.status)) return r.durationMs
  const start = r.startedAt ?? r.createdAt
  const s = start ? Date.parse(start) : NaN
  if (Number.isNaN(s)) return r.durationMs ?? null
  const e = r.endedAt ? Date.parse(r.endedAt) : now
  return Math.max(0, (Number.isNaN(e) ? now : e) - s)
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '--:--'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function repoName(path: string | undefined): string {
  if (!path) return ''
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

/** rótulo curto "@nome" da run (bot que pediu ou título) */
export function runHandle(r: RunMeta): string {
  const who = r.requestedBy?.profile
  if (who) return `@${who}`
  const t = (r.title || r.task || r.id).trim().split(/\s+/).slice(0, 3).join(' ')
  return t.length > 22 ? `${t.slice(0, 21)}…` : t
}

export function newGroupId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const hex = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
  return `g-${stamp}-${hex}`
}

// ── store compartilhado ─────────────────────────────────────────────────────

export type SwarmPhase = 'loading' | 'ready' | 'unavailable' | 'error'

export interface SwarmState {
  phase: SwarmPhase
  /** motivo de 'unavailable' / 'error' */
  error?: string
  status: SwarmStatus | null
  runs: RunMeta[]
  approvals: Approval[]
  updatedAt: number
}

const POLL_ACTIVE_MS = 2500
const POLL_IDLE_MS = 8000

let state: SwarmState = { phase: 'loading', status: null, runs: [], approvals: [], updatedAt: 0 }
const listeners = new Set<() => void>()
let refs = 0
let timer: ReturnType<typeof setTimeout> | null = null
let offChanged: (() => void) | null = null
let inflight: Promise<void> | null = null
let queued = false
let seenApprovals: Set<string> | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

function setState(patch: Partial<SwarmState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function notifyNewApprovals(list: Approval[], runs: RunMeta[]): void {
  const ids = new Set(list.map((a) => a.id))
  if (seenApprovals) {
    for (const a of list) {
      if (seenApprovals.has(a.id)) continue
      const run = runs.find((r) => r.id === a.runId)
      toast({
        title: a.toolName === 'AskUserQuestion' ? 'Claude Code pergunta — responda no Swarm' : `Aprovação pendente · ${a.toolName}`,
        detail: run ? `${runHandle(run)} — ${run.title || run.task}`.slice(0, 140) : a.runId,
        tone: 'warn',
        durationMs: 8000,
      })
    }
  }
  seenApprovals = ids
}

async function load(): Promise<void> {
  if (!hasMain()) {
    setState({ phase: 'unavailable', error: 'sem main process (modo navegador)' })
    return
  }
  let status: SwarmStatus
  try {
    status = await swarmApi.status()
  } catch (e) {
    setState(
      isNoHandler(e)
        ? { phase: 'unavailable', error: 'domínio swarm não registrado no main' }
        : { phase: 'error', error: errMsg(e) },
    )
    return
  }
  if (!status.installed) {
    setState({ phase: 'ready', status, runs: [], approvals: [], error: undefined, updatedAt: Date.now() })
    return
  }
  const [runsR, apprR] = await Promise.allSettled([swarmApi.list(100), swarmApi.approvals()])
  const runs = runsR.status === 'fulfilled' && Array.isArray(runsR.value) ? runsR.value : state.runs
  const approvals = (apprR.status === 'fulfilled' && Array.isArray(apprR.value) ? apprR.value : state.approvals).filter(
    (a) => a.status === 'pending',
  )
  const firstErr =
    runsR.status === 'rejected' ? errMsg(runsR.reason) : apprR.status === 'rejected' ? errMsg(apprR.reason) : undefined
  if (apprR.status === 'fulfilled') notifyNewApprovals(approvals, runs)
  setState({
    phase: runsR.status === 'rejected' && state.updatedAt === 0 ? 'error' : 'ready',
    status,
    runs,
    approvals,
    error: firstErr,
    updatedAt: Date.now(),
  })
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  if (refs === 0) return
  const active = state.runs.some((r) => isActive(r.status)) || state.approvals.length > 0
  const ms = state.phase === 'unavailable' ? 15000 : active ? POLL_ACTIVE_MS : POLL_IDLE_MS
  timer = setTimeout(() => void refreshSwarm(), ms)
}

/** Recarrega status/lista/aprovações (coalesce chamadas concorrentes). */
export function refreshSwarm(): Promise<void> {
  if (inflight) {
    queued = true
    return inflight
  }
  inflight = load()
    .catch((e) => setState({ phase: 'error', error: errMsg(e) }))
    .finally(() => {
      inflight = null
      if (queued) {
        queued = false
        void refreshSwarm()
      } else schedule()
    })
  return inflight
}

const changedListeners = new Set<(p: { runId?: string }) => void>()

function start(): void {
  offChanged = onMain<{ runId?: string } | undefined>('swarm:changed', (p) => {
    for (const l of changedListeners) l(p ?? {})
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => void refreshSwarm(), 120)
  })
  void refreshSwarm()
}

function stop(): void {
  offChanged?.()
  offChanged = null
  if (timer) clearTimeout(timer)
  timer = null
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Estado vivo do swarm. Um único poller por janela, com assinatura de `swarm:changed`. */
export function useSwarm(): SwarmState & { refresh: () => Promise<void> } {
  useEffect(() => {
    if (++refs === 1) start()
    return () => {
      if (--refs === 0) stop()
    }
  }, [])
  const s = useSyncExternalStore(subscribe, () => state)
  // Espaço ativo: runs filtradas (bot que pediu, senão repo). Aprovações e
  // perguntas pendentes NÃO são filtradas — nada que espera você fica escondido.
  const space = useSpace()
  const runs = useMemo(() => s.runs.filter((r) => inSpace(runSpace(r), space)), [s.runs, space])
  return { ...s, runs, refresh: refreshSwarm }
}

/** espaço de uma run: bot que pediu (se não for compartilhado), senão o caminho do repo */
export function runSpace(r: RunMeta): ItemSpace {
  const bySpace = r.requestedBy?.profile ? spaceOfBot(r.requestedBy.profile) : 'shared'
  return bySpace !== 'shared' ? bySpace : spaceOfPath(r.repo)
}

/** Assina `swarm:changed` (já com o domínio ativo via useSwarm). */
export function onSwarmChanged(fn: (p: { runId?: string }) => void): () => void {
  changedListeners.add(fn)
  return () => {
    changedListeners.delete(fn)
  }
}

// ── eventos de uma run (incremental) ────────────────────────────────────────

interface EventsCache {
  lines: SwarmEventLine[]
  next: number
}
const eventsCache = new Map<string, EventsCache>()

export interface RunEventsState {
  lines: SwarmEventLine[]
  loading: boolean
  error?: string
}

/** Busca eventos da run a partir da última linha lida; refaz em `swarm:changed` e
 *  por polling curto enquanto a run está ativa. */
export function useRunEvents(runId: string | null, active: boolean): RunEventsState {
  const [st, setSt] = useStateSafe<RunEventsState>({ lines: [], loading: true })

  useEffect(() => {
    if (!runId) {
      setSt({ lines: [], loading: false })
      return
    }
    let cancelled = false
    let busy = false
    let again = false
    const cached = eventsCache.get(runId)
    setSt({ lines: cached?.lines ?? [], loading: !cached })

    const pull = async (): Promise<void> => {
      if (busy) {
        again = true
        return
      }
      busy = true
      try {
        for (let guard = 0; guard < 20; guard++) {
          const c = eventsCache.get(runId) ?? { lines: [], next: 0 }
          const res = await swarmApi.events(runId, c.next)
          if (cancelled) return
          const got = Array.isArray(res?.lines) ? res.lines : []
          const next = typeof res?.next === 'number' ? res.next : c.next + got.length
          const merged = { lines: got.length ? [...c.lines, ...got] : c.lines, next }
          eventsCache.set(runId, merged)
          setSt({ lines: merged.lines, loading: false })
          if (got.length < 200 || next <= c.next) break
        }
      } catch (e) {
        if (!cancelled) setSt((p) => ({ ...p, loading: false, error: errMsg(e) }))
      } finally {
        busy = false
        if (again && !cancelled) {
          again = false
          void pull()
        }
      }
    }

    void pull()
    const off = onSwarmChanged((p) => {
      if (!p.runId || p.runId === runId) void pull()
    })
    const iv = active ? setInterval(() => void pull(), 1500) : null
    return () => {
      cancelled = true
      off()
      if (iv) clearInterval(iv)
    }
  }, [runId, active, setSt])

  return st
}

// useState que ignora set após unmount (evita warnings em pull tardio)
function useStateSafe<T>(init: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(init)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const set = useCallback((x: T | ((p: T) => T)) => {
    if (alive.current) setV(x)
  }, [])
  return [v, set]
}

/** relógio que avança a cada `ms` (para durações ao vivo) */
export function useNow(ms = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const iv = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(iv)
  }, [ms, enabled])
  return now
}
