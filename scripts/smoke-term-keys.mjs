#!/usr/bin/env node
// Smoke REAL dos atalhos de teclado/clipboard do Terminal do dock (xterm + ConPTY).
//
// O QUE VALIDA (app de verdade, sem mock):
//   1. a aba Terminal monta, o PTY abre e o shell ecoa o que digitamos;
//   2. Ctrl+C com seleção copia (clipboard do Electron) e limpa a seleção, sem SIGINT;
//      idem Ctrl+Shift+C, Ctrl+Insert e botão direito com seleção;
//   3. Ctrl+C sem seleção interrompe (o shell imprime ^C);
//   4. Ctrl+V / Ctrl+Shift+V / Shift+Insert e botão direito sem seleção colam
//      (e Ctrl+Shift+V não abre o overlay de voz do app);
//   5. Ctrl+A chega ao shell (início da linha) e NÃO seleciona a página;
//   6. Ctrl+= / Ctrl+0 mudam só a fonte do terminal (a escala da UI em #root fica igual);
//      e, FORA do terminal, copiar/colar nativo do Chromium continua valendo
//      (input comum e seleção de texto não editável) — rede de segurança da
//      mudança no menu Edit;
//   7. injeção de tecla no nível do SISTEMA (keybd_event): Ctrl+C/Ctrl+A/Ctrl+V
//      chegam ao renderer, isto é, os aceleradores do menu Edit não engolem mais
//      as teclas (registerAccelerator:false, src/main/menu.ts). Só no Windows, e
//      só se a janela do app estiver em primeiro plano NO SO — o Windows não
//      deixa um processo em background trazê-la para frente, então rodando por
//      um shell de agente este item costuma sair como PULADO (não como falha).
//
// Uso: node scripts/smoke-term-keys.mjs [caminho-do-exe] [--out dir] [--real-backend]
//   Por padrão o `hermes serve` é substituído por um STUB (HERMES_BIN): o Terminal do
//   dock usa o relay de PTY do main (ops:shell.*) e não depende do backend, e sem o
//   stub o app cai na tela "Falha ao subir o backend" quando já existe um Hermes
//   rodando na máquina (o serve recusa a segunda instância) — aí o cockpit desmonta.
//   --real-backend usa o hermes de verdade.
//   sem argumento usa release/win-unpacked se existir, senão o Electron de dev
//   sobre `out/` (rode `npm run build` antes).
// Requer Node >= 22 (WebSocket/fetch globais).

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : 'smoke-out')
const cliExe = args.find((a, i) => !a.startsWith('--') && i !== outIdx + 1)
const PORT = 9733 + Math.floor(Math.random() * 200)
const STEP_TIMEOUT_MS = 20_000
const IS_WIN = process.platform === 'win32'
const PACKED = resolve('release/win-unpacked/Hermes Cockpit.exe')
const DEV_ELECTRON = resolve('node_modules/electron/dist', IS_WIN ? 'electron.exe' : 'electron')

const log = (...a) => console.log('[term-keys]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const skips = []
const fail = (m) => {
  failures.push(m)
  console.error('[term-keys] FALHA:', m)
}
const skip = (m) => {
  skips.push(m)
  log('PULADO:', m)
}
const ok = (m) => log('ok  ·', m)

let exe = cliExe ? resolve(cliExe) : existsSync(PACKED) ? PACKED : DEV_ELECTRON
const exeArgs = exe === DEV_ELECTRON ? [resolve('.')] : []
if (!existsSync(exe)) {
  console.error(`[term-keys] executável não encontrado: ${exe}`)
  process.exit(2)
}
if (exeArgs.length && !existsSync(resolve('out/main/index.js'))) {
  console.error('[term-keys] out/main/index.js ausente — rode `npm run build` primeiro')
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'hermes-cockpit-keys-'))
let mainLog = ''
let child
let ws
let finished = false

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
    await sleep(200)
  }
  throw new Error(`timeout (${timeout / 1000}s) aguardando: ${what}${last ? ` (${last.message})` : ''}`)
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
    rendererErrors.push(`exceção: ${d.exception?.description ?? d.text}`)
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

async function screenshot(name) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'))
  } catch {
    /* sem janela visível */
  }
}

// --- teclado/mouse via CDP (vai direto ao renderer) -----------------------
const MOD = { ctrl: 2, shift: 8, alt: 1, meta: 4 }
// Virtual-keys do Windows: '-' NÃO é 45 (isso é VK_INSERT, e o xterm manda
// ESC[2~ em vez do caractere). Letras/dígitos coincidem com o charCode.
const VK = { Enter: 13, Insert: 45, Escape: 27, '-': 189, '=': 187, '+': 187, _: 189, '.': 190, ' ': 32, '#': 51 }
const vk = (k) => VK[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0)
const codeOf = (k) => (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^[0-9]$/.test(k) ? `Digit${k}` : k)

/** keydown+keyup com modificadores (sem `text`: combinação, não digitação). */
async function press(key, mods = 0) {
  const base = { key, code: codeOf(key), windowsVirtualKeyCode: vk(key), nativeVirtualKeyCode: vk(key), modifiers: mods }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(60)
}

/** digita texto como o usuário (keydown com `text` → xterm manda ao PTY). */
async function type(text) {
  for (const ch of text) {
    const base = { key: ch, code: codeOf(ch), windowsVirtualKeyCode: vk(ch), nativeVirtualKeyCode: vk(ch), text: ch, unmodifiedText: ch }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
  await sleep(120)
}

/** duplo clique: o xterm seleciona a palavra sob o cursor (seleção determinística). */
async function dblclick(x, y) {
  for (const clickCount of [1, 2]) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount })
  }
  await sleep(250)
}

/** clique com o botão direito (o XtermView trata contextmenu: copia ou cola). */
async function contextMenu(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 })
  await sleep(250)
}

async function drag(from, to) {
  const common = { button: 'left', buttons: 1, clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, ...common })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (from.x + to.x) / 2, y: from.y, ...common })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, ...common })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, ...common, buttons: 0 })
  await sleep(200)
}

// --- helpers de página ----------------------------------------------------
// __term(): o terminal VISÍVEL. O dock mantém as sessões anteriores montadas e
// escondidas — mirar na primeira que casa o seletor pega um xterm sem layout.
const INSTALL_TERM = `window.__term = () => [...document.querySelectorAll('[data-term-host]')].find((h) => h.offsetWidth > 0 && h.offsetHeight > 0) ?? null`
const q = (sel) => `window.__term()?.querySelector(${JSON.stringify(sel)})`
// Log de keydown do renderer (capture no window): mostra o que de fato chegou
// à página — e no teste do menu Edit é a própria evidência.
const INSTALL_KEYLOG = `(() => {
  window.__keys = []
  if (!window.__keyLogger) {
    window.__keyLogger = (e) => window.__keys.push(
      [e.ctrlKey ? 'ctrl' : '', e.shiftKey ? 'shift' : '', e.key, '@' + (e.target?.className || e.target?.tagName || '?')].filter(Boolean).join('+'),
    )
    window.addEventListener('keydown', window.__keyLogger, true)
  }
  return true
})()`
const keyLog = () => evalJs(`window.__keys ?? []`)
const keyLogReset = () => evalJs(`(window.__keys = []).length`)
const screenText = () => evalJs(`${q('.xterm-rows')}?.innerText ?? ''`)
const selectionBoxes = () => evalJs(`window.__term()?.querySelectorAll('.xterm-selection > div').length ?? 0`)
const selectionGeom = () =>
  evalJs(
    `JSON.stringify([...(window.__term()?.querySelectorAll('.xterm-selection > div') ?? [])].map((d) => [Math.round(d.getBoundingClientRect().width), Math.round(d.getBoundingClientRect().height)]))`,
  )
const clipboardRead = () => evalJs(`window.hermes.invoke('ops:clipboard.read')`)
const clipboardWrite = (t) => evalJs(`window.hermes.invoke('ops:clipboard.write', ${JSON.stringify(t)})`)
const focusTerm = () => evalJs(`(() => { const t = ${q('textarea')}; t?.focus(); return document.activeElement?.className ?? '' })()`)

async function waitScreen(needle, what, timeout = 15_000) {
  return waitFor(async () => (await screenText()).includes(needle), what, timeout)
}

// --- injeção de tecla no nível do SISTEMA (testa o menu Edit) -------------
// keybd_event (user32) em vez de SendKeys: SendKeys do .NET pode cair no
// journal hook, que o Windows moderno bloqueia — e aí o teste "não chegou
// tecla" seria falso-negativo. Aqui o input entra na fila do SO de verdade.
const USER32_KEYS = `
Add-Type -Namespace Win32 -Name Keys -MemberDefinition @'
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
'@
function Send-Key([byte]$key, [bool]$ctrl, [bool]$shift) {
  if ($ctrl) { [Win32.Keys]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero) }
  if ($shift) { [Win32.Keys]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero) }
  [Win32.Keys]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [Win32.Keys]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
  if ($shift) { [Win32.Keys]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero) }
  if ($ctrl) { [Win32.Keys]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 350
}
`

/** combos: [['c', false], ['a', false]] → Ctrl+C, Ctrl+A no nível do SO. */
function sendKeysOS(combos) {
  const ps = [
    USER32_KEYS,
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `try { [Microsoft.VisualBasic.Interaction]::AppActivate(${child.pid}) } catch {}`,
    `$h = (Get-Process -Id ${child.pid}).MainWindowHandle; if ($h -ne 0) { [Win32.Keys]::SetForegroundWindow($h) | Out-Null }`,
    'Start-Sleep -Milliseconds 600',
    `$fg = [Win32.Keys]::GetForegroundWindow(); $fgpid = 0; [Win32.Keys]::GetWindowThreadProcessId($fg, [ref]$fgpid) | Out-Null; Write-Output "fg-pid=$fgpid alvo=${child.pid} handle=$h"`,
    ...combos.map(
      (c) =>
        `Send-Key 0x${c.key.toUpperCase().charCodeAt(0).toString(16)} $${c.ctrl ? 'true' : 'false'} $${c.shift ? 'true' : 'false'}`,
    ),
  ].join('\n')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 40_000 })
  return { code: r.status, err: (r.stderr || '').trim(), out: (r.stdout || '').trim() }
}

async function main() {
  log(`exe: ${exe}${exeArgs.length ? ` ${exeArgs.join(' ')}` : ''}`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (!args.includes('--real-backend')) {
    // Stub do `hermes serve`: anuncia o sentinel de ready numa porta morta e
    // fica vivo. O cockpit monta (painéis do backend ficam em estado de erro,
    // o que é esperado) e o Terminal — que fala com o relay de PTY do main —
    // funciona normalmente.
    const stub = join(userData, IS_WIN ? 'fake-hermes.cmd' : 'fake-hermes.sh')
    const lines = IS_WIN
      ? ['@echo off', 'echo HERMES_BACKEND_READY port=1', 'ping -n 99999 127.0.0.1 > nul', '']
      : ['#!/bin/sh', 'echo "HERMES_BACKEND_READY port=1"', 'sleep 99999', '']
    writeFileSync(stub, lines.join(IS_WIN ? '\r\n' : '\n'), { mode: 0o755 })
    env.HERMES_BIN = stub
    log(`backend: stub (${stub})`)
  }
  // Sem estes switches o Chromium pausa o renderer quando a janela fica
  // ocluída por outra janela: o xterm (renderer DOM) para de atualizar e o
  // teste vê "nada ecoou"/"nenhuma seleção" sem que o app tenha culpa.
  const noBg = [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
  ]
  child = spawn(exe, [...exeArgs, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', ...noBg], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  })
  child.stdout.on('data', (c) => (mainLog += c))
  child.stderr.on('data', (c) => (mainLog += c))
  child.on('error', (e) => fail(`falha ao lançar: ${e.message}`))

  const target = await waitFor(
    async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && String(t.url).startsWith('file:')),
    'janela do renderer',
    40_000,
  )
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket CDP falhou'))
  })
  ws.onmessage = (ev) => onMessage(ev.data)
  await send('Runtime.enable')
  await send('Page.enable')
  await waitFor(() => evalJs(`!!document.querySelector('#root > *')`), '#root montado', 40_000)

  // Janela em primeiro plano: sem foco o Blink não entrega as teclas ao
  // elemento focado, e o xterm (que escuta no textarea) não vê nada.
  const focusWindow = async () => {
    try {
      await send('Page.bringToFront')
    } catch {
      /* alguns builds não implementam */
    }
    if (IS_WIN) {
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Add-Type -AssemblyName Microsoft.VisualBasic; try { [Microsoft.VisualBasic.Interaction]::AppActivate(${child.pid}) } catch {}`,
        ],
        { stdio: 'ignore', timeout: 20_000 },
      )
    }
    await sleep(400)
    return evalJs(`document.hasFocus()`)
  }
  const hasFocus = await waitFor(focusWindow, 'janela do app em primeiro plano', 15_000).catch(() => false)
  log(`document.hasFocus(): ${hasFocus}`)
  if (!hasFocus) skip('a janela não ficou em primeiro plano — teclas podem não chegar ao xterm')

  // 1) aba Terminal + PTY aberto
  await evalJs(INSTALL_TERM)
  await evalJs(INSTALL_KEYLOG)
  await evalJs(`document.querySelector('[role="tab"][data-tab-id="terminal"]')?.click(); window.dispatchEvent(new CustomEvent('hc:dock-tab',{detail:'terminal'}))`)
  await waitFor(() => evalJs(`!!${q('.xterm-screen')} && !!${q('.xterm-rows')}`), 'xterm visível montado')
  ok('aba Terminal montou o xterm')
  const status = await waitFor(
    async () => {
      const t = await evalJs(`[...document.querySelectorAll('div')].map(d=>d.textContent).find(t=>t&&t.startsWith('pty'))??''`)
      return /conectado|erro|encerrado/.test(t) ? t : null
    },
    'status do PTY no rodapé',
  ).catch(() => '')
  log(`rodapé: ${String(status).slice(0, 160)}`)
  await screenshot('term-01-aberto')

  // marcador do shell: confirma que o PTY está vivo e ecoando
  const live = await (async () => {
    try {
      await waitFor(async () => (await screenText()).trim().length > 0, 'prompt do shell no buffer')
      log(`foco: ${await focusTerm()}`)
      await keyLogReset()
      await type('echo PTYALIVE7781\r')
      log(`keydown vistos no renderer: ${JSON.stringify(await keyLog())}`)
      await waitScreen('PTYALIVE7781', 'eco do shell')
      return true
    } catch (e) {
      log(`shell não respondeu: ${e.message}`)
      return false
    }
  })()
  if (live) ok('shell vivo (eco de echo)')
  else skip('shell/PTY não abriu nesta máquina — testes dependentes de eco serão pulados')

  log(
    `estado: ` +
      (await evalJs(`JSON.stringify({hosts: document.querySelectorAll('[data-term-host]').length, visivel: !!window.__term(), hostW: window.__term()?.offsetWidth ?? -1, screen: !!window.__term()?.querySelector('.xterm-screen'), screenW: window.__term()?.querySelector('.xterm-screen')?.getBoundingClientRect().width ?? -1, rows: (window.__term()?.querySelector('.xterm-rows')?.innerText ?? '').slice(-60), win: [innerWidth, innerHeight], zoom: getComputedStyle(document.getElementById('root')).zoom})`)),
  )

  // Injeção de tecla do SO (menu Edit). Roda ANTES dos testes por CDP: a
  // janela recém-criada ainda está em primeiro plano, e o Windows não deixa
  // um processo em background trazê-la de volta depois.
  async function osMenuCheck() {
    // 7) injeção de tecla do SISTEMA: o menu Edit não engole mais Ctrl+C/A/V
    if (!IS_WIN) {
      skip('injeção de tecla do SO só implementada no Windows')
    } else {
      // Com o TERMINAL focado: é o cenário que importa (fora dele, Ctrl+A
      // selecionar a página é o comportamento nativo e correto do Chromium).
      await evalJs(`window.getSelection()?.removeAllRanges()`)
      await focusTerm()
      await clipboardWrite('# OSPASTEOK')
      await keyLogReset()
      // A injeção vai para a janela em primeiro plano, qualquer que seja ela: só
      // injeta se a página do app estiver com foco, senão as teclas iriam para
      // outro app do usuário.
      const focusedBefore = await focusWindow()
      const combos = [
        { key: 'x', ctrl: false, shift: false }, // controle: a injeção chega à janela?
        { key: 'c', ctrl: true, shift: false },
        { key: 'a', ctrl: true, shift: false },
        { key: 'v', ctrl: true, shift: false },
      ]
      const r = focusedBefore ? sendKeysOS(combos) : { code: -1, err: 'janela do app sem foco' }
      if (r.out) log(`primeiro plano no SO: ${r.out.replace(/\s+/g, ' ')}`)
      const fgPid = Number(/fg-pid=(\d+)/.exec(r.out ?? '')?.[1] ?? 0)
      if (r.code !== 0) {
        skip(`injeção de tecla do SO não executada (${r.err.slice(0, 200)})`)
      } else if (fgPid && fgPid !== child.pid) {
        // O Windows não deixa um processo em background roubar o foreground:
        // rodando por um shell de agente, a janela do app às vezes não vai para
        // frente e a injeção iria para outro app. Sem isso o teste seria flaky.
        skip(`a janela do app não estava em primeiro plano no SO (fg-pid=${fgPid}, app=${child.pid}) — menu Edit não verificado nesta rodada`)
      } else {
        await sleep(800)
        const keys = await keyLog()
        log(`teclas recebidas pelo renderer: ${JSON.stringify(keys)}`)
        const got = (k) => keys.some((x) => /ctrl/.test(x) && x.toLowerCase().includes(`+${k}+`))
        const focused = await evalJs(`document.hasFocus()`)
        const gotPlain = keys.some((k) => !/ctrl/.test(k) && /\+?x\+/i.test(k))
        if (!gotPlain) {
          skip(`injeção de tecla do SO não chegou nem sem modificador (foco=${focused}) — teste do menu Edit não conclusivo`)
        } else {
          for (const k of ['c', 'a', 'v']) {
            if (got(k)) ok(`Ctrl+${k.toUpperCase()} do sistema chegou ao renderer (acelerador do menu Edit não engole)`)
            else fail(`Ctrl+${k.toUpperCase()} do sistema NÃO chegou ao renderer (acelerador do menu engoliu)`)
          }
          const pageSel = await evalJs(`(window.getSelection()?.toString() ?? '').length`)
          if (pageSel > 0) fail(`Ctrl+A do sistema selecionou a página (${pageSel} chars) com o terminal focado`)
          else ok('Ctrl+A do sistema não selecionou a página (foi para o shell)')
          // Ctrl+V do sistema → colou no PTY? (ponta a ponta: SO → menu → página → xterm → shell)
          if (live) {
            try {
              await waitScreen('OSPASTEOK', 'Ctrl+V do sistema colando no shell', 6000)
              ok('Ctrl+V do sistema colou no terminal')
            } catch (e) {
              fail(`Ctrl+V do sistema não colou no terminal: ${e.message}`)
            }
            await focusTerm()
            await press('c', MOD.ctrl)
          }
        }
      }
    }
  }

  await osMenuCheck()

  // 2) Ctrl+C com seleção copia e limpa a seleção
  await clipboardWrite('SENTINELA-NAO-COPIOU')
  const rect = await waitFor(
    () => evalJs(`(() => { const e = ${q('.xterm-screen')}; if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 20 ? {x:r.x,y:r.y,w:r.width,h:r.height} : null })()`),
    'retângulo da tela do terminal',
  )
  // Duplo clique sobre a última linha com texto: o xterm seleciona a palavra
  // (determinístico). Arraste sintético pode terminar em seleção degenerada.
  const row = await evalJs(`(() => {
    const rows = [...(window.__term()?.querySelectorAll('.xterm-rows > div') ?? [])]
    const i = rows.map((r, i) => [r.innerText.trim().length, i]).filter(([n]) => n > 2).pop()?.[1]
    if (i == null) return null
    const r = rows[i].getBoundingClientRect()
    return { x: Math.round(r.x + 8), y: Math.round(r.y + r.height / 2), text: rows[i].innerText.trim().slice(0, 40) }
  })()`)
  log(`linha alvo: ${JSON.stringify(row)}`)

  /** Recria a seleção (cada cópia a limpa, de propósito) e zera o clipboard. */
  const reselect = async (sentinel) => {
    await clipboardWrite(sentinel)
    if (row) await dblclick(row.x, row.y)
    await focusTerm() // o mouse sintético do CDP não garante o foco no textarea
    const n = await selectionBoxes()
    if (!n) {
      // Fallback: Ctrl+Shift+A (nosso 'select-all') também serve de fonte de seleção.
      await press('a', MOD.ctrl | MOD.shift)
      await sleep(250)
      return selectionBoxes()
    }
    return n
  }

  const boxes = await reselect('SENTINELA-NAO-COPIOU')
  if (boxes > 0) ok(`seleção por duplo clique (caixas ${await selectionGeom()})`)
  else fail('não foi possível criar seleção no terminal (duplo clique nem Ctrl+Shift+A)')

  if (boxes > 0) {
    const before = await screenText()
    await keyLogReset()
    await press('c', MOD.ctrl)
    await sleep(250)
    const clip = await clipboardRead()
    log(`Ctrl+C → teclas ${JSON.stringify(await keyLog())}`)
    if (clip && clip !== 'SENTINELA-NAO-COPIOU') ok(`Ctrl+C com seleção copiou: ${JSON.stringify(clip.slice(0, 60))}`)
    else fail(`Ctrl+C com seleção não copiou (clipboard = ${JSON.stringify(String(clip).slice(0, 60))})`)
    if ((await selectionBoxes()) === 0) ok('seleção limpa após copiar')
    else fail('seleção continuou visível após Ctrl+C')
    const after = await screenText()
    if (!/\^C/.test(after.replace(before, ''))) ok('Ctrl+C com seleção não mandou SIGINT ao shell')
    else fail('Ctrl+C com seleção também mandou SIGINT')

    // Os outros caminhos de cópia, cada um com a seleção refeita.
    for (const [label, run] of [
      ['Ctrl+Shift+C', () => press('C', MOD.ctrl | MOD.shift)],
      ['Ctrl+Insert', () => press('Insert', MOD.ctrl)],
      ['botão direito com seleção', () => contextMenu(row.x, row.y)],
    ]) {
      const sentinel = `SENTINELA-${label.replace(/\W+/g, '')}`
      if (!(await reselect(sentinel))) {
        skip(`${label}: não deu para refazer a seleção`)
        continue
      }
      await run()
      await sleep(300)
      const c = await clipboardRead()
      if (c && c !== sentinel) ok(`${label} copiou: ${JSON.stringify(String(c).slice(0, 40))}`)
      else fail(`${label} não copiou (clipboard = ${JSON.stringify(String(c).slice(0, 40))})`)
    }

    // Botão direito SEM seleção = colar (padrão do Windows Terminal).
    if (live) {
      await clipboardWrite('# COLABOTAODIREITO')
      await focusTerm()
      await press('c', MOD.ctrl) // garante sem seleção e linha limpa
      await sleep(200)
      await contextMenu(row.x, row.y)
      try {
        await waitScreen('COLABOTAODIREITO', 'botão direito sem seleção colando', 8000)
        ok('botão direito sem seleção colou')
      } catch (e) {
        fail(`botão direito sem seleção não colou: ${e.message}`)
      }
      await press('c', MOD.ctrl)
    }
  }

  // 3) Ctrl+C sem seleção → ^C do shell
  if (live) {
    await focusTerm()
    await type('naoexecutarisso')
    await press('c', MOD.ctrl)
    try {
      await waitScreen('^C', 'shell imprimindo ^C (SIGINT)', 8000)
      ok('Ctrl+C sem seleção interrompeu (^C no shell)')
    } catch (e) {
      fail(`Ctrl+C sem seleção não chegou ao shell: ${e.message}`)
    }
  }

  // 4) colar (Ctrl+V e Ctrl+Shift+V) + overlay de voz não abre
  if (live) {
    for (const [label, mods, marker] of [
      ['Ctrl+V', MOD.ctrl, 'COLA-CTRLV-01'],
      ['Ctrl+Shift+V', MOD.ctrl | MOD.shift, 'COLA-CTRLSHIFTV-02'],
      ['Shift+Insert', MOD.shift, null],
    ]) {
      const mark = marker ?? 'COLA-SHIFTINSERT-03'
      await clipboardWrite(`# ${mark}`)
      await focusTerm()
      if (label === 'Shift+Insert') await press('Insert', MOD.shift)
      else await press('v', mods)
      try {
        await waitScreen(mark, `${label} colando`, 8000)
        ok(`${label} colou`)
      } catch (e) {
        fail(`${label} não colou: ${e.message}`)
      }
      await press('c', MOD.ctrl) // limpa a linha
      await sleep(150)
    }
    const voice = await evalJs(`!!document.querySelector('[role="dialog"][aria-label="Voice mode"]')`)
    if (voice) fail('Ctrl+Shift+V abriu o overlay de voz (atalho global roubou a tecla do terminal)')
    else ok('Ctrl+Shift+V não abriu o overlay de voz')
  }

  // 5) Ctrl+A vai ao shell (readline: início da linha) e não seleciona a página
  if (live) {
    await focusTerm()
    await evalJs(`window.getSelection()?.removeAllRanges()`)
    await type('ZZFIM')
    await press('a', MOD.ctrl)
    await type('INICIO')
    try {
      await waitScreen('INICIOZZFIM', 'Ctrl+A movendo o cursor no shell', 8000)
      ok('Ctrl+A chegou ao shell (início da linha)')
    } catch (e) {
      fail(`Ctrl+A não chegou ao shell: ${e.message}`)
    }
    const pageSel = await evalJs(`(window.getSelection()?.toString() ?? '').length`)
    if (pageSel > 0) fail(`Ctrl+A selecionou a página (${pageSel} chars)`)
    else ok('Ctrl+A não selecionou a página')
    await press('c', MOD.ctrl)
  }

  // 6) Ctrl+= / Ctrl+0: fonte do terminal, não a escala da UI
  const fontOf = () => evalJs(`getComputedStyle(${q('.xterm-rows')}).fontSize`)
  const zoomOf = () => evalJs(`getComputedStyle(document.getElementById('root')).zoom`)
  await focusTerm()
  const f0 = await fontOf()
  const z0 = await zoomOf()
  await press('=', MOD.ctrl)
  await sleep(300)
  const f1 = await fontOf()
  const z1 = await zoomOf()
  if (f1 !== f0) ok(`Ctrl+= mudou a fonte do terminal (${f0} → ${f1})`)
  else fail(`Ctrl+= não mudou a fonte do terminal (${f0})`)
  if (z1 === z0) ok(`Ctrl+= não mexeu na escala da UI (zoom ${z0})`)
  else fail(`Ctrl+= mexeu na escala da UI (${z0} → ${z1})`)
  await press('0', MOD.ctrl)
  await sleep(300)
  const f2 = await fontOf()
  if (f2 === f0) ok('Ctrl+0 voltou a fonte do terminal ao padrão')
  else fail(`Ctrl+0 não restaurou a fonte (${f0} → ${f2})`)
  await screenshot('term-02-depois')

  // 6b) FORA do terminal: copiar/colar nativo do Chromium continua valendo.
  // É a rede de segurança da mudança no menu Edit (registerAccelerator:false):
  // teclas injetadas pelo CDP nunca passam pelo menu, então este cenário é
  // exatamente "sem acelerador de menu" — se o Chromium não tratasse Ctrl+C/V
  // sozinho em inputs, aqui falharia.
  const input = await evalJs(`(() => {
    let el = [...document.querySelectorAll('textarea, input[type=text], input:not([type])')].find(
      (e) => !e.closest('[data-term-host]') && !e.disabled && !e.readOnly && e.offsetWidth > 40,
    )
    let how = 'input do app'
    if (!el) {
      // Sem backend o composer fica desabilitado: cria um textarea de verdade
      // na própria página (mesmo caminho de edição do Chromium).
      el = document.createElement('textarea')
      el.id = '__smoke_input'
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;width:200px;height:40px;z-index:99999'
      document.body.appendChild(el)
      how = 'textarea criado pelo teste'
    }
    el.focus()
    el.value = ''
    return how + ' · ' + el.tagName + '.' + (el.className || el.id || '').split(' ')[0]
  })()`)
  {
    log(`input alvo: ${input}`)
    await type('NATIVOCOPIA42')
    await clipboardWrite('SENTINELA-INPUT')
    await press('a', MOD.ctrl) // select-all nativo do input
    await press('c', MOD.ctrl)
    await sleep(250)
    const c = await clipboardRead()
    if (String(c).includes('NATIVOCOPIA42')) ok(`Ctrl+A/Ctrl+C nativos funcionam em input comum (${JSON.stringify(String(c).slice(0, 30))})`)
    else fail(`Ctrl+C nativo não copiou do input (clipboard = ${JSON.stringify(String(c).slice(0, 40))})`)
    await evalJs(`(() => {
      const el = document.activeElement
      if (el && 'value' in el) { el.value = ''; el.blur() }
      document.getElementById('__smoke_input')?.remove()
    })()`)
  }

  // 6c) Seleção de texto NÃO editável (transcript, rótulos): Ctrl+C também é
  // comando nativo do Chromium — sem isto a mudança no menu Edit teria
  // quebrado "selecionar com o mouse e copiar" fora de inputs.
  const picked = await evalJs(`(() => {
    const cands = [...document.querySelectorAll('span, p, div')].filter(
      (e) => !e.closest('[data-term-host]') && e.children.length === 0 && (e.textContent || '').trim().length > 6 && e.getBoundingClientRect().width > 20,
    )
    if (!cands.length) return 'SEM-CANDIDATO'
    document.activeElement?.blur?.()
    const sel = window.getSelection()
    // Regiões com user-select:none (topbar com app-drag) não selecionam: tenta
    // os candidatos até sair texto de verdade.
    for (const el of cands.slice(0, 40)) {
      const r = document.createRange()
      r.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(r)
      const t = sel.toString().trim()
      if (t.length > 6) return t.slice(0, 40)
    }
    return 'SEM-SELECIONAVEL:' + cands.length
  })()`)
  if (!picked || String(picked).startsWith('SEM-CANDIDATO') || String(picked).length < 4) {
    skip(`nenhum texto não editável para checar cópia nativa (${picked})`)
  } else {
    await clipboardWrite('SENTINELA-DOC')
    await press('c', MOD.ctrl)
    await sleep(250)
    const c = String(await clipboardRead())
    if (c.toLowerCase().includes(picked.slice(0, 12).toLowerCase())) ok(`Ctrl+C copiou seleção de texto comum (${JSON.stringify(picked.slice(0, 30))})`)
    else fail(`Ctrl+C não copiou seleção de texto comum (esperado ~${JSON.stringify(picked.slice(0, 20))}, veio ${JSON.stringify(c.slice(0, 40))})`)
    await evalJs(`window.getSelection()?.removeAllRanges()`)
  }

  if (child.exitCode !== null) fail(`processo main encerrou (code ${child.exitCode})`)
}

function finish() {
  if (finished) return
  finished = true
  try {
    ws?.close()
  } catch {}
  killTree()
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
  } catch {}
  writeFileSync(join(outDir, 'term-keys-main.log'), mainLog)
  if (/Uncaught Exception|A JavaScript error occurred in the main process/i.test(mainLog)) fail('erro não tratado no main (ver term-keys-main.log)')
  for (const e of rendererErrors) fail(`renderer: ${e}`)
  if (skips.length) console.log(`\n[term-keys] ${skips.length} pulado(s):\n- ${skips.join('\n- ')}`)
  console.log(failures.length ? `\n[term-keys] REPROVADO (${failures.length}):\n- ${failures.join('\n- ')}` : '\n[term-keys] APROVADO')
  process.exit(failures.length ? 1 : 0)
}

try {
  await main()
} catch (e) {
  fail(e.message)
  if (ws) await screenshot('term-99-falha')
} finally {
  finish()
}
