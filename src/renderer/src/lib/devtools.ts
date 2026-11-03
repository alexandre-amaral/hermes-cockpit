import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, hasMain, invoke } from './ipc'
import { toast } from './toast'

// Devtools do dock (Terminal, Diff · Git, Arquivos, Preview, Tela).
// Tudo aqui é leitura de fontes reais: REST do serve (/api/fs/*, /api/git/*)
// via proxy do main, e IPC do domínio ops (ops:repos, ops:ports, ...). Falha
// de fonte vira estado de erro no painel — nunca dado inventado.

// ─── Tipos (espelho de hermes_cli/web_routers/{files,git}.py + web_git.py) ───

export interface FsEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface FsList {
  entries: FsEntry[]
  error?: string
}

export interface FsText {
  binary: boolean
  byteSize: number
  language: string
  mimeType: string
  path: string
  text: string
  truncated: boolean
}

export interface GitStatusFile {
  path: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}

/** /api/git/status → null fora de um repo. */
export interface GitStatus {
  branch: string | null
  defaultBranch?: string | null
  detached: boolean
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  changed: number
  added: number
  removed: number
  files: GitStatusFile[]
}

/** /api/git/review/list → files[] */
export interface ReviewFile {
  path: string
  added: number
  removed: number
  /** M A D R ? U ... */
  status: string
  staged: boolean
}

export interface Worktree {
  path: string
  branch: string | null
  isMain: boolean
  detached: boolean
  locked: boolean
}

export interface Branch {
  name: string
  checkedOut: boolean
  isDefault: boolean
  isRemote: boolean
  worktreePath: string | null
}

/** Contrato do canal 'ops:repos' (agente ops). */
export interface RepoInfo {
  path: string
  name: string
  branch?: string
  dirty: number
  ahead?: number
  behind?: number
  lastCommit?: string
}

/** Contrato do canal 'ops:ports' (agente ops). */
export interface PortInfo {
  port: number
  pid: number
  command: string
  address: string
  user?: string
}

export type OpenTarget = { kind: 'finder' | 'vscode' | 'terminal' | 'url'; path?: string; url?: string }

// ─── Utilitários ─────────────────────────────────────────────────────────────

export function errMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  // O IPC do Electron prefixa "Error invoking remote method 'x': Error: ..."
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

/** Canal IPC sem handler registrado (domínio ainda não implementado). */
export function isNoHandler(e: unknown): boolean {
  return /No handler registered/i.test(errMsg(e))
}

/** Monta `/api/...?<params>` com encode correto. Valores undefined/'' saem. */
export function apiPath(path: string, params: Record<string, string | number | boolean | undefined | null> = {}): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    qs.set(k, String(v))
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

export function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  if (i <= 0) return '/'
  return trimmed.slice(0, i)
}

/** Encurta /Users/<u>/... para ~/... só para exibição. */
export function tildify(p: string): string {
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Abre no Finder/VS Code/Terminal/navegador via ops:open; erro vira toast. */
export async function openIn(target: OpenTarget): Promise<void> {
  try {
    await invoke<void>('ops:open', target)
  } catch (e) {
    toast({
      title: 'não consegui abrir',
      detail: isNoHandler(e) ? 'canal ops:open ainda não disponível no main' : errMsg(e),
      tone: 'error',
    })
  }
}

// ─── Diff unificado ──────────────────────────────────────────────────────────

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** número da linha antiga/nova (ctx/del/add) */
  oldNo?: number
  newNo?: number
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    const h = HUNK_RE.exec(line)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      inHunk = true
      out.push({ kind: 'hunk', text: line })
      continue
    }
    if (!inHunk || line.startsWith('diff --git') || line.startsWith('\\ No newline')) {
      if (line.startsWith('diff --git')) inHunk = false
      if (line !== '') out.push({ kind: 'meta', text: line })
      continue
    }
    if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1), newNo: newNo++ })
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ })
    else if (line === '') continue
    else out.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
  }
  return out
}

// ─── Workspace compartilhado (Terminal/Git/Arquivos/DiffCard) ────────────────
// Store de módulo (pequeno, sem lib): a escolha do usuário persiste em
// localStorage (conveniência por máquina); sem escolha, vale /api/fs/default-cwd.

const WS_KEY = 'hc.devtools.workspace'
type WsListener = () => void
const wsListeners = new Set<WsListener>()
let wsPath: string | null = readStoredWorkspace()
let wsDefault: string | null = null
let wsDefaultError: string | null = null
let wsDefaultLoading = false

function readStoredWorkspace(): string | null {
  try {
    const v = localStorage.getItem(WS_KEY)
    return v && v.startsWith('/') ? v : null
  } catch {
    return null
  }
}

function emitWs(): void {
  snapshot = makeSnapshot()
  for (const fn of wsListeners) fn()
}

export interface WorkspaceState {
  /** caminho efetivo (escolha do usuário → default do serve) */
  path: string | null
  /** default do serve (/api/fs/default-cwd) */
  defaultPath: string | null
  error: string | null
  loading: boolean
}

function makeSnapshot(): WorkspaceState {
  return { path: wsPath ?? wsDefault, defaultPath: wsDefault, error: wsDefaultError, loading: wsDefaultLoading }
}
let snapshot: WorkspaceState = makeSnapshot()

export function setWorkspace(path: string | null): void {
  wsPath = path && path.trim() ? path.trim().replace(/(.)\/+$/, '$1') : null
  try {
    if (wsPath) localStorage.setItem(WS_KEY, wsPath)
    else localStorage.removeItem(WS_KEY)
  } catch {
    /* storage indisponível: fica só em memória */
  }
  emitWs()
}

export async function loadDefaultWorkspace(force = false): Promise<void> {
  if (wsDefaultLoading || (wsDefault && !force)) return
  wsDefaultLoading = true
  wsDefaultError = null
  emitWs()
  try {
    const r = await api<{ cwd: string; branch?: string | null }>('/api/fs/default-cwd')
    wsDefault = r?.cwd || null
    if (!wsDefault) wsDefaultError = 'serve não informou cwd padrão'
  } catch (e) {
    wsDefaultError = errMsg(e)
  } finally {
    wsDefaultLoading = false
    emitWs()
  }
}

export function useWorkspace(): WorkspaceState {
  const state = useSyncExternalStore(
    (fn) => {
      wsListeners.add(fn)
      return () => wsListeners.delete(fn)
    },
    () => snapshot,
  )
  useEffect(() => {
    if (!wsDefault && !wsDefaultLoading && !wsDefaultError) void loadDefaultWorkspace()
  }, [])
  return state
}

// ─── Fonte assíncrona genérica ───────────────────────────────────────────────

export interface Resource<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  refresh: () => void
}

/**
 * Carrega `fn` quando `key` muda (key null = não carrega) e, opcionalmente,
 * a cada `refreshMs`. Mantém o último dado bom durante refresh; descarta
 * respostas de chaves antigas.
 */
export function useResource<T>(key: string | null, fn: () => Promise<T>, refreshMs = 0): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const keyRef = useRef(key)

  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key
      setData(undefined)
    }
    if (key === null) {
      setError(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    fnRef
      .current()
      .then((d) => {
        if (!alive) return
        setData(d)
        setError(null)
      })
      .catch((e: unknown) => {
        if (alive) setError(errMsg(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [key, tick])

  useEffect(() => {
    if (!refreshMs || key === null) return
    const t = window.setInterval(() => {
      if (!document.hidden) setTick((n) => n + 1)
    }, refreshMs)
    return () => window.clearInterval(t)
  }, [key, refreshMs])

  const refresh = useCallback(() => setTick((n) => n + 1), [])
  return { data, error, loading, refresh }
}

/** ops:repos — lista vazia (sem erro) quando o domínio ainda não existe. */
export async function fetchRepos(): Promise<RepoInfo[]> {
  if (!hasMain()) return []
  try {
    const r = await invoke<RepoInfo[]>('ops:repos')
    return Array.isArray(r) ? r : []
  } catch (e) {
    if (isNoHandler(e)) return []
    throw e
  }
}

// ─── Navegação entre abas do dock ────────────────────────────────────────────

/** Evento global para pedir troca de aba do dock (ex.: DiffCard → 'diff'). */
export const DOCK_TAB_EVENT = 'hc:dock-tab'

export function requestDockTab(id: string): void {
  window.dispatchEvent(new CustomEvent<string>(DOCK_TAB_EVENT, { detail: id }))
}

/** Pedido de foco em arquivo específico na aba Diff · Git (ex.: DiffCard). */
export const DIFF_FOCUS_EVENT = 'hc:diff-focus'

let pendingDiffFocus: string | null = null

/** Guarda o pedido (para a aba que ainda não montou) e avisa quem já está montado. */
export function requestDiffFocus(file: string): void {
  pendingDiffFocus = file
  window.dispatchEvent(new CustomEvent<string>(DIFF_FOCUS_EVENT, { detail: file }))
}

/** Consome o pedido pendente (GitTab ao montar/receber). */
export function takeDiffFocus(): string | null {
  const f = pendingDiffFocus
  pendingDiffFocus = null
  return f
}
