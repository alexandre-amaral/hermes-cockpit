// Tokens das runs do swarm: extração do result, backfill lazy do último result
// de events.jsonl com cache (usage.json + memória), propagação por summary()
// e gravação no meta pelo runner (claude falso). Rodar: npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'swarm-usage-'))
process.env.HERMES_SWARM_DIR = join(TMP, 'state')
process.env.HERMES_SWARM_WORKTREES = join(TMP, 'wt')

// state.mjs lê HERMES_SWARM_DIR no import → imports dinâmicos depois do env
const usage = await import('../swarm/lib/usage.mjs')
const state = await import('../swarm/lib/state.mjs')
const runs = await import('../swarm/lib/runs.mjs')

const USAGE = { input_tokens: 18, output_tokens: 13195, cache_creation_input_tokens: 49207, cache_read_input_tokens: 225507 }
const TOTAL = 18 + 13195 + 49207 + 225507

let seq = 0
function makeRun(meta = {}) {
  const id = `r-20261102-1200${String(seq).padStart(2, '0')}-${(0xa000 + seq++).toString(16)}`
  const dir = join(state.RUNS_DIR, id)
  mkdirSync(dir, { recursive: true })
  const m = { id, title: 't', task: 'x', repo: TMP, cwd: TMP, status: 'done', createdAt: new Date().toISOString(), ...meta }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(m))
  writeFileSync(join(dir, 'events.jsonl'), '')
  return { id, dir, meta: m, events: join(dir, 'events.jsonl') }
}
const line = (ev) => JSON.stringify({ ts: '2026-11-02T12:00:00Z', ev }) + '\n'
const big = (n) => line({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(n) }] } })

before(() => state.ensureDirs())
after(() => rmSync(TMP, { recursive: true, force: true }))

test('usageFromResult soma os quatro campos reais', () => {
  assert.deepEqual(usage.usageFromResult({ type: 'result', usage: { ...USAGE, service_tier: 'standard', output_tokens_details: { thinking_tokens: 3 } } }), {
    tokensTotal: TOTAL,
    tokenUsage: { inputTokens: 18, outputTokens: 13195, cacheCreationInputTokens: 49207, cacheReadInputTokens: 225507 },
  })
})

test('usageFromResult: só campos presentes; nada inventado', () => {
  assert.deepEqual(usage.usageFromResult({ usage: { input_tokens: 5, output_tokens: 7 } }), {
    tokensTotal: 12,
    tokenUsage: { inputTokens: 5, outputTokens: 7 },
  })
  assert.equal(usage.usageFromResult({ type: 'result', total_cost_usd: 1.23 }), null)
  assert.equal(usage.usageFromResult({ usage: { input_tokens: '5', output_tokens: -1, cache_read_input_tokens: NaN } }), null)
  assert.equal(usage.usageFromResult(null), null)
})

test('lastResultEvent: último result, atravessando blocos e ignorando falsos positivos/linha parcial', () => {
  const r = makeRun()
  writeFileSync(
    r.events,
    line({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }) + // result antigo
      big(200_000) + // força leitura em vários blocos de 64KB
      line({ type: 'result', usage: USAGE, total_cost_usd: 9 }) +
      big(90_000) +
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'grep "type":"result" ...' }] } }) +
      '{"ts":"x","ev":{"type":"result","usage":{"input_tokens":99', // append em curso
  )
  const ev = usage.lastResultEvent(r.events)
  assert.equal(ev.type, 'result')
  assert.deepEqual(ev.usage, USAGE)
  assert.equal(usage.lastResultEvent(join(r.dir, 'nao-existe.jsonl')), null)
})

test('lastResultEvent: arquivo de uma linha só, sem \\n final', () => {
  const r = makeRun()
  writeFileSync(r.events, line({ type: 'result', usage: { output_tokens: 3 } }).trimEnd())
  assert.deepEqual(usage.lastResultEvent(r.events).usage, { output_tokens: 3 })
})

test('runUsage: meta do runner tem precedência e não lê eventos', () => {
  const r = makeRun({ tokensTotal: 42, tokenUsage: { outputTokens: 42 } })
  writeFileSync(r.events, line({ type: 'result', usage: USAGE }))
  assert.deepEqual(usage.runUsage(r.dir, r.meta), { tokensTotal: 42, tokenUsage: { outputTokens: 42 } })
  assert.equal(existsSync(join(r.dir, usage.USAGE_CACHE_FILE)), false)
})

test('runUsage: backfill de run histórica grava usage.json e reaproveita o cache', () => {
  usage._resetUsageMemo()
  const r = makeRun()
  writeFileSync(r.events, big(100_000) + line({ type: 'result', usage: USAGE }))
  const T = new Date('2026-11-01T10:00:00.000Z') // mtime em ms inteiro: reaplicável sem arredondamento
  utimesSync(r.events, T, T)
  const u = usage.runUsage(r.dir, r.meta)
  assert.equal(u.tokensTotal, TOTAL)
  const cacheFile = join(r.dir, usage.USAGE_CACHE_FILE)
  const cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
  const st = statSync(r.events)
  assert.equal(cache.size, st.size)
  assert.equal(cache.usage.tokensTotal, TOTAL)
  // meta.json intocado (o runner é o escritor único)
  assert.deepEqual(JSON.parse(readFileSync(join(r.dir, 'meta.json'), 'utf8')), r.meta)

  // cache em memória: troca o conteúdo mantendo tamanho e mtime → não relê
  const same = readFileSync(r.events, 'utf8').replace('"input_tokens":18', '"input_tokens":19')
  writeFileSync(r.events, same)
  utimesSync(r.events, T, T)
  assert.equal(usage.runUsage(r.dir, r.meta).tokensTotal, TOTAL)

  // cache em disco (novo processo = memória vazia) também evita a releitura
  usage._resetUsageMemo()
  assert.equal(usage.runUsage(r.dir, r.meta).tokensTotal, TOTAL)
})

test('runUsage: cache invalida quando events.jsonl muda', () => {
  usage._resetUsageMemo()
  const r = makeRun()
  writeFileSync(r.events, line({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 } }))
  assert.equal(usage.runUsage(r.dir, r.meta).tokensTotal, 15)
  appendFileSync(r.events, line({ type: 'result', usage: { input_tokens: 100, output_tokens: 50 } }))
  assert.equal(usage.runUsage(r.dir, r.meta).tokensTotal, 150)
})

test('runUsage: sem result → null (cacheado); run não terminal não é varrida', () => {
  usage._resetUsageMemo()
  const r = makeRun({ status: 'error' })
  writeFileSync(r.events, big(10) + line({ type: 'result', subtype: 'error_during_execution' }))
  assert.equal(usage.runUsage(r.dir, r.meta), null)
  assert.equal(JSON.parse(readFileSync(join(r.dir, usage.USAGE_CACHE_FILE), 'utf8')).usage, null)

  const live = makeRun({ status: 'running' })
  writeFileSync(live.events, line({ type: 'result', usage: USAGE }))
  assert.equal(usage.runUsage(live.dir, live.meta, { terminal: false }), null)
  assert.equal(existsSync(join(live.dir, usage.USAGE_CACHE_FILE)), false)
})

test('runUsage: usage.json corrompido é ignorado e refeito', () => {
  usage._resetUsageMemo()
  const r = makeRun()
  writeFileSync(r.events, line({ type: 'result', usage: { output_tokens: 7 } }))
  writeFileSync(join(r.dir, usage.USAGE_CACHE_FILE), '{lixo')
  assert.equal(usage.runUsage(r.dir, r.meta).tokensTotal, 7)
})

test('summary()/result() de lib/runs.mjs expõem tokensTotal real (e ausência honesta)', () => {
  usage._resetUsageMemo()
  const withTok = makeRun({ costUsd: 1.5 })
  writeFileSync(withTok.events, line({ type: 'result', usage: USAGE }))
  const s = runs.summary(state.readMeta(withTok.id))
  assert.equal(s.tokensTotal, TOTAL)
  assert.equal(s.tokenUsage.cacheReadInputTokens, 225507)
  assert.equal(s.costUsd, 1.5) // mantido internamente
  assert.equal(runs.result(withTok.id).tokensTotal, TOTAL)

  const noTok = makeRun({ status: 'cancelled' })
  const s2 = runs.summary(state.readMeta(noTok.id))
  assert.equal('tokensTotal' in s2, false)
})

test('run.mjs grava tokensTotal/tokenUsage no meta ao ver o result (claude falso)', () => {
  const work = join(TMP, 'work') // não é repo git → isolation none
  mkdirSync(work, { recursive: true })
  const script = join(TMP, 'fake-claude.mjs')
  writeFileSync(
    script,
    `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')\n` +
      `out({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-test' })\n` +
      `out({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'ok', session_id: 'sess-1', total_cost_usd: 0.5, duration_ms: 10, usage: ${JSON.stringify(USAGE)} })\n`,
  )
  // POSIX pode executar o .mjs direto via shebang+chmod; Windows não entende
  // shebang, então o binário "falso" é um .cmd (igual ao shim que o npm
  // instala de verdade), que spawnSpec() resolve para `node <script>`.
  let fake = script
  if (process.platform === 'win32') {
    fake = join(TMP, 'fake-claude.cmd')
    writeFileSync(fake, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  } else {
    writeFileSync(script, `#!${process.execPath}\n${readFileSync(script, 'utf8')}`)
    chmodSync(fake, 0o755)
  }
  const r = makeRun({ status: 'queued', repo: work, cwd: work, permissionMode: 'manual' })
  const p = spawnSync(process.execPath, [join(ROOT, 'swarm', 'run.mjs'), r.id], {
    env: { ...process.env, CLAUDE_BIN: fake },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(p.status, 0, p.stderr)
  const meta = state.readMeta(r.id)
  assert.equal(meta.status, 'done', meta.error)
  assert.equal(meta.tokensTotal, TOTAL)
  assert.deepEqual(meta.tokenUsage, { inputTokens: 18, outputTokens: 13195, cacheCreationInputTokens: 49207, cacheReadInputTokens: 225507 })
  assert.equal(meta.costUsd, 0.5) // interno, não exibido
})
