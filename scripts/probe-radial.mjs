#!/usr/bin/env node
// Probe visual dos donuts de uso (RadialMeter) no app EMPACOTADO.
//
// Abre release/win-unpacked/Hermes Cockpit.exe com um user-data-dir limpo,
// injeta tema + layout por localStorage, e salva PNGs do widget de painel
// "Sistema" e da seção Ops › Sistema nos temas disponíveis.
//
// Como o smoke-term-keys: o `hermes serve` é substituído por um STUB
// (HERMES_BIN) — sem isso, com um Hermes já rodando na máquina o serve recusa a
// segunda instância e o app troca o cockpit pela tela "Falha ao subir o backend".
//
// Uso: node scripts/probe-radial.mjs [caminho-do-exe] [--out dir]

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : 'probe-out')
const exe = resolve(args.find((a, i) => !a.startsWith('--') && i !== outIdx + 1) ?? 'release/win-unpacked/Hermes Cockpit.exe')
const PORT = 9534 + Math.floor(Math.random() * 200)
const STEP_TIMEOUT_MS = 25_000
const IS_WIN = process.platform === 'win32'

const log = (...a) => console.log('[probe]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const saved = []
const problems = []

mkdirSync(outDir, { recursive: true })
if (!existsSync(exe)) {
  console.error(`[probe] executável não encontrado: ${exe} (rode npm run pack:win)`)
  process.exit(2)
}
const userData = mkdtempSync(join(tmpdir(), 'hermes-cockpit-probe-'))
let mainLog = ''
let child
let ws

function killTree() {
  if (!child?.pid) return
  try {
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch {
    /* já morreu */
  }
}

async function waitFor(fn, what, timeout = STEP_TIMEOUT_MS) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    if (child && child.exitCode !== null) throw new Error(`app encerrou (code ${child.exitCode}) aguardando: ${what}`)
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(250)
  }
  throw new Error(`timeout aguardando: ${what}${last ? ` (${last.message})` : ''}`)
}

// --- CDP mínimo -----------------------------------------------------------
let seq = 0
const pending = new Map()
const rendererErrors = []

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      rej(new Error(`CDP ${method} sem resposta`))
    }, STEP_TIMEOUT_MS)
    pending.set(id, { res, rej, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

function onMessage(raw) {
  const msg = JSON.parse(String(raw))
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.rej(new Error(msg.error.message))
    else p.res(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    rendererErrors.push(d.exception?.description ?? d.text)
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    if (/erro de render/i.test(text)) rendererErrors.push(`ErrorBoundary: ${text.slice(0, 300)}`)
  }
}

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

async function shot(name, clip) {
  const params = { format: 'png', captureBeyondViewport: Boolean(clip) }
  if (clip) params.clip = { ...clip, scale: 2 }
  const r = await send('Page.captureScreenshot', params)
  const file = join(outDir, `${name}.png`)
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  saved.push(file)
  log(`PNG ${file}`)
}

/** bounding box (CSS px) do elemento retornado pela expressão, via getBoundingClientRect. */
async function boxOf(expr, pad = 6) {
  const b = await evalJs(`(() => {
    const el = ${expr}
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })()`)
  if (!b || b.width < 8 || b.height < 8) return null
  return { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + pad * 2, height: b.height + pad * 2 }
}

const WIDGET_SEL = `[...document.querySelectorAll('section')].find(s => s.querySelector('h3')?.textContent?.startsWith('Sistema ·'))`
const OPS_SEL = `document.querySelector('#view-ops')`

async function setupStorage(theme) {
  // layout: Sistema na strip (linha larga) e nos cards do dock (painel estreito);
  // Ops abre direto na seção Sistema.
  await evalJs(`(() => {
    const L = localStorage
    L.setItem('hermes-cockpit.space', 'houer')
    L.setItem('hermes-cockpit.theme.v1', JSON.stringify({ preset: ${JSON.stringify(theme)}, accent: null, font: 'sf-mono', scale: 100 }))
    L.setItem('hermes-cockpit.regions.v1:houer', JSON.stringify({ strip: ['sistema'], dock: ['sistema'], rail: ['cota-rail'] }))
    L.setItem('hermes-cockpit.ui.v1:houer', JSON.stringify({
      view: 'ops', railOpen: true, dockOpen: true, stripOpen: true, dockCardsOpen: true,
      focus: false, dockTab: 'terminal',
      viewOrder: ['chat','swarm','automacoes','notion','ops','transcrever'], hiddenViews: []
    }))
    L.setItem('hc.ops.section', 'system')
    return true
  })()`)
}

async function captureTheme(theme) {
  await setupStorage(theme)
  await send('Page.reload', { ignoreCache: false })
  await waitFor(() => evalJs(`document.readyState === 'complete' && !!document.querySelector('#root > *')`), `${theme}: #root`)
  await waitFor(() => evalJs(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`), `${theme}: data-theme aplicado`)
  // as métricas (ops:system) levam ~1 amostra de CPU para chegar
  await waitFor(() => evalJs(`${WIDGET_SEL}?.textContent?.includes('%') === true`), `${theme}: widget Sistema com métricas`, 40_000)
  await waitFor(
    () => evalJs(`${OPS_SEL}?.querySelectorAll('svg[role="meter"]').length > 3`),
    `${theme}: donuts na Ops › Sistema`,
    40_000,
  )
  await sleep(1200) // deixa o arco animar até o valor final

  const meters = await evalJs(`document.querySelectorAll('svg[role="meter"]').length`)
  log(`${theme}: ${meters} medidores radiais no documento`)
  if (meters < 8) problems.push(`${theme}: só ${meters} donuts na tela`)

  await shot(`${theme}-00-app`)
  const w = await boxOf(WIDGET_SEL, 8)
  if (w) await shot(`${theme}-01-widget-sistema`, w)
  else problems.push(`${theme}: widget Sistema não encontrado`)
  const o = await boxOf(`${OPS_SEL}`, 0)
  if (o) await shot(`${theme}-02-ops-sistema`, o)
  else problems.push(`${theme}: view Ops não encontrada`)

  // painel estreito: o mesmo widget no card do dock (coluna ~300px)
  const narrow = await evalJs(`(() => {
    const all = [...document.querySelectorAll('section')].filter(s => s.querySelector('h3')?.textContent?.startsWith('Sistema ·'))
    return all.length
  })()`)
  log(`${theme}: ${narrow} instância(s) do widget Sistema montadas (strip + dock)`)
  if (narrow > 1) {
    const b = await boxOf(
      `[...document.querySelectorAll('section')].filter(s => s.querySelector('h3')?.textContent?.startsWith('Sistema ·')).at(-1)`,
      8,
    )
    if (b) await shot(`${theme}-03-widget-estreito`, b)
  }

  // sanidade da geometria: nenhum arco com dashoffset negativo/NaN
  const bad = await evalJs(`[...document.querySelectorAll('.hc-radial-arc')].filter(c => {
    const v = parseFloat(c.getAttribute('stroke-dashoffset'))
    return !Number.isFinite(v) || v < 0
  }).length`)
  if (bad) problems.push(`${theme}: ${bad} arco(s) com stroke-dashoffset inválido`)
}

async function main() {
  log(`exe: ${exe}`)
  log(`user-data-dir: ${userData} · CDP ${PORT}`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const stub = join(userData, IS_WIN ? 'hermes-stub.cmd' : 'hermes-stub.sh')
  writeFileSync(
    stub,
    (IS_WIN
      ? ['@echo off', 'echo HERMES_BACKEND_READY port=1', 'ping -n 99999 127.0.0.1 > nul', '']
      : ['#!/bin/sh', 'echo "HERMES_BACKEND_READY port=1"', 'sleep 99999', '']
    ).join(IS_WIN ? '\r\n' : '\n'),
    { mode: 0o755 },
  )
  env.HERMES_BIN = stub

  child = spawn(
    exe,
    [
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false },
  )
  child.stdout.on('data', (c) => (mainLog += c))
  child.stderr.on('data', (c) => (mainLog += c))

  const target = await waitFor(
    async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && String(t.url).startsWith('file:')),
    'janela do renderer',
    45_000,
  )
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket CDP falhou'))
  })
  ws.onmessage = (ev) => onMessage(ev.data)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 2, mobile: false })

  for (const theme of ['grafite', 'fosforo', 'ambar', 'claro']) await captureTheme(theme)
}

try {
  await main()
} catch (e) {
  problems.push(e.message)
} finally {
  try {
    ws?.close()
  } catch {}
  killTree()
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
  } catch {}
  writeFileSync(join(outDir, 'main.log'), mainLog)
  for (const e of rendererErrors) problems.push(`renderer: ${e}`)
  console.log('\n[probe] PNGs:\n' + saved.map((f) => '  ' + f).join('\n'))
  if (problems.length) {
    console.error('\n[probe] PROBLEMAS:\n' + problems.map((p) => '  - ' + p).join('\n'))
    console.log('--- main log (cauda) ---\n' + mainLog.slice(-2500))
    process.exit(1)
  }
  console.log('[probe] OK')
  process.exit(0)
}
