// Métricas de sistema do host — CPU, RAM, volumes, GPU, uptime e nome do SO —
// em macOS, Windows e Linux. Vive fora de ./ipc/ops.ts e NÃO importa Electron
// de propósito: dá para rodar/validar em Node puro (`node --test`, probes).
//
// Regras (as mesmas do domínio ops):
// - só execFile, nunca shell com string montada de entrada do usuário;
// - timeout em tudo; `windowsHide: true` (senão pisca console no Windows);
// - nada bloqueante no main: só I/O assíncrono e timers;
// - PowerShell é caro (~300–800 ms): UM processo por coleta, saída em JSON,
//   com cache curto (uso de GPU) e longo (rótulos de volume, adaptadores);
// - fonte que falha vira mensagem honesta no payload, nunca exceção que
//   derrube a coleta inteira.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, statfs } from 'node:fs/promises'
import { cpus, freemem, hostname, loadavg, release, totalmem, uptime } from 'node:os'
import { basename, join } from 'node:path'
import { IS_MAC, IS_WIN, findOnPath } from './platform.ts'
import type { CpuInfo, GpuInfo, MemInfo, SystemInfo, VolumeInfo } from '../renderer/src/lib/ops'

const IS_LINUX = process.platform === 'linux'

// ─── utilidades ─────────────────────────────────────────────────────────────

interface RunResult {
  stdout: string
  code: number
  /** binário ausente ou tempo esgotado */
  failed?: string
}

/** execFile que nunca rejeita (exit ≠ 0 é informação, não exceção). */
function run(cmd: string, args: string[], timeout = 5000): Promise<RunResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE // gotcha §3.1 do HANDOFF: filho viraria Node puro
    execFile(cmd, args, { timeout, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null
      resolve({
        stdout: String(stdout ?? ''),
        code: typeof e?.code === 'number' ? e.code : e ? 1 : 0,
        failed:
          e?.code === 'ENOENT'
            ? `${basename(cmd)}: não encontrado`
            : e?.killed
              ? `${basename(cmd)}: tempo esgotado`
              : undefined,
      })
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const clampPct = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0)
const round1 = (n: number): number => Math.round(n * 10) / 10
const pctOf = (used: number, total: number): number => (total > 0 ? round1(clampPct((used / total) * 100)) : 0)

/** Memoiza `fn` por `ttlMs`, com deduplicação de chamadas simultâneas. */
function cached<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
  let at = 0
  let value: T | undefined
  let inflight: Promise<T> | null = null
  return () => {
    if (value !== undefined && Date.now() - at < ttlMs) return Promise.resolve(value)
    if (inflight) return inflight
    inflight = fn().then(
      (v) => {
        value = v
        at = Date.now()
        inflight = null
        return v
      },
      (e: unknown) => {
        inflight = null
        throw e
      },
    )
    return inflight
  }
}

const FOREVER = 365 * 24 * 3600_000

// ─── PowerShell: uma coleta por chamada, JSON na saída ──────────────────────

/** powershell.exe do sistema (caminho absoluto quando existe). */
function powershell(): string {
  const p = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(p) ? p : 'powershell.exe'
}

interface WinPsDisk {
  id: string
  label: string
  fs: string
  size: number
  free: number
}
interface WinPsGpu {
  name: string
  vram: number
  driver: string
}
interface WinPs {
  disks: WinPsDisk[]
  gpus: WinPsGpu[]
  /** soma de `\GPU Engine(*engtype_3D)\Utilization Percentage`; ausente se os contadores não existem */
  gpuPct?: number
  /** quantos adaptadores (LUIDs) apareceram nos contadores */
  gpuLuids?: number
}

// Script fixo (nada vem do usuário). Só aspas simples: assim o -EncodedCommand
// abaixo não precisa escapar nada e o Windows não reinterpreta a linha.
const PS_BASE = `
$ErrorActionPreference='SilentlyContinue'
try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}
$disks=@()
foreach($d in Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'){
  $disks += [pscustomobject]@{ id=[string]$d.DeviceID; label=[string]$d.VolumeName; fs=[string]$d.FileSystem; size=[double]$d.Size; free=[double]$d.FreeSpace }
}
$vram=@{}
foreach($k in Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'){
  $p=Get-ItemProperty $k.PSPath
  if($p -and $p.DriverDesc){
    $q=$p.'HardwareInformation.qwMemorySize'
    if($q){ $vram[[string]$p.DriverDesc]=[double]$q }
  }
}
$gpus=@()
foreach($v in Get-CimInstance Win32_VideoController){
  $n=[string]$v.Name
  $m=0.0
  if($vram.ContainsKey($n)){ $m=[double]$vram[$n] } elseif($v.AdapterRAM){ $m=[double]$v.AdapterRAM }
  $gpus += [pscustomobject]@{ name=$n; vram=$m; driver=[string]$v.DriverVersion }
}
`.trim()

// Uso de GPU: um instante dos contadores formatados (mais barato que
// Get-Counter). Soma por LUID = adaptador; o total pode passar de 100 quando
// há vários engines ativos, então quem consome limita.
const PS_GPU = `
$byl=@{}
foreach($e in Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine){
  if($e.Name -notlike '*engtype_3D*'){ continue }
  $parts=[string]$e.Name -split '_luid_'
  if($parts.Count -lt 2){ continue }
  $luid=($parts[1] -split '_phys_')[0]
  $byl[$luid]=[double]$byl[$luid]+[double]$e.UtilizationPercentage
}
$tot=0.0
foreach($v in $byl.Values){ $tot=$tot+$v }
$gpuPct=[math]::Round($tot,1)
$gpuLuids=$byl.Count
`.trim()

const PS_TAIL = `
[pscustomobject]@{ disks=$disks; gpus=$gpus; gpuPct=$gpuPct; gpuLuids=$gpuLuids } | ConvertTo-Json -Depth 4 -Compress
`.trim()

let psCache: { at: number; value: WinPs; withGpuPct: boolean } | null = null
let psInflight: Promise<WinPs> | null = null

/**
 * Uma única coleta PowerShell por chamada. `wantGpuPct` acrescenta os
 * contadores de GPU Engine (≈400 ms extra) — só vale quando não há nvidia-smi.
 * Cache: 60 s para a parte estática (rótulos, adaptadores), 3 s quando o uso
 * de GPU vem daqui.
 */
export async function winPs(wantGpuPct = false): Promise<WinPs> {
  const ttl = wantGpuPct ? 3000 : 60_000
  const c = psCache
  if (c && Date.now() - c.at < ttl && (!wantGpuPct || c.withGpuPct)) return c.value
  if (psInflight) return psInflight
  const script = wantGpuPct ? `${PS_BASE}\n${PS_GPU}\n${PS_TAIL}` : `${PS_BASE}\n${PS_TAIL}`
  psInflight = (async () => {
    const r = await run(
      powershell(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      // Os contadores de GPU Engine são caros a frio (medido: 0,5 s quente,
      // ~8 s na primeira consulta com a máquina sob carga) — folga generosa.
      wantGpuPct ? 20_000 : 8000,
    )
    if (r.failed) throw new Error(r.failed)
    const raw = r.stdout.trim()
    if (!raw) throw new Error('powershell: saída vazia')
    const j = JSON.parse(raw) as Record<string, unknown>
    const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]) // ConvertTo-Json: 1 item ≠ array
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    const value: WinPs = {
      disks: arr(j.disks).map((d) => {
        const o = d as Record<string, unknown>
        return { id: str(o.id), label: str(o.label), fs: str(o.fs), size: num(o.size), free: num(o.free) }
      }),
      gpus: arr(j.gpus).map((g) => {
        const o = g as Record<string, unknown>
        return { name: str(o.name), vram: num(o.vram), driver: str(o.driver) }
      }),
      gpuPct: typeof j.gpuPct === 'number' ? j.gpuPct : undefined,
      gpuLuids: typeof j.gpuLuids === 'number' ? j.gpuLuids : undefined,
    }
    psCache = { at: Date.now(), value, withGpuPct: wantGpuPct }
    return value
  })()
  try {
    return await psInflight
  } finally {
    psInflight = null
  }
}

// ─── CPU ────────────────────────────────────────────────────────────────────

interface CpuSnap {
  at: number
  per: { idle: number; total: number }[]
}

function cpuSnap(): CpuSnap {
  return {
    at: Date.now(),
    per: cpus().map((c) => {
      const t = c.times
      return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq }
    }),
  }
}

let prevCpu: CpuSnap | null = null

const cpuModel = cached(FOREVER, async (): Promise<string> => {
  const fallback = cpus()[0]?.model?.trim() || process.arch
  if (IS_MAC) {
    const r = await run('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], 3000)
    return r.stdout.trim() || fallback
  }
  return fallback
})

/**
 * Uso de CPU por diferença entre duas leituras de os.cpus() (funciona em todo
 * SO, sem processo externo). Reaproveita a leitura da coleta anterior quando
 * ela tem entre 0,6 s e 60 s — a janela passa a ser o intervalo de polling, o
 * que suaviza o número e evita o sleep. Fora disso, amostra na hora.
 */
async function cpuInfo(): Promise<CpuInfo> {
  let a = prevCpu
  const age = a ? Date.now() - a.at : Infinity
  if (!a || age < 600 || age > 60_000) {
    a = cpuSnap()
    await sleep(320)
  }
  const b = cpuSnap()
  prevCpu = b
  const list = cpus()
  const n = Math.min(a.per.length, b.per.length)
  const perCore: number[] = []
  let idle = 0
  let total = 0
  for (let i = 0; i < n; i++) {
    const di = b.per[i].idle - a.per[i].idle
    const dt = b.per[i].total - a.per[i].total
    idle += di
    total += dt
    perCore.push(round1(clampPct(dt > 0 ? (1 - di / dt) * 100 : 0)))
  }
  return {
    model: await cpuModel(),
    cores: list.length,
    pct: round1(clampPct(total > 0 ? (1 - idle / total) * 100 : 0)),
    perCore,
    speedMhz: list[0]?.speed || undefined,
    sampleMs: b.at - a.at,
  }
}

// ─── RAM ────────────────────────────────────────────────────────────────────

/**
 * No Windows e no macOS os.totalmem/freemem bastam — com a ressalva de que no
 * macOS freemem() ignora cache/inativa, então vm_stat dá a visão do Monitor de
 * Atividade. No Linux freemem() é MemFree (não conta cache reclamável):
 * MemAvailable do /proc/meminfo é o número honesto.
 */
async function memInfo(): Promise<MemInfo> {
  const total = totalmem()
  const fin = (used: number, source: string): MemInfo => {
    const u = Math.max(0, Math.min(total, used))
    return { total, used: u, free: total - u, pct: pctOf(u, total), source }
  }
  if (IS_MAC) {
    const r = await run('/usr/bin/vm_stat', [], 3000)
    if (!r.failed && r.code === 0) {
      const page = Number(r.stdout.match(/page size of (\d+)/)?.[1] ?? 16384)
      const get = (k: string): number => Number(r.stdout.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] ?? 0)
      const used = (get('Pages active') + get('Pages wired down') + get('Pages occupied by compressor')) * page
      if (used > 0) return fin(used, 'vm_stat')
    }
  }
  if (IS_LINUX) {
    try {
      const txt = await readFile('/proc/meminfo', 'utf8')
      const kb = Number(txt.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1] ?? 0)
      if (kb > 0) return fin(total - kb * 1024, '/proc/meminfo')
    } catch {
      /* sem /proc: cai no os.freemem() */
    }
  }
  return fin(total - freemem(), 'os.freemem')
}

// ─── volumes ────────────────────────────────────────────────────────────────

const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']

/**
 * Windows: statfs por unidade (Node ≥18.15; ~3 ms, sem processo) para os
 * números ao vivo; rótulo/sistema de arquivos e a lista de discos FIXOS
 * (DriveType=3) vêm do PowerShell com cache de 60 s. Sem PowerShell, varre as
 * letras que existem — inclui removível/rede, mas é melhor que nada.
 */
async function winVolumes(): Promise<VolumeInfo[]> {
  const meta = new Map<string, WinPsDisk>()
  try {
    for (const d of (await winPs()).disks) if (d.id) meta.set(d.id.toUpperCase(), d)
  } catch {
    /* sem PowerShell: segue só com statfs */
  }
  const ids = meta.size ? [...meta.keys()] : LETTERS.map((L) => `${L}:`).filter((id) => existsSync(`${id}\\`))
  const out: VolumeInfo[] = []
  await Promise.all(
    ids.map(async (id) => {
      const m = meta.get(id)
      let total = 0
      let free = 0
      try {
        const s = await statfs(`${id}\\`)
        total = Number(s.blocks) * Number(s.bsize)
        free = Number(s.bavail) * Number(s.bsize)
      } catch {
        total = m?.size ?? 0 // unidade sem mídia: usa o que o CIM disse
        free = m?.free ?? 0
      }
      if (total <= 0) return
      out.push({
        id,
        label: m?.label || undefined,
        fs: m?.fs || undefined,
        total,
        used: total - free,
        free,
        pct: pctOf(total - free, total),
      })
    }),
  )
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * macOS/Linux: `df -P -k` (formato POSIX, 6 colunas nos dois). Só sistemas de
 * arquivos de dispositivo de bloco. No macOS o volume de dados aparece em
 * /System/Volumes/Data com o mesmo container de "/": ficamos com "/" e os
 * /Volumes/*, e "usado" é total − disponível (é o que o Finder mostra; a
 * coluna Used do df conta só o snapshot do sistema).
 */
async function posixVolumes(): Promise<VolumeInfo[]> {
  const df = ['/bin/df', '/usr/bin/df'].find((p) => existsSync(p)) ?? findOnPath('df')
  if (!df) throw new Error('df não encontrado')
  const r = await run(df, ['-P', '-k'], 5000)
  if (r.failed) throw new Error(r.failed)
  const out: VolumeInfo[] = []
  const seen = new Set<string>()
  for (const line of r.stdout.split('\n').slice(1)) {
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+?)\s*$/)
    if (!m) continue
    const [, fs, blocks, , avail, , mount] = m
    if (!fs.startsWith('/dev/')) continue
    if (IS_MAC && !(mount === '/' || mount.startsWith('/Volumes/'))) continue
    if (IS_LINUX && /^\/(snap|boot\/efi)(\/|$)/.test(mount)) continue
    if (seen.has(mount)) continue
    seen.add(mount)
    const total = Number(blocks) * 1024
    const free = Number(avail) * 1024
    if (total <= 0) continue
    out.push({
      id: mount,
      label: mount === '/' ? 'raiz' : basename(mount),
      fs,
      total,
      used: total - free,
      free,
      pct: pctOf(total - free, total),
    })
  }
  if (!out.length) throw new Error('df não devolveu volumes locais')
  return out
}

/** Último recurso: só o volume do HOME, via statfs. */
async function homeVolume(home: string): Promise<VolumeInfo[]> {
  const s = await statfs(home)
  const total = Number(s.blocks) * Number(s.bsize)
  const free = Number(s.bavail) * Number(s.bsize)
  if (total <= 0) return []
  return [{ id: IS_WIN ? home.slice(0, 2).toUpperCase() : '/', total, used: total - free, free, pct: pctOf(total - free, total) }]
}

// ─── GPU ────────────────────────────────────────────────────────────────────

const nvidiaSmi = (): string | null => {
  const candidates = IS_WIN
    ? [
        join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
        join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
      ]
    : ['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi', '/opt/nvidia/bin/nvidia-smi']
  return candidates.find((p) => existsSync(p)) ?? findOnPath(IS_WIN ? 'nvidia-smi.exe' : 'nvidia-smi')
}

let smiPath: string | null | undefined

/** nvidia-smi CSV: name, utilization.gpu, memory.used, memory.total (MiB). */
async function nvidiaGpus(): Promise<GpuInfo[]> {
  if (smiPath === undefined) smiPath = nvidiaSmi()
  if (!smiPath) return []
  const r = await run(smiPath, ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], 5000)
  if (r.failed || r.code !== 0) return []
  const out: GpuInfo[] = []
  for (const line of r.stdout.split('\n')) {
    const f = line.split(',').map((x) => x.trim())
    if (f.length < 4 || !f[0]) continue
    const n = (v: string): number | undefined => {
      const x = Number(v)
      return Number.isFinite(x) ? x : undefined // "[N/A]" em GPU sem suporte
    }
    const used = n(f[2])
    const total = n(f[3])
    const pct = n(f[1])
    out.push({
      name: f[0],
      pct: pct == null ? undefined : round1(clampPct(pct)),
      vramUsed: used == null ? undefined : used * 1024 * 1024,
      vramTotal: total == null ? undefined : total * 1024 * 1024,
      source: 'nvidia-smi',
    })
  }
  return out
}

interface GpuResult {
  gpus: GpuInfo[]
  /** uso 3D somado quando não é atribuível a um adaptador específico */
  gpu3dPct?: number
  error?: string
}

const sameGpu = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

async function collectGpu(): Promise<GpuResult> {
  const nv = await nvidiaGpus()
  if (nv.length) {
    if (!IS_WIN) return { gpus: nv }
    // Acrescenta adaptadores que o nvidia-smi não vê (iGPU), sem inventar uso.
    try {
      const ps = await winPs()
      for (const g of ps.gpus) {
        if (!g.name || nv.some((x) => sameGpu(x.name, g.name))) continue
        nv.push({ name: g.name, vramTotal: g.vram || undefined, source: 'Win32_VideoController' })
      }
    } catch {
      /* sem PowerShell: fica só o que o nvidia-smi devolveu */
    }
    return { gpus: nv }
  }
  if (IS_WIN) {
    const ps = await winPs(true)
    const gpus: GpuInfo[] = ps.gpus
      .filter((g) => g.name)
      .map((g) => ({ name: g.name, vramTotal: g.vram || undefined, source: 'Win32_VideoController' }))
    if (!gpus.length) return { gpus: [], error: 'nenhum adaptador em Win32_VideoController' }
    const pct = ps.gpuPct == null ? undefined : round1(clampPct(ps.gpuPct))
    // Win32_VideoController não expõe LUID: só dá para atribuir o uso quando há
    // um adaptador só. Com vários, o total vai separado e rotulado como tal.
    if (gpus.length === 1 && pct != null) gpus[0] = { ...gpus[0], pct, source: 'GPU Engine (engtype_3D)' }
    return {
      gpus,
      gpu3dPct: gpus.length > 1 ? pct : undefined,
      error: pct == null ? 'uso de GPU indisponível (contadores GPU Engine ausentes)' : undefined,
    }
  }
  if (IS_MAC) {
    const r = await run('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], 3000)
    const chip = r.stdout.trim()
    const gpus: GpuInfo[] = /^Apple /.test(chip) ? [{ name: `${chip} (GPU integrada)`, source: 'sysctl' }] : []
    return { gpus, error: 'uso de GPU indisponível no macOS (exigiria powermetrics como root)' }
  }
  return { gpus: [], error: 'uso de GPU indisponível (sem nvidia-smi)' }
}

let gpuCache: { at: number; value: GpuResult; ttl: number } | null = null
let gpuInflight: Promise<GpuResult> | null = null

/**
 * Cache com TTL por fonte: nvidia-smi é barato (~200 ms) e pode acompanhar o
 * polling; o fallback por contadores do PowerShell custa 0,5–3 s, então vale
 * no máximo uma coleta a cada 6 s. Onde não há uso de GPU, 30 s (só o nome
 * muda, e nem isso).
 */
function gpuInfo(): Promise<GpuResult> {
  if (gpuCache && Date.now() - gpuCache.at < gpuCache.ttl) return Promise.resolve(gpuCache.value)
  if (gpuInflight) return gpuInflight
  gpuInflight = collectGpu().then(
    (v) => {
      const live = v.gpus.some((g) => g.pct != null) || v.gpu3dPct != null
      const ttl = v.gpus.some((g) => g.source === 'nvidia-smi') ? 2500 : live ? 6000 : 30_000
      gpuCache = { at: Date.now(), value: v, ttl }
      gpuInflight = null
      return v
    },
    (e: unknown) => {
      gpuInflight = null
      throw e
    },
  )
  return gpuInflight
}

// ─── SO ─────────────────────────────────────────────────────────────────────

const osName = cached(FOREVER, async (): Promise<{ osVersion: string; osDetail?: string }> => {
  if (IS_WIN) {
    // reg.exe é ~10x mais barato que o CIM e a chave não muda em execução.
    const reg = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
    const r = await run(existsSync(reg) ? reg : 'reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'], 5000)
    const get = (k: string): string => r.stdout.match(new RegExp(`^\\s+${k}\\s+REG_\\w+\\s+(.*)$`, 'm'))?.[1]?.trim() ?? ''
    const build = Number(get('CurrentBuild')) || 0
    // ProductName ficou congelado em "Windows 10 ..." no Windows 11.
    let product = get('ProductName') || `Windows ${release()}`
    if (build >= 22000) product = product.replace(/\bWindows 10\b/, 'Windows 11')
    const ubrRaw = get('UBR')
    const ubr = ubrRaw.startsWith('0x') ? parseInt(ubrRaw, 16) : Number(ubrRaw) || 0
    const detail = [get('DisplayVersion'), build ? `build ${build}${ubr ? `.${ubr}` : ''}` : '', process.arch].filter(Boolean)
    return { osVersion: build ? `${product} ${build}` : product, osDetail: detail.join(' · ') || undefined }
  }
  if (IS_MAC) {
    const [ver, name] = await Promise.all([
      run('/usr/bin/sw_vers', ['-productVersion'], 3000),
      run('/usr/bin/sw_vers', ['-buildVersion'], 3000),
    ])
    const v = ver.stdout.trim()
    return { osVersion: v ? `macOS ${v}` : `macOS ${release()}`, osDetail: [name.stdout.trim(), process.arch].filter(Boolean).join(' · ') || undefined }
  }
  try {
    const txt = await readFile('/etc/os-release', 'utf8')
    const pretty = txt.match(/^PRETTY_NAME="?(.+?)"?$/m)?.[1]
    if (pretty) return { osVersion: pretty, osDetail: `${release()} · ${process.arch}` }
  } catch {
    /* sem /etc/os-release */
  }
  return { osVersion: `Linux ${release()}`, osDetail: process.arch }
})

// ─── coleta ─────────────────────────────────────────────────────────────────

async function volumes(home: string): Promise<{ volumes: VolumeInfo[]; volumesError?: string }> {
  try {
    const v = IS_WIN ? await winVolumes() : await posixVolumes()
    if (v.length) return { volumes: v }
    throw new Error('nenhum volume local encontrado')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      return { volumes: await homeVolume(home), volumesError: msg }
    } catch {
      return { volumes: [], volumesError: msg }
    }
  }
}

/** Volume "principal": o do sistema (C: no Windows, / no POSIX). */
function primaryId(): string {
  return IS_WIN ? (process.env.SystemDrive || 'C:').toUpperCase() : '/'
}

async function collect(home: string): Promise<SystemInfo> {
  const [cpu, mem, vol, gpu, os] = await Promise.all([
    cpuInfo(),
    memInfo(),
    volumes(home),
    gpuInfo().catch((e: unknown) => ({ gpus: [] as GpuInfo[], error: e instanceof Error ? e.message : String(e) })),
    osName().catch(() => ({ osVersion: `${process.platform} ${release()}`, osDetail: undefined })),
  ])
  const prim = vol.volumes.find((v) => v.id === primaryId()) ?? vol.volumes[0] ?? null
  const l = loadavg()
  return {
    platform: process.platform,
    hostname: hostname(),
    osVersion: os.osVersion,
    osDetail: os.osDetail,
    uptimeSec: uptime(),
    // loadavg() é sempre [0,0,0] no Windows — melhor não mostrar do que mentir.
    load: IS_WIN ? null : [l[0], l[1], l[2]],
    cpu,
    mem,
    volumes: vol.volumes,
    volumesError: vol.volumesError,
    primaryVolume: prim?.id,
    gpus: gpu.gpus,
    gpu3dPct: 'gpu3dPct' in gpu ? gpu.gpu3dPct : undefined,
    gpuError: gpu.error,
  }
}

let sysCache: { at: number; value: SystemInfo } | null = null
let sysInflight: Promise<SystemInfo> | null = null

/**
 * Coleta completa, com throttle de 2 s + deduplicação: vários painéis podem
 * pedir ao mesmo tempo (card da Ops, seção Sistema, widget) sem multiplicar
 * processos.
 */
export async function systemInfo(home: string): Promise<SystemInfo> {
  if (sysCache && Date.now() - sysCache.at < 2000) return sysCache.value
  if (sysInflight) return sysInflight
  sysInflight = collect(home).then(
    (v) => {
      sysCache = { at: Date.now(), value: v }
      sysInflight = null
      return v
    },
    (e: unknown) => {
      sysInflight = null
      throw e
    },
  )
  return sysInflight
}

/** Só para testes/probes: zera os caches entre cenários. */
export function resetMetricsCache(): void {
  sysCache = null
  psCache = null
  gpuCache = null
  prevCpu = null
}
