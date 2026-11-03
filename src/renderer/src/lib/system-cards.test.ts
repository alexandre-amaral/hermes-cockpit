// Modelo dos cartões de recurso do host (ver system-cards.ts). Puro: sem DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemInfo } from './ops.ts'
import { systemCards, volumeLabel } from './system-cards.ts'

const GB = 1024 ** 3

const sys = (over: Partial<SystemInfo> = {}): SystemInfo => ({
  platform: 'win32',
  hostname: 'test-host',
  osVersion: 'Windows 11 Pro',
  uptimeSec: 3600,
  load: null,
  cpu: { model: 'Generic CPU Model X1', cores: 6, pct: 68, perCore: [], speedMhz: 2900 },
  mem: { total: 16 * GB, used: 8.4 * GB, free: 7.6 * GB, pct: 53, source: 'os.freemem' },
  volumes: [
    { id: 'D:', label: 'INTEL', total: 919 * GB, used: 845 * GB, free: 74 * GB, pct: 92 },
    { id: 'C:', total: 465 * GB, used: 453 * GB, free: 12 * GB, pct: 97 },
  ],
  primaryVolume: 'C:',
  gpus: [],
  ...over,
})

test('ordem: CPU, RAM, GPU, volumes com o do sistema na frente', () => {
  const cards = systemCards(sys({ gpus: [{ name: 'GTX 1650', pct: 12, source: 'nvidia-smi' }] }))
  assert.deepEqual(
    cards.map((c) => c.key),
    ['cpu', 'ram', 'gpu', 'vol:C:', 'vol:D:'],
  )
})

test('sem GPU detectada o cartão some (nada inventado)', () => {
  assert.deepEqual(
    systemCards(sys()).map((c) => c.key),
    ['cpu', 'ram', 'vol:C:', 'vol:D:'],
  )
})

test('volume mostra USADO / total, com o livre na linha secundária', () => {
  const c = systemCards(sys()).find((x) => x.key === 'vol:C:')!
  assert.equal(c.label, 'C: sistema')
  assert.equal(c.detail, '453 GB / 465 GB')
  assert.equal(c.sub, '12.0 GB livres')
  assert.equal(c.tone, 'alert') // 97%
})

test('RAM: usado / total + livres; CPU: modelo embaixo', () => {
  const [cpu, ram] = systemCards(sys())
  assert.equal(cpu.detail, 'Generic CPU Model X1')
  assert.equal(cpu.sub, '6 núcleos @ 2.90 GHz')
  assert.equal(cpu.tone, 'phos') // 68%
  assert.equal(ram.detail, '8.4 GB / 16.0 GB')
  assert.equal(ram.sub, '7.6 GB livres')
})

test('GPU sem % cai no 3D somado; sem nenhum dos dois o tom é informativo', () => {
  const soma = systemCards(sys({ gpus: [{ name: 'UHD 630', source: 'Win32_VideoController' }], gpu3dPct: 41 }))
  const g1 = soma.find((c) => c.key === 'gpu')!
  assert.equal(g1.pct, 41)
  assert.equal(g1.tone, 'phos')

  const semUso = systemCards(sys({ gpus: [{ name: 'UHD 630', vramTotal: 2 * GB, source: 'Win32_VideoController' }] }))
  const g2 = semUso.find((c) => c.key === 'gpu')!
  assert.equal(g2.pct, null)
  assert.equal(g2.tone, 'amber') // informativo (accent do tema)
  assert.equal(g2.sub, 'vram 2.0 GB')
})

test('rótulo de volume: sistema, rótulo do SO ou só o id', () => {
  assert.equal(volumeLabel({ id: 'C:', total: 1, used: 0, free: 1, pct: 0 }, 'C:'), 'C: sistema')
  assert.equal(volumeLabel({ id: 'E:', label: 'Reservado pelo Sistema', total: 1, used: 0, free: 1, pct: 0 }, 'C:'), 'E: Reservado pelo Sistema')
  assert.equal(volumeLabel({ id: '/data', total: 1, used: 0, free: 1, pct: 0 }, '/'), '/data')
})
