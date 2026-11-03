// Modelo/formatação de cota do renderer (ver quota-model.ts). Puro: sem DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extraWindows,
  fmtResetLong,
  fmtResetParts,
  kindFromLabel,
  mergeProviders,
  pctTone,
  providersFromPlugin,
  snapshotWorstPct,
  windowOf,
  worstPct,
  type ProviderQuota,
} from './quota-model.ts'

const prov = (over: Partial<ProviderQuota> = {}): ProviderQuota => ({
  provider: 'claude',
  label: 'Claude',
  plan: 'Max 5x',
  windows: [],
  source: 'teste',
  asOf: null,
  error: null,
  note: null,
  ...over,
})

test('pctTone usa os limiares do app (80 aviso, 90 alerta)', () => {
  assert.equal(pctTone(0), 'accent')
  assert.equal(pctTone(79.9), 'accent')
  assert.equal(pctTone(80), 'warn')
  assert.equal(pctTone(89.9), 'warn')
  assert.equal(pctTone(90), 'alert')
  assert.equal(pctTone(140), 'alert')
  assert.equal(pctTone(null), 'accent')
  assert.equal(pctTone(Number.NaN), 'accent')
})

test('fmtResetParts: relativo e absoluto', () => {
  const now = Date.parse('2026-11-02T18:00:00')
  assert.deepEqual(fmtResetParts(new Date(Date.parse('2026-11-02T20:13:00')).toISOString(), now), { in: '2h 13m', at: 'hoje 20:13' })
  assert.deepEqual(fmtResetParts(new Date(Date.parse('2026-11-02T18:07:00')).toISOString(), now), { in: '7m', at: 'hoje 18:07' })
  assert.deepEqual(fmtResetParts(new Date(Date.parse('2026-11-03T09:00:00')).toISOString(), now), { in: '15h 00m', at: 'amanhã 09:00' })
  // 5 dias à frente: nome do dia da semana
  assert.deepEqual(fmtResetParts(new Date(Date.parse('2026-11-07T09:00:00')).toISOString(), now), { in: '4d 15h', at: 'sáb 09:00' })
  // além de uma semana: data curta
  assert.deepEqual(fmtResetParts(new Date(Date.parse('2026-11-12T09:00:00')).toISOString(), now), { in: '9d 15h', at: '12/11 09:00' })
})

test('fmtResetParts: reset no passado vira "agora"; ausente/ilegível vira null', () => {
  const now = Date.parse('2026-11-02T18:00:00')
  assert.equal(fmtResetParts(new Date(now - 60_000).toISOString(), now)?.in, 'agora')
  assert.equal(fmtResetParts(null, now), null)
  assert.equal(fmtResetParts(undefined, now), null)
  assert.equal(fmtResetParts('depois', now), null)
  assert.equal(fmtResetLong(null, now), null)
  assert.equal(fmtResetLong(new Date(Date.parse('2026-11-02T20:13:00')).toISOString(), now), 'reinicia em 2h 13m · hoje 20:13')
})

test('windowOf / extraWindows separam as duas janelas principais das extras', () => {
  const p = prov({
    windows: [
      { kind: '5h', label: '5 horas', usedPct: 94, resetsAt: null },
      { kind: 'weekly', label: 'semanal', usedPct: 48, resetsAt: null },
      { kind: 'weekly-model', label: 'semanal · Fable', usedPct: 23, resetsAt: null },
      { kind: 'monthly', label: 'créditos extras', usedPct: 2, resetsAt: null },
    ],
  })
  assert.equal(windowOf(p, '5h')?.usedPct, 94)
  assert.equal(windowOf(p, 'weekly')?.usedPct, 48)
  assert.equal(windowOf(p, 'monthly')?.usedPct, 2)
  assert.deepEqual(
    extraWindows(p).map((w) => w.label),
    ['semanal · Fable', 'créditos extras'],
  )
  assert.equal(windowOf(prov(), '5h'), null)
  assert.deepEqual(extraWindows(null), [])
})

test('extraWindows mantém a 2ª janela do mesmo tipo (duplicata não é descartada)', () => {
  const p = prov({
    windows: [
      { kind: 'weekly', label: 'semanal', usedPct: 10, resetsAt: null },
      { kind: 'weekly', label: 'semanal (equipe)', usedPct: 5, resetsAt: null },
    ],
  })
  assert.equal(windowOf(p, 'weekly')?.label, 'semanal')
  assert.deepEqual(
    extraWindows(p).map((w) => w.label),
    ['semanal (equipe)'],
  )
})

test('worstPct / snapshotWorstPct', () => {
  const a = prov({ windows: [{ kind: '5h', label: '5 horas', usedPct: 94, resetsAt: null }] })
  const b = prov({ provider: 'codex', label: 'Codex', windows: [{ kind: 'weekly', label: 'semanal', usedPct: 70, resetsAt: null }] })
  assert.equal(worstPct(a), 94)
  assert.equal(worstPct(prov()), null)
  assert.equal(snapshotWorstPct([a, b]), 94)
  assert.equal(snapshotWorstPct([prov()]), null)
  assert.equal(snapshotWorstPct([]), null)
})

test('kindFromLabel mapeia os rótulos do plugin cockpit', () => {
  assert.equal(kindFromLabel('5 horas'), '5h')
  assert.equal(kindFromLabel('sessão'), '5h')
  assert.equal(kindFromLabel('semanal'), 'weekly')
  assert.equal(kindFromLabel('semanal Opus'), 'weekly-model')
  assert.equal(kindFromLabel('mês'), 'monthly')
  assert.equal(kindFromLabel('diária'), 'other')
})

test('providersFromPlugin converte o payload do plugin para o modelo novo', () => {
  const [p] = providersFromPlugin([
    {
      nome: 'Anthropic',
      plano: 'Max',
      aviso: 'estimativa',
      janelas: [
        { nome: 'semanal', pct: 48, reset: '2026-11-07T12:00:00Z' },
        { nome: '5 horas', pct: 94, reset: 1793669383 },
        { nome: 'sem pct' },
      ],
    },
  ])
  assert.equal(p.provider, 'plugin:anthropic')
  assert.equal(p.plan, 'Max')
  assert.equal(p.note, 'estimativa')
  assert.deepEqual(
    p.windows.map((w) => [w.kind, w.usedPct]),
    [
      ['5h', 94],
      ['weekly', 48],
    ],
  )
  assert.equal(p.windows[0].resetsAt, new Date(1793669383_000).toISOString())
  assert.deepEqual(providersFromPlugin(undefined), [])
  // provedor sem janela nenhuma ganha observação honesta
  assert.equal(providersFromPlugin([{ nome: 'X' }])[0].note, 'sem janela de limite informada')
})

test('mergeProviders prefere o coletor do main e não duplica provedor', () => {
  const main = [prov({ windows: [{ kind: '5h', label: '5 horas', usedPct: 94, resetsAt: null }] })]
  const plugin = providersFromPlugin([{ nome: 'claude', janelas: [{ nome: '5 horas', pct: 1 }] }, { nome: 'Nous Portal' }])
  const merged = mergeProviders(main, plugin)
  assert.deepEqual(
    merged.map((p) => [p.label, p.source]),
    [
      ['Claude', 'teste'],
      ['Nous Portal', 'plugin cockpit do Hermes'],
    ],
  )
  // quem tem janela vem primeiro; empate resolve alfabeticamente
  const sorted = mergeProviders(
    [prov({ provider: 'zeta', label: 'Zeta', windows: [{ kind: '5h', label: '5 horas', usedPct: 3, resetsAt: null }] }), prov({ provider: 'alfa', label: 'Alfa' })],
    [],
  )
  assert.deepEqual(
    sorted.map((p) => p.label),
    ['Zeta', 'Alfa'],
  )
})
