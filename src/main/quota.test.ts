// Normalização das respostas de uso dos provedores (ver src/main/quota.ts).
// Roda com `node --test src/main/quota.test.ts` (sem Electron: o módulo é
// fs + fetch puros; os testes aqui não tocam a rede).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  hermesConfiguredProviders,
  latestCodexRollouts,
  normalizeAnthropicUsage,
  normalizeCodexRateLimits,
  readCodexSnapshot,
  scrub,
} from './quota.ts'

// Resposta real de GET /api/oauth/usage (conta Max 5x), reduzida aos campos
// que importam e com os valores trocados por redondos.
const ANTHROPIC_LIVE = {
  five_hour: { utilization: 94.0, resets_at: '2026-11-02T21:30:00.488095+00:00' },
  seven_day: { utilization: 48.0, resets_at: '2026-11-07T12:00:00.488119+00:00' },
  seven_day_opus: null,
  extra_usage: { is_enabled: false, utilization: null },
  limits: [
    { kind: 'session', group: 'session', percent: 94, resets_at: '2026-11-02T21:30:00.488095+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 48, resets_at: '2026-11-07T12:00:00.488119+00:00', scope: null, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 23,
      resets_at: '2026-11-07T12:00:00.488281+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
}

test('Anthropic: limits → 5h, semanal e semanal por modelo, nessa ordem', () => {
  const r = normalizeAnthropicUsage(ANTHROPIC_LIVE, { plan: 'Max 5x' })
  assert.equal(r.provider, 'claude')
  assert.equal(r.plan, 'Max 5x')
  assert.deepEqual(
    r.windows.map((w) => ({ kind: w.kind, label: w.label, usedPct: w.usedPct, resetsAt: w.resetsAt })),
    [
      { kind: '5h', label: '5 horas', usedPct: 94, resetsAt: '2026-11-02T21:30:00.488Z' },
      { kind: 'weekly', label: 'semanal', usedPct: 48, resetsAt: '2026-11-07T12:00:00.488Z' },
      { kind: 'weekly-model', label: 'semanal · Fable', usedPct: 23, resetsAt: '2026-11-07T12:00:00.488Z' },
    ],
  )
  assert.equal(r.windows[0].active, true)
  assert.equal(r.windows[1].active, false)
})

test('Anthropic: sem `limits`, cai para os campos nomeados', () => {
  const r = normalizeAnthropicUsage({
    five_hour: { utilization: 10, resets_at: 1793669383 },
    seven_day: { utilization: 20, resets_at: '2026-11-07T12:00:00Z' },
    seven_day_opus: { utilization: 30, resets_at: null },
    seven_day_sonnet: { utilization: null },
  })
  assert.deepEqual(
    r.windows.map((w) => [w.kind, w.label, w.usedPct]),
    [
      ['5h', '5 horas', 10],
      ['weekly', 'semanal', 20],
      ['weekly-model', 'semanal · Opus', 30],
    ],
  )
  // epoch em segundos vira ISO
  assert.equal(r.windows[0].resetsAt, new Date(1793669383_000).toISOString())
  // janela sem utilization numérica não entra (nada inventado)
  assert.equal(r.windows.length, 3)
})

test('Anthropic: janela sem percent é ignorada; kind desconhecido vira "other"', () => {
  const r = normalizeAnthropicUsage({
    limits: [
      { kind: 'session', percent: null },
      { kind: 'quinzenal', group: 'biweekly', percent: 5, resets_at: null },
    ],
  })
  assert.deepEqual(
    r.windows.map((w) => [w.kind, w.label, w.usedPct, w.resetsAt]),
    [['other', 'quinzenal', 5, null]],
  )
})

test('Anthropic: créditos extras só aparecem quando habilitados', () => {
  const off = normalizeAnthropicUsage({ limits: [], extra_usage: { is_enabled: false, utilization: 42 } })
  assert.equal(off.windows.length, 0)
  const on = normalizeAnthropicUsage({ limits: [], extra_usage: { is_enabled: true, utilization: 42 } })
  assert.deepEqual(
    on.windows.map((w) => [w.kind, w.label, w.usedPct]),
    [['monthly', 'créditos extras', 42]],
  )
})

test('Anthropic: payload inútil não derruba nem inventa janela', () => {
  for (const raw of [null, undefined, 'erro', 42, [], {}]) {
    const r = normalizeAnthropicUsage(raw)
    assert.equal(r.provider, 'claude')
    assert.deepEqual(r.windows, [])
  }
})

// rate_limits real gravado pelo Codex CLI num evento token_count.
const CODEX_LIVE = {
  limit_id: 'codex',
  primary: { used_percent: 69, window_minutes: 300, resets_at: 1793656777 },
  secondary: { used_percent: 70, window_minutes: 10080, resets_at: 1794083513 },
  plan_type: 'plus',
}

test('Codex: primary/secondary → 5h e semanal, com plano capitalizado', () => {
  const r = normalizeCodexRateLimits(CODEX_LIVE, { asOf: '2026-11-02T21:06:56.931Z' })
  assert.equal(r.provider, 'codex')
  assert.equal(r.plan, 'Plus')
  assert.equal(r.asOf, '2026-11-02T21:06:56.931Z')
  assert.deepEqual(
    r.windows.map((w) => ({ kind: w.kind, label: w.label, usedPct: w.usedPct, resetsAt: w.resetsAt })),
    [
      { kind: '5h', label: '5 horas', usedPct: 69, resetsAt: new Date(1793656777_000).toISOString() },
      { kind: 'weekly', label: 'semanal', usedPct: 70, resetsAt: new Date(1794083513_000).toISOString() },
    ],
  )
})

test('Codex: reset relativo é ancorado em asOf', () => {
  const asOf = '2026-11-02T20:00:00.000Z'
  const r = normalizeCodexRateLimits(
    { primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 1, window_minutes: 10080 } },
    { asOf },
  )
  assert.equal(r.windows[0].resetsAt, '2026-11-02T21:00:00.000Z')
  // sem resets_at nem resets_in_seconds: null, não "agora"
  assert.equal(r.windows[1].resetsAt, null)
})

test('Codex: window_minutes incomum ganha rótulo honesto', () => {
  const r = normalizeCodexRateLimits({
    primary: { used_percent: 1, window_minutes: 90 },
    secondary: { used_percent: 2, window_minutes: 43200 },
  })
  assert.deepEqual(
    r.windows.map((w) => [w.kind, w.label]),
    [
      ['5h', '90 min'],
      ['weekly', '30 dias'],
    ],
  )
})

test('Codex: janela sem used_percent fica fora', () => {
  const r = normalizeCodexRateLimits({ primary: { window_minutes: 300 }, secondary: { used_percent: 8, window_minutes: 10080 } })
  assert.deepEqual(
    r.windows.map((w) => [w.kind, w.usedPct]),
    [['weekly', 8]],
  )
  assert.equal(r.plan, null)
})

/** `<codex>/sessions/AAAA/MM/DD/rollout-*.jsonl` temporário. */
function codexFixture(): { dir: string; sessions: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-cockpit-codex-'))
  const sessions = join(dir, 'sessions')
  for (const [day, files] of [
    ['2026/11/01', ['rollout-2026-11-01T10-00-00-aaa.jsonl']],
    ['2026/11/02', ['rollout-2026-11-02T08-00-00-bbb.jsonl', 'rollout-2026-11-02T13-20-42-ccc.jsonl']],
  ] as const) {
    mkdirSync(join(sessions, day), { recursive: true })
    for (const f of files) writeFileSync(join(sessions, day, f), '')
  }
  return { dir, sessions, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('Codex: rollouts são varridos do mais novo para o mais velho', () => {
  const f = codexFixture()
  try {
    const found = latestCodexRollouts(f.sessions).map((p) => p.split(/[\\/]/).pop())
    assert.deepEqual(found, [
      'rollout-2026-11-02T13-20-42-ccc.jsonl',
      'rollout-2026-11-02T08-00-00-bbb.jsonl',
      'rollout-2026-11-01T10-00-00-aaa.jsonl',
    ])
  } finally {
    f.cleanup()
  }
})

test('Codex: snapshot vem do último rate_limits do rollout mais novo', () => {
  const f = codexFixture()
  try {
    const file = join(f.sessions, '2026/11/02', 'rollout-2026-11-02T13-20-42-ccc.jsonl')
    const ev = (ts: string, pct: number) =>
      JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 300 }, plan_type: 'plus' } },
      })
    writeFileSync(file, [ev('2026-11-02T13:30:00.000Z', 10), '{"type":"other"}', ev('2026-11-02T21:06:56.931Z', 69), ''].join('\n'))
    const snap = readCodexSnapshot(f.sessions)
    assert.ok(snap)
    assert.equal(snap.asOf, '2026-11-02T21:06:56.931Z')
    const r = normalizeCodexRateLimits(snap.rateLimits, { asOf: snap.asOf })
    assert.equal(r.windows[0].usedPct, 69)
  } finally {
    f.cleanup()
  }
})

test('Codex: formato antigo (rate_limits dentro de info) também é lido', () => {
  const f = codexFixture()
  try {
    const file = join(f.sessions, '2026/11/02', 'rollout-2026-11-02T13-20-42-ccc.jsonl')
    writeFileSync(
      file,
      JSON.stringify({
        timestamp: '2026-11-02T12:00:00.000Z',
        payload: { type: 'token_count', info: { rate_limits: { primary: { used_percent: 33, window_minutes: 300 } } } },
      }) + '\n',
    )
    const snap = readCodexSnapshot(f.sessions)
    assert.ok(snap)
    assert.equal(normalizeCodexRateLimits(snap.rateLimits).windows[0].usedPct, 33)
  } finally {
    f.cleanup()
  }
})

test('Codex: sem rollout utilizável devolve null (nada de dado falso)', () => {
  const f = codexFixture()
  try {
    assert.equal(readCodexSnapshot(f.sessions), null)
    assert.equal(readCodexSnapshot(join(f.dir, 'nao-existe')), null)
  } finally {
    f.cleanup()
  }
})

test('Hermes: provedores já cobertos por coletor dedicado não viram aba', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-cockpit-hermes-'))
  try {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        credential_pool: {
          anthropic: [{ auth_type: 'oauth', source: 'claude_code' }],
          huggingface: [{ auth_type: 'api_key' }],
        },
        providers: { nous: {} },
      }),
    )
    const withClaude = hermesConfiguredProviders(dir, new Set(['claude']))
    assert.deepEqual(
      withClaude.map((p) => [p.provider, p.label, p.plan]),
      [
        ['huggingface', 'Hugging Face', 'API key'],
        ['nous', 'Nous Portal', null],
      ],
    )
    assert.ok(withClaude.every((p) => p.windows.length === 0 && p.note))
    // sem o coletor do Claude, o anthropic do Hermes aparece como configurado
    const noClaude = hermesConfiguredProviders(dir, new Set())
    assert.ok(noClaude.some((p) => p.provider === 'anthropic' && p.plan === 'OAuth'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Hermes: auth.json ausente/ilegível devolve lista vazia', () => {
  assert.deepEqual(hermesConfiguredProviders(join(tmpdir(), 'nao-existe-xyz'), new Set()), [])
})

test('scrub tira segredo de mensagem de erro', () => {
  assert.equal(scrub('falha com sk-ant-oat01-ABCdef_123456789'), 'falha com ***')
  assert.equal(scrub('Authorization: Bearer eyJhbGciOi.payload.sig'), 'Authorization: Bearer ***')
  assert.equal(scrub('token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.abc'), 'token ***')
  assert.equal(scrub('ECONNRESET'), 'ECONNRESET')
})
