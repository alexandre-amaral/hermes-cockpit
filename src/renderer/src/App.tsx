import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Panel, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { BotsRail } from './components/BotsRail'
import { ChatPane } from './components/ChatPane'
import { DockPane } from './components/DockPane'
import { ErrorBoundary } from './components/ErrorBoundary'
import { StatusStrip } from './components/StatusStrip'
import { TopBar } from './components/TopBar'
import { CommandPalette, type PaletteItem, type PaletteSource } from './components/layout/CommandPalette'
import { ResizeHandle, useCollapseSync } from './components/layout/ResizeHandle'
import { SettingsPanel, type SettingsTab } from './components/layout/SettingsPanel'
import { useSwarmBadge } from './components/layout/useSwarmBadge'
import { VIEWS, ViewSlot } from './components/layout/views'
import { AutomationsView } from './components/automations/AutomationsView'
import { NotionView } from './components/notion/NotionView'
import { OpsView } from './components/ops/OpsView'
import { SwarmView } from './components/swarm/SwarmView'
import { TranscriberView } from './components/transcriber/TranscriberView'
import { VoiceOverlay } from './components/voice/VoiceOverlay'
import { Toaster } from './components/ui/Toaster'
import { RegionView } from './components/panels/RegionView'
import { SourceProvider, usePluginSource } from './components/panels/source'
import { API } from './components/panels/types'
import { botTitle, mergePluginBots, parseProfiles, type BotProfile } from './lib/bots'
import { connectBackend, saveManual, type Connection } from './lib/connection'
import { commandsCatalog, flattenCatalog, listSessions } from './lib/gateway'
import { hasMain, invoke } from './lib/ipc'
import {
  GROUP_IDS,
  NARROW_PX,
  SIZES,
  clearPaneSizes,
  isViewId,
  loadPrefs,
  safeStorage,
  savePrefs,
  visibleViews,
  type UiPrefs,
  type ViewId,
} from './lib/layout'
import { LAYOUT_PRESETS, loadRegions, resetRegions, saveRegions, type RegionLayout } from './lib/panels'
import { SPACES, SPACE_ORDER, inSpace, setSpace, spaceOfBot, useSpace, type Space } from './lib/space'
import { terminalWantsEvent } from './lib/term-keys'
import { HermesRpc, type ConnState } from './lib/rpc'
import { toast } from './lib/toast'
import {
  PRESETS,
  SCALE_STEP,
  applyTheme,
  clampScale,
  loadTheme,
  saveTheme,
  type ThemePreset,
  type ThemeSettings,
} from './lib/theme'

export function App() {
  const [conn, setConn] = useState<Connection | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [needsManual, setNeedsManual] = useState(false)
  const [connState, setConnState] = useState<ConnState>('idle')
  const [rpc, setRpc] = useState<HermesRpc | null>(null)

  // Tema aplicado antes de qualquer tela (inclusive erro/conexão manual).
  const [theme, setThemeState] = useState<ThemeSettings>(loadTheme)
  useEffect(() => {
    applyTheme(theme)
    saveTheme(theme)
  }, [theme])

  useEffect(() => {
    let alive = true
    let client: HermesRpc | null = null
    connectBackend()
      .then((c) => {
        if (!alive) return
        setConn(c)
        client = new HermesRpc()
        client.onState = (s) => alive && setConnState(s)
        client.connect(c.info.wsUrl)
        setRpc(client)
      })
      .catch((e: Error) => {
        if (!alive) return
        if (e.message === 'no-manual-connection') setNeedsManual(true)
        else setFatal(e.message)
      })
    return () => {
      alive = false
      client?.close()
    }
  }, [])

  if (needsManual) return <ManualConnect onDone={() => location.reload()} />

  if (fatal) {
    return (
      <div className="flex h-full items-center justify-center bg-void p-8">
        <div className="max-w-lg rounded-lg border border-alert/40 bg-panel p-6">
          <div className="label mb-2 text-alert">Falha ao subir o backend</div>
          <pre className="whitespace-pre-wrap text-[12px] text-dim">{fatal}</pre>
          <p className="mt-3 text-[11px] text-faint">
            Verifique se o CLI está no PATH (<code>which hermes</code>) e tente{' '}
            <code>hermes serve</code> manualmente.
          </p>
        </div>
      </div>
    )
  }

  return (
    <SourceProvider conn={conn}>
      <Cockpit conn={conn} rpc={rpc} connState={connState} theme={theme} setTheme={setThemeState} />
    </SourceProvider>
  )
}

interface CockpitProps {
  conn: Connection | null
  rpc: HermesRpc | null
  connState: ConnState
  theme: ThemeSettings
  setTheme: (t: ThemeSettings | ((t: ThemeSettings) => ThemeSettings)) => void
}

function Cockpit({ conn, rpc, connState, theme, setTheme }: CockpitProps) {
  // ─── bots: profiles.list (RPC) + /bots (plugin) ────────────────────────────
  const [rpcBots, setRpcBots] = useState<BotProfile[]>([])
  const [botsErr, setBotsErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>('chief')
  const pluginBots = usePluginSource<unknown>(API.bots, 300_000)

  useEffect(() => {
    if (!rpc || connState !== 'open') return
    let alive = true
    rpc
      .call('profiles.list')
      .then((res) => {
        if (!alive) return
        setRpcBots(parseProfiles(res))
        setBotsErr(null)
      })
      .catch((e: unknown) => alive && setBotsErr(`profiles.list: ${e instanceof Error ? e.message : String(e)}`))
    return () => {
      alive = false
    }
  }, [rpc, connState])

  // ─── espaço (Pessoal | Houer | Tudo): filtra bots; layout e prefs são por espaço ──
  const space = useSpace()

  const bots = useMemo(() => mergePluginBots(rpcBots, pluginBots.data), [rpcBots, pluginBots.data])
  const spaceBots = useMemo(() => bots.filter((b) => inSpace(spaceOfBot(b.name), space)), [bots, space])
  const bot = bots.find((b) => b.name === selected) ?? null
  const botsLoading = !conn || (connState === 'connecting' && bots.length === 0)
  const railError = botsErr ?? (pluginBots.error ? `/bots: ${pluginBots.error}` : null)
  // bot selecionado saiu do espaço → seleciona o primeiro do espaço (chief é compartilhado)
  useEffect(() => {
    if (spaceBots.length && !spaceBots.some((b) => b.name === selected)) setSelected(spaceBots[0].name)
  }, [spaceBots, selected])

  // ─── layout: prefs + regiões POR ESPAÇO, breakpoint ───────────────────────
  // Estado guarda a qual espaço pertence; trocar de espaço recarrega (ajuste
  // de estado durante o render — sem frame com o layout do espaço anterior).
  const [ps, setPs] = useState(() => ({ space, prefs: loadPrefs(space), regions: loadRegions(space) }))
  const [spaceFlash, setSpaceFlash] = useState(0)
  if (ps.space !== space) {
    setPs({ space, prefs: loadPrefs(space), regions: loadRegions(space) })
    setSpaceFlash((n) => n + 1)
  }
  const prefs = ps.prefs
  const regions = ps.regions
  const setPrefs = useCallback((patch: Partial<UiPrefs> | ((p: UiPrefs) => Partial<UiPrefs>)) => {
    setPs((s) => {
      const next = { ...s.prefs, ...(typeof patch === 'function' ? patch(s.prefs) : patch) }
      savePrefs(next, s.space)
      return { ...s, prefs: next }
    })
  }, [])
  const setRegions = useCallback((r: RegionLayout) => {
    setPs((s) => {
      saveRegions(r, s.space)
      return { ...s, regions: r }
    })
  }, [])
  const setRegionsState = (r: RegionLayout) => setPs((s) => ({ ...s, regions: r }))

  const narrow = useNarrow(theme.scale)
  const [railOverlay, setRailOverlay] = useState(false)
  const [dockOverlay, setDockOverlay] = useState(false)
  useEffect(() => {
    if (!narrow) {
      setRailOverlay(false)
      setDockOverlay(false)
    }
  }, [narrow])

  const [palette, setPalette] = useState(false)
  const [settings, setSettings] = useState<null | SettingsTab>(null)

  // ─── voz: overlay global; abre/fecha por botão, ⌘⇧V ou evento hc:voice ─────
  const [voiceOpen, setVoiceOpen] = useState(false)
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ open?: boolean } | undefined>).detail
      setVoiceOpen((v) => (typeof d?.open === 'boolean' ? d.open : !v))
    }
    window.addEventListener('hc:voice', on)
    return () => window.removeEventListener('hc:voice', on)
  }, [])

  const focus = prefs.focus
  const railVisible = prefs.railOpen && !focus && !narrow
  const dockVisible = prefs.dockOpen && !focus && !narrow
  const stripVisible = prefs.stripOpen && !focus

  const railRef = usePanelRef()
  const dockRef = usePanelRef()
  const stripRef = usePanelRef()
  // Último tamanho aberto (px CSS — a lib mede com offsetWidth, já sem o zoom) para restaurar após foco/janela estreita.
  const railPx = useRef<number | null>(null)
  const dockPx = useRef<number | null>(null)
  const stripPx = useRef<number | null>(null)
  const remember = (r: { current: number | null }) => (size: { inPixels: number }) => {
    if (size.inPixels > 1 && freeRef.current) r.current = Math.round(size.inPixels)
  }
  useCollapseSync(railRef, railVisible, railPx)
  useCollapseSync(dockRef, dockVisible, dockPx)
  useCollapseSync(stripRef, stripVisible, stripPx)

  const hLayout = useDefaultLayout({ id: GROUP_IDS.horizontal, storage: safeStorage, onlySaveAfterUserInteractions: true })
  const vLayout = useDefaultLayout({ id: GROUP_IDS.vertical, storage: safeStorage, onlySaveAfterUserInteractions: true })

  // Arrastar uma alça até colapsar = mudar a preferência (só interação do usuário).
  const freeLayout = !focus && !narrow
  const freeRef = useRef(freeLayout)
  freeRef.current = freeLayout

  const toggleRail = () => (narrow ? setRailOverlay((v) => !v) : setPrefs((p) => ({ railOpen: !p.railOpen, focus: false })))
  const toggleDock = () => (narrow ? setDockOverlay((v) => !v) : setPrefs((p) => ({ dockOpen: !p.dockOpen, focus: false })))
  const toggleStrip = () => setPrefs((p) => ({ stripOpen: !p.stripOpen, focus: false }))
  const toggleFocus = () => setPrefs((p) => ({ focus: !p.focus }))
  const bumpScale = (d: number) => setTheme((t) => ({ ...t, scale: clampScale(d === 0 ? 100 : t.scale + d) }))

  // ─── views da área central (ordem/visibilidade por espaço) ─────────────────
  const views = visibleViews(prefs)
  // view escondida continua acessível pelo ⌘K / hc:view; só cai no 1º se nada pedir
  const view = prefs.view
  const setView = useCallback((v: ViewId) => setPrefs({ view: v }), [setPrefs])
  const reorderViews = (visibleOrder: ViewId[]) => {
    // mantém as escondidas nas posições relativas: visíveis na nova ordem, escondidas no fim
    const hidden = prefs.viewOrder.filter((v) => prefs.hiddenViews.includes(v))
    setPrefs({ viewOrder: [...visibleOrder, ...hidden] })
  }
  const applyPreset = (id: string) => {
    const pr = LAYOUT_PRESETS.find((x) => x.id === id)
    if (!pr) return
    setPrefs({ ...pr.prefs, view: pr.view })
    setRegions(pr.regions)
    const sp = SPACES.find((x) => x.id === space)?.label ?? space
    toast({ title: `Layout ${pr.label}`, detail: `${pr.hint} — espaço ${sp}`, tone: 'ok' })
  }
  const swarmBadge = useSwarmBadge()

  // Intents para componentes de outros donos via window CustomEvent (hc:*).
  // Despachados num efeito DEPOIS do commit que troca a view: a view recém-
  // montada (efeitos dos filhos rodam antes dos do pai) já está ouvindo.
  const [intent, setIntent] = useState<{ name: string; detail?: unknown; seq: number } | null>(null)
  const emit = useCallback(
    (name: string, detail?: unknown) => setIntent((p) => ({ name, detail, seq: (p?.seq ?? 0) + 1 })),
    [],
  )
  useEffect(() => {
    if (intent) window.dispatchEvent(new CustomEvent(intent.name, { detail: intent.detail }))
  }, [intent])

  // Eventos de entrada: hc:dock-tab (detail = id da aba do dock) e hc:view (detail = ViewId).
  const narrowRef = useRef(narrow)
  narrowRef.current = narrow
  useEffect(() => {
    const onDockTab = (e: Event) => {
      const id = (e as CustomEvent<unknown>).detail
      if (typeof id !== 'string' || !id) return
      setPrefs((p) => ({ dockTab: id, ...(p.focus ? {} : { dockOpen: true }) }))
      if (narrowRef.current) setDockOverlay(true)
    }
    const onView = (e: Event) => {
      const v = (e as CustomEvent<unknown>).detail
      if (isViewId(v)) setView(v)
    }
    window.addEventListener('hc:dock-tab', onDockTab)
    window.addEventListener('hc:view', onView)
    return () => {
      window.removeEventListener('hc:dock-tab', onDockTab)
      window.removeEventListener('hc:view', onView)
    }
  }, [setPrefs, setView])

  const resetSizes = () => {
    clearPaneSizes()
    setPrefs({ railOpen: true, dockOpen: true, stripOpen: true, dockCardsOpen: true, focus: false })
    requestAnimationFrame(() => {
      try {
        railRef.current?.resize(SIZES.rail.default)
        dockRef.current?.resize(SIZES.dock.default)
        stripRef.current?.resize(SIZES.strip.default)
      } catch {
        /* painel colapsado ainda expandindo */
      }
    })
  }

  // ─── atalhos ──────────────────────────────────────────────────────────────
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return
    // Terminal focado tem precedência nas teclas dele (Ctrl+Shift+V = colar,
    // não ditado; Ctrl+= / - / 0 = fonte do PTY, não escala da UI). O resto
    // dos atalhos globais (⌘K, views, espaços...) continua passando.
    if (terminalWantsEvent(e)) return
    const k = e.key.toLowerCase()
    const act = (fn: () => void) => {
      e.preventDefault()
      fn()
    }
    // ⌘⇧1/2/3 → espaço (e.code: com shift o e.key vira !, @, #)
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1]
    if (e.shiftKey && digit && Number(digit) <= SPACE_ORDER.length) return act(() => setSpace(SPACE_ORDER[Number(digit) - 1]))
    if (e.shiftKey && k === 'v') return act(() => setVoiceOpen((v) => !v))
    if (k === 'k') act(() => setPalette((v) => !v))
    else if (k === '.') act(toggleFocus)
    else if (k === '=' || k === '+') act(() => bumpScale(SCALE_STEP))
    else if (k === '-' || k === '_') act(() => bumpScale(-SCALE_STEP))
    else if (k === '0') act(() => bumpScale(0))
    else if (k === 'b' && !e.shiftKey) act(toggleRail)
    else if (k === 'j' && !e.shiftKey) act(toggleDock)
    else if (k === ',') act(() => setSettings('aparencia'))
    else if (/^[1-9]$/.test(k) && !e.shiftKey && views[Number(k) - 1]) act(() => setView(views[Number(k) - 1]))
    // ⌘T de qualquer view: volta ao Chat; o ChatPane (sempre montado) cria a conversa nova.
    else if (k === 't' && !e.shiftKey) setView('chat')
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [])

  // ─── command palette ──────────────────────────────────────────────────────
  const selectBot = (name: string) => {
    setSelected(name)
    setRailOverlay(false)
  }
  const resetLayout = () => {
    resetSizes()
    setRegionsState(resetRegions(space))
    toast({ title: 'Layout restaurado', detail: 'tamanhos, painéis abertos e blocos das regiões voltaram ao padrão do espaço', tone: 'ok' })
  }

  const paletteItems: PaletteItem[] = [
    ...VIEWS.map((v) => {
      const pos = views.indexOf(v.id)
      return {
        id: `view:${v.id}`,
        group: 'Views',
        icon: v.glyph,
        label: `Ir para ${v.label}`,
        hint: v.id === view ? 'atual' : pos < 0 ? 'escondida da barra' : undefined,
        keywords: `${v.id} ${v.hint}`,
        shortcut: pos >= 0 && pos < 9 ? ['⌘', String(pos + 1)] : undefined,
        preview: { title: v.label, body: v.hint },
        run: () => setView(v.id),
      }
    }),
    ...SPACE_ORDER.map((id, i) => {
      const d = SPACES.find((x) => x.id === id)!
      return {
        id: `space:${id}`,
        group: 'Espaço',
        icon: id === space ? '●' : '○',
        label: `Espaço ${d.label}`,
        hint: id === space ? 'atual' : d.hint,
        keywords: `espaço space ${id} ${d.hint}`,
        shortcut: ['⌘', '⇧', String(i + 1)],
        run: () => setSpace(id as Space),
      }
    }),
    ...LAYOUT_PRESETS.map((pr) => ({
      id: `preset:${pr.id}`,
      group: 'Layout',
      icon: '▦',
      label: `Preset ${pr.label}`,
      keywords: `layout preset ${pr.hint}`,
      preview: { title: `Preset ${pr.label}`, body: pr.hint },
      run: () => applyPreset(pr.id),
    })),
    {
      id: 'act:voice',
      group: 'Ações',
      icon: '◉',
      label: voiceOpen ? 'Fechar modo voz' : 'Modo voz',
      keywords: 'voz voice falar microfone',
      shortcut: ['⌘', '⇧', 'V'],
      run: () => setVoiceOpen((v) => !v),
    },
    ...spaceBots.map((b) => ({
      id: `bot:${b.name}`,
      group: 'Bots',
      icon: b.rodando ? '●' : '◇',
      label: botTitle(b.name),
      hint: [b.name, b.modelo].filter(Boolean).join(' · '),
      keywords: `chat ${b.group} ${b.provider ?? ''} ${b.descricao ?? ''}`,
      preview: {
        title: `Bot Chat · ${botTitle(b.name)}`,
        body: b.descricao ?? 'abre o chat eterno deste bot',
        rows: [
          ['profile', b.name],
          ['grupo', b.group],
          ['modelo', b.modelo ?? '—'],
          ['provider', b.provider ?? '—'],
          ['sessões', b.sessoes != null ? String(b.sessoes) : '—'],
          ['estado', b.rodando ? 'rodando' : 'parado'],
        ] as Array<[string, string]>,
      },
      run: () => {
        selectBot(b.name)
        setView('chat')
      },
    })),
    ...(bot
      ? [
          {
            id: 'act:side-chat',
            group: 'Ações',
            icon: '+',
            label: `Novo side-chat com ${botTitle(bot.name)}`,
            keywords: 'sessão nova conversa',
            preview: { body: 'cria uma sessão visível nova para o bot selecionado (o Bot Chat continua intacto)' },
            run: () => {
              setView('chat')
              emit('hc:chat-new-side', { profile: bot.name })
            },
          },
        ]
      : []),
    {
      id: 'act:claude-task',
      group: 'Ações',
      icon: '⋮⋮',
      label: 'Nova tarefa Claude Code',
      keywords: 'swarm run spawn worktree delegar',
      preview: { body: 'abre o Swarm com o formulário de nova run (worktree isolado + aprovação na UI)' },
      run: () => {
        setView('swarm')
        emit('hc:swarm-new-task', {})
      },
    },
    { id: 'focus', group: 'Layout', icon: '◎', label: focus ? 'Sair do modo foco' : 'Modo foco', shortcut: ['⌘', '.'], run: toggleFocus },
    { id: 'rail', group: 'Layout', icon: '◧', label: 'Alternar rail de bots', shortcut: ['⌘', 'B'], run: toggleRail },
    { id: 'dock', group: 'Layout', icon: '◨', label: 'Alternar dock', shortcut: ['⌘', 'J'], run: toggleDock },
    { id: 'strip', group: 'Layout', icon: '▁', label: 'Alternar strip inferior', run: toggleStrip },
    {
      id: 'cards',
      group: 'Layout',
      icon: '▤',
      label: 'Alternar cards do dock',
      run: () => setPrefs((p) => ({ dockCardsOpen: !p.dockCardsOpen })),
    },
    { id: 'panels', group: 'Layout', icon: '▦', label: 'Configurar painéis…', run: () => setSettings('paineis') },
    { id: 'reset-sizes', group: 'Layout', icon: '↺', label: 'Restaurar tamanhos dos painéis', run: resetSizes },
    {
      id: 'reset-layout',
      group: 'Layout',
      icon: '↺',
      label: 'Resetar layout (tamanhos + blocos)',
      preview: { body: 'volta tamanhos, panes abertos e blocos de strip/dock/rail ao padrão' },
      run: resetLayout,
    },
    ...(Object.keys(PRESETS) as ThemePreset[]).map((id) => ({
      id: `theme:${id}`,
      group: 'Tema',
      icon: theme.preset === id ? '●' : '○',
      label: `Tema ${PRESETS[id].label}`,
      hint: theme.preset === id ? 'atual' : undefined,
      run: () => setTheme((t) => ({ ...t, preset: id })),
    })),
    { id: 'zoom-in', group: 'Tema', icon: '+', label: 'Aumentar escala', hint: `${theme.scale}%`, shortcut: ['⌘', '='], run: () => bumpScale(SCALE_STEP) },
    { id: 'zoom-out', group: 'Tema', icon: '−', label: 'Diminuir escala', hint: `${theme.scale}%`, shortcut: ['⌘', '-'], run: () => bumpScale(-SCALE_STEP) },
    { id: 'zoom-reset', group: 'Tema', icon: '=', label: 'Escala 100%', shortcut: ['⌘', '0'], run: () => bumpScale(0) },
    { id: 'settings', group: 'App', icon: '⚙', label: 'Configurações…', shortcut: ['⌘', ','], run: () => setSettings('aparencia') },
    { id: 'views-cfg', group: 'Layout', icon: '▤', label: 'Configurar views da barra…', run: () => setSettings('views') },
  ]

  // Fontes assíncronas da paleta (carregam ao abrir; falha vira linha de erro na seção).
  const paletteSources: PaletteSource[] = []
  if (rpc && connState === 'open' && bot) {
    const profile = bot.name
    paletteSources.push(
      {
        group: 'Sessões recentes',
        load: async () => {
          const rows = await listSessions(rpc, profile, 12)
          return rows.map((r) => {
            const title = r.title?.trim() || r.preview?.trim().slice(0, 60) || r.id
            const when = typeof r.started_at === 'number' ? new Date(r.started_at * (r.started_at < 1e12 ? 1000 : 1)) : null
            return {
              id: `session:${r.id}`,
              group: 'Sessões recentes',
              icon: '❐',
              label: title,
              hint: [botTitle(profile), r.message_count != null ? `${r.message_count} msgs` : null].filter(Boolean).join(' · '),
              keywords: `${r.preview ?? ''} ${r.source ?? ''}`,
              preview: {
                title,
                body: r.preview || undefined,
                rows: [
                  ['bot', botTitle(profile)],
                  ['início', when ? when.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'],
                  ['mensagens', r.message_count != null ? String(r.message_count) : '—'],
                  ['origem', r.source ?? '—'],
                ] as Array<[string, string]>,
              },
              run: () => {
                setView('chat')
                emit('hc:chat-open-session', { profile, id: r.id, title })
              },
            }
          })
        },
      },
      {
        group: 'Comandos',
        load: async () => {
          const cmds = flattenCatalog(await commandsCatalog(rpc, { profile }))
          return cmds
            .sort((a, b) => b.usage - a.usage || a.name.localeCompare(b.name))
            .map((c) => ({
              id: `cmd:${c.name}`,
              group: 'Comandos',
              icon: c.kind === 'skill' ? '✦' : '/',
              label: c.name,
              hint: c.description && c.description !== 'skill' ? c.description.slice(0, 70) : c.kind,
              preview: {
                title: c.name,
                body: c.description || undefined,
                rows: [
                  ['tipo', c.kind === 'skill' ? 'skill' : 'comando'],
                  ['uso', String(c.usage)],
                  ['bot', botTitle(profile)],
                ] as Array<[string, string]>,
              },
              run: () => {
                setView('chat')
                emit('hc:chat-insert', { text: `${c.name} ` })
              },
            }))
        },
      },
    )
  }
  if (hasMain()) {
    paletteSources.push({
      group: 'Repos',
      load: async () => {
        const repos = await invoke<unknown>('ops:repos')
        if (!Array.isArray(repos)) throw new Error('ops:repos sem lista')
        type Repo = { path: string; name: string; branch?: string; dirty: number; ahead?: number; behind?: number; lastCommit?: string }
        return (repos as Repo[])
          .filter((r) => r && typeof r.path === 'string')
          .map((r) => ({
            id: `repo:${r.path}`,
            group: 'Repos',
            icon: '⎇',
            label: `Abrir ${r.name || r.path}`,
            hint: [r.branch, r.dirty ? `${r.dirty} alterado(s)` : 'limpo'].filter(Boolean).join(' · '),
            keywords: `repo git vscode ${r.path}`,
            preview: {
              title: r.name || r.path,
              body: 'abre no VS Code',
              rows: [
                ['caminho', r.path],
                ['branch', r.branch ?? '—'],
                ['alterados', String(r.dirty ?? 0)],
                ['↑/↓', `${r.ahead ?? 0} / ${r.behind ?? 0}`],
                ['último', r.lastCommit ?? '—'],
              ] as Array<[string, string]>,
            },
            run: () => {
              invoke('ops:open', { kind: 'vscode', path: r.path }).catch((e: unknown) =>
                toast({ title: `Não abriu ${r.name || r.path}`, detail: e instanceof Error ? e.message : String(e), tone: 'error' }),
              )
            },
          }))
      },
    })
  }

  const rail = (
    <ErrorBoundary label="Bots">
    <BotsRail
      bots={spaceBots}
      space={space}
      hiddenCount={bots.length - spaceBots.length}
      selected={selected}
      onSelect={(n) => {
        selectBot(n)
        // escolher um bot na rail leva ao chat dele
        if (view !== 'chat') setView('chat')
      }}
      loading={botsLoading}
      error={railError}
      footer={
        <RegionView
          region="rail"
          ids={regions.rail}
          orientation="vertical"
          minPx={48}
          onChange={(ids) => setRegions({ ...regions, rail: ids })}
          emptyText="rodapé vazio — use + para adicionar."
        />
      }
    />
    </ErrorBoundary>
  )
  const dock = (
    <ErrorBoundary label="Dock">
    <DockPane
      rpc={rpc}
      tab={prefs.dockTab}
      onTabChange={(id) => setPrefs({ dockTab: id })}
      cards={regions.dock}
      onCardsChange={(ids) => setRegions({ ...regions, dock: ids })}
      cardsOpen={prefs.dockCardsOpen}
      onCardsOpenChange={(open) => setPrefs({ dockCardsOpen: open })}
    />
    </ErrorBoundary>
  )

  return (
    <div className="flex h-full flex-col bg-void" data-narrow={narrow || undefined} data-focus={focus || undefined}>
      <ErrorBoundary
        label="Topbar"
        compact
        className={`app-drag h-11 shrink-0 border-b border-edge bg-panel ${window.hermes?.platform === 'darwin' ? 'pl-[84px]' : ''}`}
      >
      <TopBar
        connState={connState}
        electron={Boolean(window.hermes)}
        narrow={narrow}
        railOpen={narrow ? railOverlay : prefs.railOpen}
        dockOpen={narrow ? dockOverlay : prefs.dockOpen}
        focus={focus}
        view={view}
        views={views}
        onView={setView}
        onReorderViews={reorderViews}
        swarm={swarmBadge}
        voiceOpen={voiceOpen}
        onToggleVoice={() => setVoiceOpen((v) => !v)}
        onOpenPalette={() => setPalette(true)}
        onToggleRail={toggleRail}
        onToggleDock={toggleDock}
        onToggleFocus={toggleFocus}
        onOpenSettings={() => setSettings('aparencia')}
      />
      </ErrorBoundary>

      <div className="relative min-h-0 flex-1">
        <Group
          id={GROUP_IDS.vertical}
          orientation="vertical"
          className="h-full"
          defaultLayout={vLayout.defaultLayout}
          onLayoutChanged={(l, meta) => {
            vLayout.onLayoutChanged(l, meta)
            if (meta.isUserInteraction && !focus && l.strip !== undefined) {
              const open = l.strip > 0.5
              if (open !== prefs.stripOpen) setPrefs({ stripOpen: open })
            }
          }}
        >
          <Panel id="body" minSize={SIZES.bodyMin}>
            <Group
              id={GROUP_IDS.horizontal}
              orientation="horizontal"
              className="h-full"
              defaultLayout={hLayout.defaultLayout}
              onLayoutChanged={(l, meta) => {
                hLayout.onLayoutChanged(l, meta)
                if (!meta.isUserInteraction || !freeRef.current) return
                const patch: Partial<UiPrefs> = {}
                if (l.rail !== undefined && l.rail > 0.5 !== prefs.railOpen) patch.railOpen = l.rail > 0.5
                if (l.dock !== undefined && l.dock > 0.5 !== prefs.dockOpen) patch.dockOpen = l.dock > 0.5
                if (Object.keys(patch).length) setPrefs(patch)
              }}
            >
              <Panel
                id="rail"
                panelRef={railRef}
                onResize={remember(railPx)}
                collapsible
                collapsedSize={0}
                defaultSize={SIZES.rail.default}
                minSize={SIZES.rail.min}
                maxSize={SIZES.rail.max}
                groupResizeBehavior="preserve-pixel-size"
              >
                {!narrow && rail}
              </Panel>
              <ResizeHandle
                orientation="horizontal"
                title="arraste para redimensionar · duplo clique recolhe/expande a rail"
                onToggle={toggleRail}
                disabled={!freeLayout}
              />
              <Panel id="chat" minSize={SIZES.chatMin}>
                {/* Área central: views empilhadas. Chat fica sempre montado (stream não cai);
                    as outras montam na 1ª visita e ficam vivas escondidas (useViewActive). */}
                <div className="relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-void">
                  <div aria-hidden className="hc-aurora" />
                  {spaceFlash > 0 && <div key={spaceFlash} aria-hidden className="hc-space-flash pointer-events-none absolute inset-0 z-[5]" />}
                  <ViewSlot id="chat" active={view === 'chat'} keepMounted>
                    <ErrorBoundary label="Chat">
                      <ChatPane rpc={rpc} bot={bot} connState={connState} />
                    </ErrorBoundary>
                  </ViewSlot>
                  <ViewSlot id="swarm" active={view === 'swarm'}>
                    <ErrorBoundary label="Swarm">
                      <SwarmView rpc={rpc} />
                    </ErrorBoundary>
                  </ViewSlot>
                  <ViewSlot id="automacoes" active={view === 'automacoes'}>
                    <AutomationsView rpc={rpc} />
                  </ViewSlot>
                  <ViewSlot id="notion" active={view === 'notion'}>
                    <NotionView rpc={rpc} />
                  </ViewSlot>
                  <ViewSlot id="ops" active={view === 'ops'}>
                    <ErrorBoundary label="Ops">
                      <OpsView rpc={rpc} />
                    </ErrorBoundary>
                  </ViewSlot>
                  <ViewSlot id="transcrever" active={view === 'transcrever'}>
                    <ErrorBoundary label="Transcrever">
                      <TranscriberView />
                    </ErrorBoundary>
                  </ViewSlot>
                </div>
              </Panel>
              <ResizeHandle
                orientation="horizontal"
                title="arraste para redimensionar · duplo clique recolhe/expande o dock"
                onToggle={toggleDock}
                disabled={!freeLayout}
              />
              <Panel
                id="dock"
                panelRef={dockRef}
                onResize={remember(dockPx)}
                collapsible
                collapsedSize={0}
                defaultSize={SIZES.dock.default}
                minSize={SIZES.dock.min}
                maxSize={SIZES.dock.max}
                groupResizeBehavior="preserve-pixel-size"
              >
                {!narrow && dock}
              </Panel>
            </Group>
          </Panel>
          <ResizeHandle
            orientation="vertical"
            title="arraste para redimensionar · duplo clique recolhe/expande a strip"
            onToggle={toggleStrip}
            disabled={focus}
          />
          <Panel
            id="strip"
            panelRef={stripRef}
            onResize={(size) => !focus && size.inPixels > 1 && (stripPx.current = Math.round(size.inPixels))}
            collapsible
            collapsedSize={0}
            defaultSize={SIZES.strip.default}
            minSize={SIZES.strip.min}
            maxSize={SIZES.strip.max}
            groupResizeBehavior="preserve-pixel-size"
          >
            <ErrorBoundary label="Strip">
              <StatusStrip panels={regions.strip} onChange={(ids) => setRegions({ ...regions, strip: ids })} />
            </ErrorBoundary>
          </Panel>
        </Group>

        {/* Janela estreita: rail e dock viram gavetas sobre o chat. */}
        {narrow && railOverlay && !focus && (
          <Drawer side="left" onClose={() => setRailOverlay(false)}>
            {rail}
          </Drawer>
        )}
        {narrow && dockOverlay && !focus && (
          <Drawer side="right" onClose={() => setDockOverlay(false)}>
            {dock}
          </Drawer>
        )}
        {/* modo foco: saída pelo ◎ da topbar (ativo/âmbar) ou ⌘. — sem botão flutuante sobre o header do chat */}
      </div>

      {palette && (
        <ErrorBoundary label="Paleta">
          <CommandPalette items={paletteItems} sources={paletteSources} onClose={() => setPalette(false)} />
        </ErrorBoundary>
      )}
      {settings && (
        <ErrorBoundary label="Configurações" className="fixed inset-y-0 right-0 z-50 w-[min(380px,100vw)] border-l border-edge2 bg-panel">
        <SettingsPanel
          initialTab={settings}
          theme={theme}
          onTheme={(t) => setTheme(t)}
          regions={regions}
          onRegions={setRegions}
          onResetRegions={() => setRegionsState(resetRegions(space))}
          onResetSizes={resetSizes}
          onClose={() => setSettings(null)}
          space={space}
          viewOrder={prefs.viewOrder}
          hiddenViews={prefs.hiddenViews}
          onViews={(order, hidden) => {
            const vis = order.filter((v) => !hidden.includes(v))
            setPrefs((p) => ({ viewOrder: order, hiddenViews: hidden, ...(vis.includes(p.view) ? {} : { view: vis[0] ?? 'chat' }) }))
          }}
          onPreset={applyPreset}
        />
        </ErrorBoundary>
      )}
      <ErrorBoundary label="Voz" compact>
        <VoiceOverlay rpc={rpc} bot={selected} open={voiceOpen} onClose={() => setVoiceOpen(false)} />
      </ErrorBoundary>
      <ErrorBoundary label="Toasts" compact>
        <Toaster />
      </ErrorBoundary>
    </div>
  )
}

function Drawer({ side, onClose, children }: { side: 'left' | 'right'; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="no-drag hc-scrim absolute inset-0 z-30 flex"
      onMouseDown={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        className={`h-full w-[min(360px,85%)] shadow-[var(--hc-shadow-3)] ${
          side === 'left' ? 'hc-slide-left border-r' : 'hc-slide-right ml-auto border-l'
        } border-edge2`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

// Largura "lógica" (descontando a escala da UI) abaixo do breakpoint.
function useNarrow(scale: number): boolean {
  const calc = () => window.innerWidth / (scale / 100) < NARROW_PX
  const [narrow, setNarrow] = useState(calc)
  useEffect(() => {
    const on = () => setNarrow(calc())
    on()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale])
  return narrow
}

// Modo navegador (dev:web): sem bridge do Electron, conecta com URL + token.
function ManualConnect({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('http://127.0.0.1:8642')
  const [token, setToken] = useState('')
  return (
    <div className="flex h-full items-center justify-center bg-void p-8">
      <form
        className="w-full max-w-md rounded-lg border border-edge bg-panel p-6"
        onSubmit={(e) => {
          e.preventDefault()
          saveManual(url, token)
          onDone()
        }}
      >
        <div className="label mb-1">Modo navegador</div>
        <h1 className="font-display mb-4 text-xl">Conectar ao hermes serve</h1>
        <label className="label mb-1 block">Base URL</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="mb-3 w-full rounded border border-edge bg-void px-3 py-2 text-ink focus:border-amber focus:outline-none"
        />
        <label className="label mb-1 block">Session token</label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="token do serve"
          className="mb-4 w-full rounded border border-edge bg-void px-3 py-2 text-ink focus:border-amber focus:outline-none"
        />
        <button
          type="submit"
          className="w-full rounded bg-amber py-2 text-[12px] font-semibold text-void hover:brightness-110"
        >
          Conectar
        </button>
      </form>
    </div>
  )
}
