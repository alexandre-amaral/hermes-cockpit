import { invoke, onMain } from './ipc'

// Tipos + wrappers do domínio "ops" (src/main/ipc/ops.ts). Os tipos daqui são
// a fonte de verdade: o main os importa com `import type` (apagado no build).
// Canais com contrato compartilhado (usados por outros painéis — não mudar):
//   ops:ports, ops:screenshot, ops:repos, ops:open.

// ─── contratos compartilhados ───────────────────────────────────────────────
export interface PortRow {
  port: number
  pid: number
  command: string
  address: string
  user?: string
}

export interface RepoRow {
  path: string
  name: string
  branch?: string
  dirty: number
  ahead?: number
  behind?: number
  /** "<quando> · <assunto>" do último commit */
  lastCommit?: string
}

export interface OpenTarget {
  kind: 'finder' | 'vscode' | 'terminal' | 'url'
  path?: string
  url?: string
}

export interface Screenshot {
  dataUrl: string
}

// ─── demais canais ops:* ────────────────────────────────────────────────────
export type KillSignal = 'SIGTERM' | 'SIGINT' | 'SIGKILL'

export interface ProcRow {
  pid: number
  ppid: number
  user: string
  cpu: number
  mem: number
  /** KiB residentes */
  rssKb: number
  elapsed: string
  name: string
  args: string
  /** categoria heurística: node, python, hermes, claude, ollama, docker, dev */
  kind: string
  /** processo do próprio app (ou filho dele, ex.: hermes serve do cockpit) */
  own: boolean
}

export interface AppRow {
  name: string
  pid?: number
}

export interface AppsResult {
  apps: AppRow[]
  error?: string
}

export interface RepoBranch {
  name: string
  upstream?: string
  current: boolean
  when?: string
}

export interface RepoWorktree {
  path: string
  branch?: string
  head?: string
  bare?: boolean
}

export interface RepoCommit {
  hash: string
  subject: string
  when: string
  author: string
}

export interface RepoDetail {
  path: string
  branches: RepoBranch[]
  remotes: { name: string; url: string }[]
  worktrees: RepoWorktree[]
  commits: RepoCommit[]
  status: string[]
}

export interface ContainerRow {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string
  created?: string
}

export type ContainersResult =
  | { daemon: true; containers: ContainerRow[] }
  | { daemon: false; installed: boolean; error: string }

export type ContainerAction = 'start' | 'stop' | 'restart' | 'rm' | 'logs'

export interface OllamaModel {
  name: string
  size: number
  family?: string
  parameterSize?: string
  quantization?: string
  contextLength?: number
  capabilities?: string[]
  modifiedAt?: string
  /** carregado na memória (api/ps) */
  loaded: boolean
  vram?: number
  expiresAt?: string
}

export type ModelsResult =
  | { running: true; version?: string; models: OllamaModel[]; pulling: string[] }
  | { running: false; installed: boolean; error: string; models: []; pulling: string[] }

export interface PullProgress {
  name: string
  status: string
  completed?: number
  total?: number
  done?: boolean
  error?: string
}

// ─── sistema (espelho de src/main/metrics.ts) ───────────────────────────────

export interface CpuInfo {
  /** modelo do processador (sysctl no macOS, os.cpus() nos demais) */
  model: string
  cores: number
  /** uso total, 0–100 (diferença entre duas leituras de os.cpus()) */
  pct: number
  /** uso por núcleo, mesma janela de amostragem */
  perCore: number[]
  speedMhz?: number
  /** janela real da amostragem, em ms */
  sampleMs?: number
}

export interface MemInfo {
  total: number
  used: number
  free: number
  pct: number
  /** 'vm_stat' | '/proc/meminfo' | 'os.freemem' — de onde veio o "usado" */
  source: string
}

export interface VolumeInfo {
  /** 'C:' no Windows, ponto de montagem no POSIX */
  id: string
  label?: string
  fs?: string
  total: number
  used: number
  free: number
  pct: number
}

export interface GpuInfo {
  name: string
  /** uso 0–100; ausente quando a plataforma não expõe de forma barata */
  pct?: number
  vramUsed?: number
  vramTotal?: number
  /** 'nvidia-smi' | 'GPU Engine (engtype_3D)' | 'Win32_VideoController' | 'sysctl' */
  source: string
}

export interface SystemInfo {
  platform: string
  hostname: string
  /** ex.: 'Windows 11 Pro 26200', 'macOS 15.1' */
  osVersion: string
  osDetail?: string
  uptimeSec: number
  /** null no Windows (não existe load average) */
  load: [number, number, number] | null
  cpu: CpuInfo
  mem: MemInfo
  volumes: VolumeInfo[]
  /** motivo de a lista estar incompleta (fallback para o volume do HOME) */
  volumesError?: string
  /** id do volume do sistema ('C:' / '/') */
  primaryVolume?: string
  gpus: GpuInfo[]
  /** uso 3D somado, quando há vários adaptadores e não dá para atribuir */
  gpu3dPct?: number
  gpuError?: string
}

// ─── wrappers ───────────────────────────────────────────────────────────────
export const ops = {
  ports: () => invoke<PortRow[]>('ops:ports'),
  kill: (pid: number, signal?: KillSignal) => invoke<void>('ops:kill', pid, signal),
  processes: () => invoke<ProcRow[]>('ops:processes'),
  apps: () => invoke<AppsResult>('ops:apps'),
  quitApp: (name: string) => invoke<void>('ops:quitApp', name),
  repos: (force = false) => invoke<RepoRow[]>('ops:repos', { force }),
  repo: (path: string) => invoke<RepoDetail>('ops:repo', path),
  open: (target: OpenTarget) => invoke<void>('ops:open', target),
  containers: () => invoke<ContainersResult>('ops:containers'),
  container: (action: ContainerAction, id: string) => invoke<string | void>('ops:container', action, id),
  models: () => invoke<ModelsResult>('ops:models'),
  modelPull: (name: string) => invoke<void>('ops:modelPull', name),
  modelPullCancel: (name: string) => invoke<void>('ops:modelPullCancel', name),
  modelRm: (name: string) => invoke<void>('ops:modelRm', name),
  modelUnload: (name: string) => invoke<void>('ops:modelUnload', name),
  screenshot: () => invoke<Screenshot>('ops:screenshot'),
  system: () => invoke<SystemInfo>('ops:system'),
  onPullProgress: (fn: (p: PullProgress) => void) => onMain<PullProgress>('ops:pull-progress', fn),
}

// ─── formatação ─────────────────────────────────────────────────────────────
// fmtBytes/fmtUptime moram em lib/fmt.ts (puro, sem IPC) para que módulos
// testáveis em node:test possam usá-los sem arrastar o IPC junto.
export { fmtBytes, fmtUptime } from './fmt'

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // ipcRenderer.invoke prefixa "Error invoking remote method 'x': Error: ..."
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
