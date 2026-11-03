#!/usr/bin/env node
// Instala o swarm em ~/.hermes/cockpit/swarm-bin/ (caminho estável, independe
// de onde o app empacotado vive), cria o diretório de estado e registra o
// servidor MCP "claude_swarm" em mcp_servers dos profiles do Hermes.
// Idempotente: rodar de novo só atualiza os arquivos e a entrada claude_swarm.
//   node swarm/install.mjs [--profiles chief,atlas] [--no-profiles]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BIN_DIRS, IS_WIN, findBin, hermesHome, hermesToolDir } from './lib/platform.mjs'
import { BIN_DIR, HOME, STATE_DIR, ensureDirs } from './lib/state.mjs'

export { hermesHome }

const SRC = dirname(fileURLToPath(import.meta.url))
const BACKUP_SUFFIX = '.bak-20261101'
const ENTRY = 'claude_swarm'

/** Profiles que existem de fato (têm config.yaml) na raiz dada, em ordem. */
export function discoverProfiles(profilesDir, read = readdirSync, exists = existsSync) {
  try {
    return read(profilesDir)
      .filter((name) => !name.startsWith('.') && exists(join(profilesDir, name, 'config.yaml')))
      .sort()
  } catch {
    return [] // raiz sem profiles/ (Hermes não instalado ou em outro lugar)
  }
}

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true })
  let n = 0
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dst, name)
    if (statSync(s).isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      n += copyTree(s, d)
    } else if (name.endsWith('.mjs') || name.endsWith('.md')) {
      const next = readFileSync(s)
      if (!existsSync(d) || !readFileSync(d).equals(next)) {
        copyFileSync(s, d)
        n++
      }
    }
  }
  return n
}

function nodeBin() {
  // Caminho estável preferido, depois o node atual. No Windows o node do Hermes
  // (tools/node-*) é o mais estável; findBin cuida do .exe.
  if (IS_WIN) {
    const tool = hermesToolDir('node-', 'node.exe')
    if (tool) return tool
    return findBin('node', BIN_DIRS) ?? process.execPath
  }
  for (const c of [join(HOME, '.local', 'bin', 'node'), '/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (existsSync(c)) return c
  }
  return process.execPath
}

const q = (s) => JSON.stringify(s) // string YAML segura (JSON é subconjunto de YAML)

function entryBlock(profile, node, server) {
  return [
    `  ${ENTRY}:`,
    `    command: ${q(node)}`,
    `    args: [${q(server)}]`,
    `    env:`,
    `      SWARM_PROFILE: ${q(profile)}`,
    `    connect_timeout: 30`,
    `    timeout: 120`,
  ]
}

const isTopLevel = (line) => /^[^\s#]/.test(line)

/** Insere/substitui mcp_servers.claude_swarm sem tocar no resto do YAML. */
export function upsertMcpEntry(text, block) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^mcp_servers\s*:/.test(l))
  if (start === -1) {
    const body = text.endsWith('\n') || text === '' ? text : text + '\n'
    return body + ['mcp_servers:', ...block].join('\n') + '\n'
  }
  const head = lines[start]
  if (/^mcp_servers\s*:\s*(\{\s*\}|null|~)?\s*(#.*)?$/.test(head) === false) {
    throw new Error('mcp_servers em formato inline não suportado; edite à mão')
  }
  lines[start] = 'mcp_servers:'
  let end = start + 1
  while (end < lines.length && !isTopLevel(lines[end])) end++
  // dentro do bloco: procura a entrada existente
  let es = -1
  for (let i = start + 1; i < end; i++) {
    if (new RegExp(`^\\s{2}${ENTRY}\\s*:`).test(lines[i])) {
      es = i
      break
    }
  }
  if (es === -1) {
    // insere após a última linha não vazia do bloco
    let at = end
    while (at > start + 1 && lines[at - 1].trim() === '') at--
    lines.splice(at, 0, ...block)
  } else {
    let ee = es + 1
    while (ee < end && (lines[ee].trim() === '' || /^\s{3,}/.test(lines[ee]))) ee++
    while (ee > es + 1 && lines[ee - 1].trim() === '') ee--
    lines.splice(es, ee - es, ...block)
  }
  return lines.join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  const pIdx = argv.indexOf('--profiles')
  const profilesDir = join(hermesHome(), 'profiles')
  // Sem --profiles: registra nos profiles que existem de fato (os nomes variam
  // por instalação; uma lista fixa só acertaria a do macOS do Alexandre).
  const profiles = argv.includes('--no-profiles')
    ? []
    : pIdx !== -1
      ? String(argv[pIdx + 1] || '').split(',').filter(Boolean)
      : discoverProfiles(profilesDir)

  const copied = copyTree(SRC, BIN_DIR)
  ensureDirs()
  const node = nodeBin()
  const server = join(BIN_DIR, 'server.mjs')
  console.log(`swarm-bin: ${BIN_DIR} (${copied} arquivo(s) atualizado(s))`)
  console.log(`estado:    ${STATE_DIR}`)
  console.log(`node:      ${node}`)
  console.log(`profiles:  ${profilesDir}${profiles.length ? ` (${profiles.join(', ')})` : ' — nenhum encontrado'}`)

  for (const p of profiles) {
    const cfg = join(profilesDir, p, 'config.yaml')
    if (!existsSync(cfg)) {
      console.log(`profile ${p}: config.yaml ausente — pulado`)
      continue
    }
    const text = readFileSync(cfg, 'utf8')
    const next = upsertMcpEntry(text, entryBlock(p, node, server))
    if (next === text) {
      console.log(`profile ${p}: já registrado`)
      continue
    }
    if (!existsSync(cfg + BACKUP_SUFFIX)) writeFileSync(cfg + BACKUP_SUFFIX, text)
    writeFileSync(cfg, next)
    console.log(`profile ${p}: ${ENTRY} registrado (backup ${cfg + BACKUP_SUFFIX})`)
  }
}

// Rodado direto (e não importado)? No Windows o drive pode vir com caixa
// diferente em argv[1] e import.meta.url — compara normalizado, senão o
// install virava um no-op silencioso.
const asEntry = (a, b) => {
  const n = (x) => (IS_WIN ? resolve(x).toLowerCase() : resolve(x))
  return !!a && !!b && n(a) === n(b)
}
if (asEntry(process.argv[1], fileURLToPath(import.meta.url))) main()
