// Coleta de métricas do host (ver src/main/metrics.ts). Roda com
// `node --test src/main/metrics.test.ts` — sem Electron: o módulo é puro
// Node (os/fs + execFile). Os testes valem em macOS, Windows e Linux: checam
// a coerência do payload na máquina que estiver rodando, não valores fixos.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { resetMetricsCache, systemInfo } from './metrics.ts'

const HOME = homedir()
const pct = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 100

test('identificação do host', async () => {
  resetMetricsCache()
  const s = await systemInfo(HOME)
  assert.equal(s.platform, process.platform)
  assert.ok(s.hostname.length > 0, 'hostname vazio')
  assert.ok(s.osVersion.trim().length > 0, 'osVersion vazio')
  assert.ok(s.uptimeSec > 0, 'uptime deve ser positivo')
  // loadavg() é sempre [0,0,0] no Windows: o payload traz null em vez de mentir.
  if (process.platform === 'win32') assert.equal(s.load, null)
  else assert.equal(s.load?.length, 3)
})

test('CPU: modelo, núcleos e uso 0–100 (total e por núcleo)', async () => {
  resetMetricsCache()
  const s = await systemInfo(HOME)
  assert.ok(s.cpu.model.length > 0, 'modelo de CPU vazio')
  assert.ok(s.cpu.cores >= 1)
  assert.ok(pct(s.cpu.pct), `uso fora de 0–100: ${s.cpu.pct}`)
  assert.equal(s.cpu.perCore.length, s.cpu.cores)
  for (const p of s.cpu.perCore) assert.ok(pct(p), `núcleo fora de 0–100: ${p}`)
  assert.ok((s.cpu.sampleMs ?? 0) > 0, 'janela de amostragem não registrada')
})

test('RAM: usada + livre = total e % coerente', async () => {
  resetMetricsCache()
  const s = await systemInfo(HOME)
  const m = s.mem
  assert.ok(m.total > 0)
  assert.equal(m.used + m.free, m.total)
  assert.ok(pct(m.pct))
  assert.ok(Math.abs(m.pct - (m.used / m.total) * 100) < 0.2, 'pct não bate com used/total')
  assert.ok(m.source.length > 0)
})

test('volumes: pelo menos um, com total/usado/livre coerentes', async () => {
  resetMetricsCache()
  const s = await systemInfo(HOME)
  assert.ok(s.volumes.length >= 1, `nenhum volume (${s.volumesError ?? 'sem erro reportado'})`)
  for (const v of s.volumes) {
    assert.ok(v.id.length > 0)
    assert.ok(v.total > 0, `${v.id}: total zerado`)
    assert.equal(v.used + v.free, v.total)
    assert.ok(pct(v.pct))
  }
  // O volume do sistema tem de estar na lista (C: no Windows, / no POSIX).
  if (s.primaryVolume) assert.ok(s.volumes.some((v) => v.id === s.primaryVolume))
})

test('GPU: ou adaptadores coerentes, ou motivo da ausência', async () => {
  resetMetricsCache()
  const s = await systemInfo(HOME)
  assert.ok(s.gpus.length > 0 || typeof s.gpuError === 'string', 'sem GPU e sem explicação')
  for (const g of s.gpus) {
    assert.ok(g.name.length > 0)
    assert.ok(g.source.length > 0)
    if (g.pct != null) assert.ok(pct(g.pct), `uso de GPU fora de 0–100: ${g.pct}`)
    if (g.vramUsed != null && g.vramTotal != null) assert.ok(g.vramUsed <= g.vramTotal * 1.01)
  }
  if (s.gpu3dPct != null) assert.ok(pct(s.gpu3dPct))
})

test('throttle: chamadas seguidas reaproveitam a mesma coleta', async () => {
  resetMetricsCache()
  const a = await systemInfo(HOME)
  const b = await systemInfo(HOME)
  assert.equal(a, b, 'a segunda chamada deveria vir do cache (mesma referência)')
})

test('deduplicação: chamadas simultâneas viram uma coleta só', async () => {
  resetMetricsCache()
  const [a, b, c] = await Promise.all([systemInfo(HOME), systemInfo(HOME), systemInfo(HOME)])
  assert.equal(a, b)
  assert.equal(b, c)
})
