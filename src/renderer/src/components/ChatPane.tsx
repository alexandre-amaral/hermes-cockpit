import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { BOT_TITLES, type BotProfile } from '../lib/bots'
import { chatReducer, initialChat, type PendingApproval } from '../lib/chat-store'
import { api } from '../lib/ipc'
import { HERMES_APPROVAL_LABEL, setAutoMode, useAutoMode, type HermesApproval } from '../lib/automode'
import { SPACES, inSpace, spaceOfBot, useSpace } from '../lib/space'
import { openChatWindow } from '../lib/windows'
import { toast } from '../lib/toast'
import {
  closeSession,
  commandDispatch,
  commandsCatalog,
  createSideChat,
  execSlash,
  flattenCatalog,
  getProfileModel,
  interruptTurn,
  listSessions,
  parseGatewayEvent,
  renameSession,
  resolveBotChat,
  respondApproval,
  resumeSession,
  setApprovalMode,
  submitPrompt,
  type ApprovalChoice,
  type ApprovalRequest,
  type ProfileModel,
  type SessionLiveInfo,
  type SessionRow,
  type SlashCommand,
  type SlashExecResult,
} from '../lib/gateway'
import { RpcError, type ConnState, type HermesRpc } from '../lib/rpc'
import { ApprovalCard } from './chat/ApprovalCard'
import { CANONICAL_KEY, ChatTabs, sideKey, type ChatTab } from './chat/ChatTabs'
import { Composer } from './chat/Composer'
import { ModelPicker } from './chat/ModelPicker'
import { SessionDrawer } from './chat/SessionDrawer'
import { Transcript } from './chat/Transcript'

interface Props {
  rpc: HermesRpc | null
  bot: BotProfile | null
  connState: ConnState
}

/** Sessão aberta no painel. `runtimeId` é o id que prompt/eventos usam; o id armazenado
 *  só vive em memória enquanto a sessão está aberta (identidade do Bot Chat = título). */
interface OpenSession {
  profile: string
  runtimeId: string
  storedId: string | null
}

type Load = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; message: string }

const VERBOSE_KEY = 'hermes-cockpit.chat.verbose'
/** Por bot: SÓ os ids armazenados das abas de side-chat abertas, na ordem da faixa.
 *  O Bot Chat nunca entra aqui (regra Bot Mode: identidade = título, resolvida a cada
 *  abertura). Side-chats "fresh" (sem linha no DB) só entram após o 1º prompt. */
const TABS_KEY = (profile: string) => `hermes-cockpit.chat.tabs.${profile}`

function readTabIds(profile: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY(profile)) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 24) : []
  } catch {
    return []
  }
}

function writeTabIds(profile: string, ids: string[]): void {
  try {
    localStorage.setItem(TABS_KEY(profile), JSON.stringify(ids))
  } catch {
    /* preferência local opcional */
  }
}

const CANONICAL_TAB: ChatTab = { key: CANONICAL_KEY, kind: 'canonical', title: 'Bot Chat' }

function shortTitle(row: SessionRow | undefined, fallback: string): string {
  return row?.title?.trim() || row?.preview?.trim().slice(0, 40) || fallback
}

function readVerbose(): boolean {
  try {
    return localStorage.getItem(VERBOSE_KEY) === '1'
  } catch {
    return false
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function titleFor(name: string): string {
  return BOT_TITLES[name] ?? (name ? name[0].toUpperCase() + name.slice(1) : name)
}

export function ChatPane({ rpc, bot, connState }: Props) {
  const profile = bot?.name ?? null
  const title = profile ? titleFor(profile) : '—'
  const online = Boolean(rpc) && connState === 'open'

  const [chat, dispatch] = useReducer(chatReducer, initialChat)
  const [sideTabs, setSideTabs] = useState<ChatTab[]>([])
  const [activeKey, setActiveKey] = useState<string>(CANONICAL_KEY)
  const [session, setSession] = useState<OpenSession | null>(null)
  const [load, setLoad] = useState<Load>({ phase: 'idle' })
  const [reloadNonce, setReloadNonce] = useState(0)
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [model, setModel] = useState<ProfileModel | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [sideChats, setSideChats] = useState<SessionRow[]>([])
  const [sideError, setSideError] = useState<string | null>(null)
  const [verbose, setVerbose] = useState(readVerbose)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerNonce, setDrawerNonce] = useState(0)
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null)
  /** troca "este chat" bem-sucedida: o chip mostra o modelo da sessão até trocar de aba */
  const [sessionModel, setSessionModel] = useState<{ key: string; model: string; provider: string } | null>(null)
  /** keys de abas com turno em andamento (eventos de qualquer sessão que abrimos) */
  const [streaming, setStreaming] = useState<Set<string>>(() => new Set())
  /** runtimeId ↔ tab key de toda sessão que este painel resumiu (abas em 2º plano) */
  const runtimeByKey = useRef(new Map<string, string>())
  /** profile dono de `sideTabs` — enquanto difere de `profile`, nada abre (troca de bot) */
  const [tabsFor, setTabsFor] = useState<string | null>(null)

  const tabs = useMemo(() => [CANONICAL_TAB, ...sideTabs], [sideTabs])
  const activeTab = tabs.find((t) => t.key === activeKey) ?? CANONICAL_TAB
  const target = activeTab

  const activeSid = useRef<string | null>(null)
  activeSid.current = session?.runtimeId ?? null
  const loadToken = useRef(0)
  /** side-chat recém-criado (lazy: ainda sem linha no DB, não dá para dar resume) */
  const freshSide = useRef<{ storedId: string; runtimeId: string; info: SessionLiveInfo } | null>(null)
  const resolvers = useRef(new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>())
  const approvalSeq = useRef(0)
  /** `${session_id}::${request_id}` → card vivo, para deduplicar re-entregas de open_requests */
  const liveByRequest = useRef(new Map<string, { key: string; promise: Promise<unknown> }>())

  // ── troca de bot: volta para o Bot Chat canônico ──────────────────────────
  useEffect(() => {
    setActiveKey(CANONICAL_KEY)
    setPickerOpen(false)
    setDrawerOpen(false)
    setModel(null)
    setModelError(null)
    setSessionModel(null)
    setStreaming(new Set())
    runtimeByKey.current.clear()
    freshSide.current = null
    setTabsFor(profile)
    // abas persistidas: só ids; títulos chegam com a lista de side-chats
    setSideTabs(profile ? readTabIds(profile).map((id) => ({ key: sideKey(id), kind: 'side' as const, storedId: id, title: 'side-chat' })) : [])
  }, [profile])

  // persiste a ordem/conjunto de abas (sem as fresh e nunca o Bot Chat)
  useEffect(() => {
    if (!profile || tabsFor !== profile) return
    writeTabIds(
      profile,
      sideTabs.filter((t) => t.kind === 'side' && t.storedId && !t.fresh).map((t) => t.storedId as string),
    )
  }, [sideTabs, profile, tabsFor])

  // títulos das abas a partir da lista de side-chats do profile
  useEffect(() => {
    if (!sideChats.length) return
    const byId = new Map(sideChats.map((r) => [r.id, r]))
    setSideTabs((prev) => {
      let changed = false
      const next = prev.map((t) => {
        const row = t.storedId ? byId.get(t.storedId) : undefined
        if (!row) return t
        const title = shortTitle(row, t.title)
        if (title === t.title && !t.fresh) return t
        changed = true
        return { ...t, title, fresh: false }
      })
      return changed ? next : prev
    })
  }, [sideChats])

  useEffect(() => setSessionModel(null), [activeKey])

  // título vindo da própria sessão (resume/session.info) — cobre abas ocultas/fora da lista
  const infoTitle = typeof chat.info?.title === 'string' ? chat.info.title.trim() : ''
  useEffect(() => {
    if (!infoTitle || activeKey === CANONICAL_KEY || infoTitle === 'Bot Chat') return
    setSideTabs((prev) => prev.map((t) => (t.key === activeKey && t.title !== infoTitle ? { ...t, title: infoTitle } : t)))
  }, [infoTitle, activeKey])

  useEffect(() => {
    try {
      localStorage.setItem(VERBOSE_KEY, verbose ? '1' : '0')
    } catch {
      /* preferência local opcional */
    }
  }, [verbose])

  // ── aprovações ─────────────────────────────────────────────────────────────
  const addApproval = useCallback((a: PendingApproval) => {
    setApprovals((prev) => {
      const rid = a.request.request_id
      if (rid && prev.some((p) => p.request.request_id === rid && p.sessionId === a.sessionId)) return prev
      return [...prev, a]
    })
  }, [])

  const dropApproval = useCallback((key: string, reason?: string) => {
    const r = resolvers.current.get(key)
    if (r) {
      resolvers.current.delete(key)
      if (reason) r.reject(new Error(reason))
    }
    setApprovals((prev) => prev.filter((p) => p.key !== key))
  }, [])

  /** request.cancel não diz qual card morreu (o handler não recebe o id JSON-RPC):
   *  reconcilia com approval.pending da sessão. */
  const reconcileApprovals = useCallback(
    async (sessionId: string) => {
      if (!rpc) return
      let pending: ApprovalRequest[] = []
      try {
        const res = await rpc.call<{ approvals?: ApprovalRequest[] }>('approval.pending', { session_id: sessionId })
        pending = res?.approvals ?? []
      } catch (e) {
        // 4001 = sessão não está viva (fechada/reaped): nenhum card dela sobrevive.
        // Outras falhas (transporte): mantém os cards, sem certeza do estado.
        if (!(e instanceof RpcError && e.code === 4001)) return
        pending = []
      }
      const alive = new Set(pending.map((p) => p.request_id).filter(Boolean))
      setApprovals((prev) => {
        const keep: PendingApproval[] = []
        for (const a of prev) {
          if (a.sessionId === sessionId && !(a.request.request_id && alive.has(a.request.request_id))) {
            const r = resolvers.current.get(a.key)
            resolvers.current.delete(a.key)
            r?.reject(new Error('aprovação retirada pelo backend'))
          } else keep.push(a)
        }
        return keep
      })
    },
    [rpc],
  )

  // server requests: `approval` vira card; o resto é recusado com erro explícito
  useEffect(() => {
    if (!rpc) return
    const pending = resolvers.current
    rpc.setRequestHandler((method, params) => {
      if (method !== 'approval') {
        return Promise.reject(new Error(`cockpit: server request "${method}" ainda não suportado`))
      }
      const req = (params ?? {}) as ApprovalRequest
      const sessionId = String(req.session_id ?? '')
      // re-entrega de open_requests a cada session.resume: o card original já responde
      // ao mesmo id do servidor — reaproveita a Promise dele em vez de vazar um resolver novo
      const rid = req.request_id
      if (rid) {
        const dup = liveByRequest.current.get(`${sessionId}::${rid}`)
        if (dup && pending.has(dup.key)) return dup.promise
      }
      const key = `live-${++approvalSeq.current}`
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(key, { resolve, reject })
        addApproval({ key, rpcId: key, sessionId, request: req })
      })
      if (rid) {
        const mapKey = `${sessionId}::${rid}`
        liveByRequest.current.set(mapKey, { key, promise })
        const forget = () => {
          if (liveByRequest.current.get(mapKey)?.key === key) liveByRequest.current.delete(mapKey)
        }
        promise.then(forget, forget)
      }
      return promise
    })
    return () => {
      rpc.setRequestHandler(null)
      for (const r of pending.values()) r.reject(new Error('painel de chat desmontado'))
      pending.clear()
      liveByRequest.current.clear()
      setApprovals([])
    }
  }, [rpc, addApproval])

  const respond = useCallback(
    async (a: PendingApproval, choice: ApprovalChoice) => {
      const live = resolvers.current.get(a.key)
      if (a.rpcId && live) {
        resolvers.current.delete(a.key)
        live.resolve({ choice })
        setApprovals((prev) => prev.filter((p) => p.key !== a.key))
        return
      }
      if (!rpc) throw new Error('sem conexão com o backend')
      await respondApproval(rpc, a.sessionId, choice, a.request.request_id)
      dropApproval(a.key)
    },
    [rpc, dropApproval],
  )

  // ── side-chats ─────────────────────────────────────────────────────────────
  const refreshSides = useCallback(() => {
    if (!rpc || !profile || !online) return
    listSessions(rpc, profile, 100)
      .then((rows) => {
        setSideChats(rows)
        setSideError(null)
      })
      .catch((e) => setSideError(errText(e)))
  }, [rpc, profile, online])

  useEffect(() => {
    setSideChats([])
    refreshSides()
  }, [refreshSides])

  // ── eventos do gateway (filtrados pela sessão ativa) ──────────────────────
  const sidesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!rpc) return
    const unsubscribe = rpc.subscribe((method, params) => {
      const ev = parseGatewayEvent(method, params)
      if (!ev) return
      if (ev.type === 'request.cancel') {
        if (ev.payload?.method === 'approval' && ev.session_id) void reconcileApprovals(ev.session_id)
        return
      }
      if (ev.type === 'sessions.changed') {
        if (sidesTimer.current) clearTimeout(sidesTimer.current)
        sidesTimer.current = setTimeout(() => {
          refreshSides()
          setDrawerNonce((n) => n + 1)
        }, 800)
        return
      }
      // indicador de streaming por aba (inclusive abas em 2º plano)
      if (ev.session_id && (ev.type === 'message.start' || ev.type === 'message.complete')) {
        const sid = ev.session_id
        let key: string | null = null
        for (const [k, rid] of runtimeByKey.current) if (rid === sid) key = k
        if (key) {
          const k = key
          setStreaming((prev) => {
            const on = ev.type === 'message.start'
            if (prev.has(k) === on) return prev
            const next = new Set(prev)
            if (on) next.add(k)
            else next.delete(k)
            return next
          })
        }
      }
      // auto-titler: atualiza o título da aba do side-chat (nunca do Bot Chat)
      if (ev.type === 'session.title' && ev.session_id) {
        const title = typeof ev.payload?.title === 'string' ? ev.payload.title.trim() : ''
        const sid = ev.session_id
        let key: string | null = null
        for (const [k, rid] of runtimeByKey.current) if (rid === sid) key = k
        if (title && key && key !== CANONICAL_KEY) {
          const k = key
          setSideTabs((prev) => prev.map((t) => (t.key === k ? { ...t, title, fresh: false } : t)))
        }
      }
      if (ev.session_id && ev.session_id === activeSid.current) dispatch({ type: 'event', event: ev })
    })
    return () => {
      unsubscribe()
      if (sidesTimer.current) clearTimeout(sidesTimer.current)
    }
  }, [rpc, reconcileApprovals, refreshSides])

  // ── abrir sessão (Bot Chat canônico ou side-chat) ─────────────────────────
  const targetKey = activeTab.key
  useEffect(() => {
    // troca de bot: espera o reset das abas para o novo profile
    if (tabsFor !== profile) return
    const token = ++loadToken.current
    setSession(null)
    dispatch({ type: 'reset' })
    setCommands([])
    if (!rpc || !profile || !online) {
      setLoad({ phase: 'idle' })
      return
    }
    setLoad({ phase: 'loading' })
    const stale = () => token !== loadToken.current

    ;(async () => {
      // modelo + "Bot Chat existe?" vêm do profiles.list; falha aqui = falha fechada
      let pm: ProfileModel | null = null
      try {
        pm = await getProfileModel(rpc, profile)
        if (!stale()) {
          setModel(pm)
          setModelError(null)
        }
      } catch (e) {
        if (!stale()) setModelError(errText(e))
      }

      let open: OpenSession
      let resumed: Awaited<ReturnType<typeof resumeSession>> | null = null
      const fresh = freshSide.current
      const useFresh = target.kind === 'side' && fresh !== null && fresh.storedId === target.storedId
      // atalho só na PRIMEIRA abertura: reabrir (ou reconectar) passa por session.resume,
      // que acha a sessão viva não-persistida e religa o transporte ao socket atual
      freshSide.current = null
      if (useFresh && fresh) {
        open = { profile, runtimeId: fresh.runtimeId, storedId: fresh.storedId }
      } else {
        let storedId: string
        if (target.kind === 'canonical') {
          if (!pm) throw new Error('não foi possível ler o profile — Bot Chat não resolvido (nada foi criado)')
          const row = await resolveBotChat(rpc, profile, { hadCanonical: pm.hasCanonical })
          storedId = row.resolved_id || row.id
        } else {
          storedId = target.storedId as string
        }
        if (stale()) return
        resumed = await resumeSession(rpc, storedId, profile)
        open = { profile, runtimeId: resumed.session_id, storedId: resumed.stored_session_id ?? storedId }
      }
      if (stale()) return

      setSession(open)
      activeSid.current = open.runtimeId
      runtimeByKey.current.set(targetKey, open.runtimeId)
      if (resumed) {
        dispatch({
          type: 'load',
          messages: resumed.messages ?? [],
          info: resumed.info ?? null,
          running: Boolean(resumed.running),
          inflight: resumed.inflight ?? null,
        })
        setStreaming((prev) => {
          const on = Boolean(resumed?.running)
          if (prev.has(targetKey) === on) return prev
          const next = new Set(prev)
          if (on) next.add(targetKey)
          else next.delete(targetKey)
          return next
        })
        // aprovações que já estavam pendentes (reconexão / turno em andamento)
        if (resumed.pending_approval?.request_id) {
          addApproval({
            key: `restored-${resumed.pending_approval.request_id}`,
            rpcId: null,
            sessionId: open.runtimeId,
            request: resumed.pending_approval,
          })
        }
        // `open_requests` não é tratado aqui: o HermesRpc re-entrega cada um ao
        // setRequestHandler antes de resolver o session.resume (vira card "vivo").
      } else if (useFresh && fresh) {
        dispatch({ type: 'load', messages: [], info: fresh.info, running: false, inflight: null })
      }
      setLoad({ phase: 'ready' })

      try {
        const cat = await commandsCatalog(rpc, { profile, sessionId: open.runtimeId })
        if (!stale()) setCommands(flattenCatalog(cat))
      } catch {
        /* autocomplete degradado: sem catálogo, slash ainda é enviado ao backend */
      }
    })().catch((e) => {
      if (!stale()) setLoad({ phase: 'error', message: errText(e) })
    })
    // target é coberto por targetKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, profile, online, targetKey, reloadNonce, addApproval, tabsFor])

  // ── ações ──────────────────────────────────────────────────────────────────
  const sid = session?.runtimeId ?? null
  const activeKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey

  const sendPrompt = useCallback(
    async (text: string, display?: string): Promise<boolean> => {
      if (!rpc || !sid) return false
      dispatch({ type: 'user', text: display ?? text })
      dispatch({ type: 'running', running: true })
      try {
        const res = await submitPrompt(rpc, sid, text)
        // 1º prompt materializa a linha do side-chat: a aba passa a ser persistida
        setSideTabs((prev) => (prev.some((t) => t.key === activeKeyRef.current && t.fresh) ? prev.map((t) => (t.key === activeKeyRef.current ? { ...t, fresh: false } : t)) : prev))
        if (res?.status === 'queued') dispatch({ type: 'note', tone: 'info', text: 'na fila — entra quando o turno atual terminar' })
        else if (res?.status === 'steered') dispatch({ type: 'note', tone: 'info', text: 'enviado como ajuste ao turno em andamento' })
        else if (res?.status === 'redirected') dispatch({ type: 'note', tone: 'info', text: 'turno redirecionado' })
        return true
      } catch (e) {
        dispatch({ type: 'running', running: false })
        dispatch({ type: 'note', tone: 'error', text: `falha ao enviar: ${errText(e)}` })
        return false
      }
    },
    [rpc, sid],
  )

  const handleDispatch = useCallback(
    async (cmd: string, d: SlashExecResult, depth: number): Promise<boolean> => {
      switch (d.type) {
        case 'send':
          if (d.notice) dispatch({ type: 'note', tone: 'info', text: d.notice })
          return d.message ? sendPrompt(d.message, d.display || d.message) : true
        case 'skill':
          return d.message ? sendPrompt(d.message, d.display || cmd) : true
        case 'prefill':
          if (d.notice) dispatch({ type: 'note', tone: 'info', text: d.notice })
          setPrefill({ text: d.message ?? '', nonce: Date.now() })
          return true
        case 'alias':
          if (d.target && depth < 3) return runSlashRef.current(`/${d.target.replace(/^\/+/, '')}`, depth + 1)
          return true
        default:
          dispatch({ type: 'slash', command: cmd, output: d.output ?? '', warning: d.warning ?? '' })
          return true
      }
    },
    [sendPrompt],
  )

  const runSlash = useCallback(
    async (text: string, depth = 0): Promise<boolean> => {
      if (!rpc || !sid) return false
      const [head, ...rest] = text.trim().split(/\s+/)
      const name = head.replace(/^\/+/, '')
      const arg = rest.join(' ')
      try {
        const res = await execSlash(rpc, sid, text.trim())
        if (res?.type) return handleDispatch(text.trim(), res, depth)
        dispatch({ type: 'slash', command: text.trim(), output: res?.output ?? '', warning: res?.warning ?? '' })
        return true
      } catch (execErr) {
        try {
          const d = await commandDispatch(rpc, sid, name, arg)
          return handleDispatch(text.trim(), d, depth)
        } catch {
          dispatch({ type: 'note', tone: 'error', text: `${head}: ${errText(execErr)}` })
          return false
        }
      }
    },
    [rpc, sid, handleDispatch],
  )
  const runSlashRef = useRef(runSlash)
  runSlashRef.current = runSlash

  const onSend = useCallback(
    (text: string) => (text.startsWith('/') ? runSlash(text) : sendPrompt(text)),
    [runSlash, sendPrompt],
  )

  const onCancel = useCallback(() => {
    if (!rpc || !sid) return
    interruptTurn(rpc, sid).catch((e) => dispatch({ type: 'note', tone: 'error', text: `cancelar falhou: ${errText(e)}` }))
  }, [rpc, sid])

  const onNewSide = useCallback(async () => {
    if (!rpc || !profile) return
    try {
      const created = await createSideChat(rpc, profile)
      freshSide.current = { storedId: created.stored_session_id, runtimeId: created.session_id, info: created.info }
      const key = sideKey(created.stored_session_id)
      runtimeByKey.current.set(key, created.session_id)
      setSideTabs((prev) => [...prev, { key, kind: 'side', storedId: created.stored_session_id, title: 'novo side-chat', fresh: true }])
      setActiveKey(key)
    } catch (e) {
      toast({ title: 'Não foi possível criar side-chat', detail: errText(e), tone: 'error' })
    }
  }, [rpc, profile])

  /** Abre (ou foca) um side-chat como aba. */
  const openSide = useCallback((row: { id: string; title: string }) => {
    const key = sideKey(row.id)
    setSideTabs((prev) => (prev.some((t) => t.key === key) ? prev : [...prev, { key, kind: 'side', storedId: row.id, title: row.title || 'side-chat' }]))
    setActiveKey(key)
  }, [])

  // Intents da paleta ⌘K (App dispara depois de trocar a view para chat).
  // Só agem se o profile do evento é o bot aberto aqui — nunca abrem sessão de outro bot.
  useEffect(() => {
    const detailOf = (e: Event) => ((e as CustomEvent<unknown>).detail ?? {}) as Record<string, unknown>
    const onNew = (e: Event) => {
      const d = detailOf(e)
      if (d.profile && d.profile !== profile) return
      void onNewSide()
    }
    const onOpen = (e: Event) => {
      const d = detailOf(e)
      if (d.profile !== profile || typeof d.id !== 'string' || !d.id) return
      openSide({ id: d.id, title: typeof d.title === 'string' ? d.title : 'side-chat' })
    }
    const onInsert = (e: Event) => {
      const d = detailOf(e)
      if (typeof d.text === 'string' && d.text) setPrefill({ text: d.text, nonce: Date.now() })
    }
    window.addEventListener('hc:chat-new-side', onNew)
    window.addEventListener('hc:chat-open-session', onOpen)
    window.addEventListener('hc:chat-insert', onInsert)
    return () => {
      window.removeEventListener('hc:chat-new-side', onNew)
      window.removeEventListener('hc:chat-open-session', onOpen)
      window.removeEventListener('hc:chat-insert', onInsert)
    }
  }, [profile, onNewSide, openSide])

  const closedStack = useRef<Array<{ id: string; title: string }>>([])
  const [closedCount, setClosedCount] = useState(0)
  const closeTab = useCallback(
    (key: string) => {
      if (key === CANONICAL_KEY) return
      setSideTabs((prev) => {
        const i = prev.findIndex((t) => t.key === key)
        if (i < 0) return prev
        const gone = prev[i]
        if (gone?.storedId) {
          closedStack.current = [...closedStack.current.filter((c) => c.id !== gone.storedId), { id: gone.storedId, title: gone.title }].slice(-20)
          setClosedCount(closedStack.current.length)
        }
        const next = prev.filter((t) => t.key !== key)
        if (activeKeyRef.current === key) setActiveKey(next[Math.min(i, next.length - 1)]?.key ?? CANONICAL_KEY)
        return next
      })
      // libera o runtime se não houver turno rodando (o registro fica intacto)
      const rid = runtimeByKey.current.get(key)
      runtimeByKey.current.delete(key)
      if (rid && rpc && !streaming.has(key)) void closeSession(rpc, rid, profile ?? undefined).catch(() => {})
      if (freshSide.current && sideKey(freshSide.current.storedId) === key) freshSide.current = null
    },
    [rpc, profile, streaming],
  )

  const closeMany = useCallback((keys: string[]) => keys.forEach((k) => closeTab(k)), [closeTab])
  const reopenTab = useCallback(() => {
    const last = closedStack.current.pop()
    setClosedCount(closedStack.current.length)
    if (last) openSide(last)
  }, [openSide])
  const popoutTab = useCallback(
    (key: string) => {
      if (!profile) return
      const tab = sideTabs.find((t) => t.key === key)
      openChatWindow(profile, tab?.storedId ? { id: tab.storedId, title: tab.title } : undefined)
      if (tab) closeTab(key)
    },
    [profile, sideTabs, closeTab],
  )

  // atalhos de abas (janela focada): ⌘T novo, ⌘⇧T reabrir, ⌘⇧W fechar, ⌃Tab / ⌃⇧Tab ciclar
  const tabsRef = useRef<ChatTab[]>([])
  tabsRef.current = tabs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (!online) {
        if (e.metaKey && !e.altKey && !e.shiftKey && k === 't') toast({ title: 'Sem conexão com o Hermes', detail: 'nova conversa assim que o ws reconectar', tone: 'warn' })
        return
      }
      if (e.metaKey && !e.altKey && k === 't') {
        e.preventDefault()
        if (e.shiftKey) reopenTab()
        else void onNewSide()
      } else if (e.metaKey && e.shiftKey && k === 'w') {
        e.preventDefault()
        closeTab(activeKeyRef.current)
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const list = tabsRef.current
        const i = list.findIndex((t) => t.key === activeKeyRef.current)
        const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length]
        if (next) setActiveKey(next.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [online, reopenTab, onNewSide, closeTab])

  const renameTab = useCallback(
    async (key: string, title: string) => {
      const tab = sideTabs.find((t) => t.key === key)
      if (!tab?.storedId || !profile) return
      const rid = runtimeByKey.current.get(key) ?? null
      try {
        let final: string
        try {
          final = await renameSession(rpc, api, { profile, storedId: tab.storedId, runtimeId: rid, title })
        } catch (e) {
          if (!rid) throw e
          final = await renameSession(null, api, { profile, storedId: tab.storedId, title })
        }
        setSideTabs((prev) => prev.map((t) => (t.key === key ? { ...t, title: final, fresh: false } : t)))
        setDrawerNonce((n) => n + 1)
      } catch (e) {
        toast({ title: 'Renomear falhou', detail: errText(e), tone: 'error' })
        throw e
      }
    },
    [rpc, profile, sideTabs],
  )

  const reorderTabs = useCallback((from: string, to: string) => {
    setSideTabs((prev) => {
      const a = prev.findIndex((t) => t.key === from)
      const b = prev.findIndex((t) => t.key === to)
      if (a < 0 || b < 0) return prev
      const next = prev.slice()
      const [moved] = next.splice(a, 1)
      next.splice(b, 0, moved)
      return next
    })
  }, [])

  // ── derivados de exibição ─────────────────────────────────────────────────
  const quick = useMemo(
    () =>
      commands
        .filter((c) => c.kind === 'skill' && c.usage > 0)
        .sort((a, b) => b.usage - a.usage)
        .slice(0, 3),
    [commands],
  )

  const liveModel = sessionModel && sessionModel.key === activeKey ? sessionModel : null
  const modelName = liveModel?.model ?? model?.model ?? bot?.modelo ?? null
  const fallbackName = model?.fallback[0]?.model ?? null
  const approvalMode = typeof chat.info?.approval_mode === 'string' ? chat.info.approval_mode : null
  const usage = chat.usage
  const ctxPct = typeof usage?.context_percent === 'number' ? usage.context_percent : null
  const totalTok = typeof usage?.total === 'number' ? usage.total : null

  const visibleApprovals = approvals

  // Modo de aprovação do Hermes (manual → auto/smart → yolo/off). config.set
  // grava approvals.mode do profile e o backend reemite session.info → chip atualiza.
  const applyApproval = useCallback(
    (mode: HermesApproval) => {
      if (!rpc || !sid) return
      setApprovalMode(rpc, sid, mode)
        .then(() => toast({ title: `Aprovação: ${HERMES_APPROVAL_LABEL[mode]}`, tone: mode === 'off' ? 'warn' : 'ok' }))
        .catch((e: unknown) => toast({ title: 'Falha ao trocar aprovação', detail: e instanceof Error ? e.message : String(e), tone: 'error' }))
    },
    [rpc, sid],
  )
  useEffect(() => {
    const on = (e: Event) => applyApproval((e as CustomEvent<HermesApproval>).detail)
    window.addEventListener('hc:approval-mode', on)
    return () => window.removeEventListener('hc:approval-mode', on)
  }, [applyApproval])
  const cycleApproval = () => {
    const order: HermesApproval[] = ['manual', 'smart', 'off']
    const cur = (approvalMode ?? 'manual') as HermesApproval
    applyApproval(order[(order.indexOf(cur) + 1) % order.length] ?? 'manual')
  }
  const autoOn = useAutoMode()
  const space = useSpace()
  const outOfSpace = Boolean(profile) && !inSpace(spaceOfBot(profile ?? ''), space)
  const spaceLabel = SPACES.find((x) => x.id === space)?.label ?? space
  // gaveta de sessões começa logo abaixo do header (+ aviso de espaço, se houver)
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerH, setHeaderH] = useState(45)
  useLayoutEffect(() => {
    const el = headerRef.current
    if (!el) return
    const measure = () => setHeaderH(el.offsetHeight + (el.nextElementSibling?.getAttribute('role') === 'status' ? (el.nextElementSibling as HTMLElement).offsetHeight : 0))
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [outOfSpace])

  const composerDisabled = !online || load.phase !== 'ready' || !sid
  const disabledReason = !rpc || connState !== 'open'
    ? 'backend desconectado'
    : !profile
      ? 'selecione um bot'
      : load.phase === 'loading'
        ? 'abrindo sessão…'
        : load.phase === 'error'
          ? 'sessão indisponível'
          : undefined

  const openIds = useMemo(() => new Set(sideTabs.map((t) => t.storedId).filter((x): x is string => Boolean(x))), [sideTabs])
  const monogram = title.trim().charAt(0).toUpperCase() || '·'

  return (
    <section className="relative flex h-full min-h-0 w-full flex-col bg-void scanlines">
      {/* header: identidade · grupo (modelo | aprovação | AUTO) · utilidades */}
      <div ref={headerRef} className="relative z-20 flex min-w-0 items-center gap-3 border-b border-edge px-4 py-1.5">
        <span
          className={`flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-lg border bg-panel text-[12px] font-semibold transition-colors ${
            chat.running ? 'border-amber/60 text-amber hc-glow-amber' : 'border-edge2 text-dim'
          }`}
        >
          {monogram}
        </span>
        <div className="flex min-w-0 shrink flex-col leading-tight">
          <span className="font-display min-w-0 truncate text-[15px] text-ink">{title}</span>
          <span className="min-w-0 truncate font-mono text-[9.5px] uppercase tracking-[0.16em] text-faint">
            {activeTab.kind === 'canonical' ? 'bot chat' : `side-chat · ${activeTab.title}`}
            {chat.running && <span className="text-amber"> · em turno</span>}
          </span>
        </div>
        <div className="relative flex min-w-0 shrink items-stretch rounded-md border border-edge bg-panel/50 text-[11px]">
          <button
            data-model-chip
            disabled={!profile || !online}
            onClick={() => setPickerOpen((v) => !v)}
            title={modelError ?? 'trocar modelo'}
            className={`flex min-w-0 max-w-[300px] items-center gap-1.5 rounded-l-md px-2 py-0.5 transition-colors disabled:opacity-50 ${
              pickerOpen ? 'bg-panel2 text-ink' : 'text-dim hover:bg-hover hover:text-ink'
            }`}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber/80" />
            <span className="truncate">{modelName ?? (modelError ? 'erro' : '—')}</span>
            {liveModel && <span className="shrink-0 text-[10px] text-cyanic">este chat</span>}
            {fallbackName && <span className="hidden truncate text-faint xl:inline">· fb {fallbackName}</span>}
            <span className="shrink-0 text-faint">▾</span>
          </button>
          <button
            type="button"
            onClick={cycleApproval}
            disabled={!sid}
            title="modo de aprovação do Hermes nesta sessão — clique para alternar: manual → auto (smart) → yolo (off)"
            className={`shrink-0 border-l border-edge px-2 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors disabled:opacity-40 ${
              approvalMode === 'off'
                ? 'text-alert hover:bg-alert/10'
                : approvalMode === 'smart'
                  ? 'text-phos hover:bg-phos/10'
                  : 'text-faint hover:bg-hover hover:text-dim'
            }`}
          >
            {approvalMode === 'off' ? '⚡ yolo' : approvalMode === 'smart' ? '◎ auto' : '◌ manual'}
          </button>
          <button
            type="button"
            onClick={() => void setAutoMode(!autoOn)}
            aria-pressed={autoOn}
            title={autoOn ? 'AUTO global ligado (Hermes smart + swarm auto) — clique para desligar' : 'ligar AUTO global: Hermes smart + swarm --permission-mode auto'}
            className={`flex shrink-0 items-center gap-1 rounded-r-md border-l border-edge px-2 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
              autoOn ? 'bg-phos/10 text-phos hc-glow-phos' : 'text-faint hover:bg-hover hover:text-dim'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${autoOn ? 'hc-pulse-dot bg-phos' : 'bg-edge2'}`} />
            auto
          </button>
          {pickerOpen && rpc && profile && (
              <ModelPicker
                rpc={rpc}
                profile={profile}
                botTitle={title}
                sessionId={sid}
                isBotChat={activeTab.kind === 'canonical'}
                currentModel={modelName}
                currentProvider={liveModel?.provider ?? model?.provider ?? null}
                fallback={model?.fallback ?? []}
                onClose={() => setPickerOpen(false)}
                onSwitched={(r) => {
                  dispatch({ type: 'note', tone: 'info', text: r.note })
                  if (r.scope === 'chat') setSessionModel({ key: activeKey, model: r.model, provider: r.provider })
                  else setSessionModel(null)
                  if (rpc && profile) getProfileModel(rpc, profile).then(setModel).catch(() => {})
                }}
              />
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setVerbose((v) => !v)}
            aria-pressed={verbose}
            title="verbose: abre ações e raciocínio automaticamente"
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
              verbose ? 'text-amber' : 'text-faint hover:text-dim'
            }`}
          >
            verbose
          </button>
          <button
            disabled={!profile || !online}
            onClick={() => {
              if (!drawerOpen) refreshSides()
              setDrawerOpen((v) => !v)
            }}
            title={sideError ?? 'sessões do bot'}
            className={`flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors disabled:opacity-50 ${
              drawerOpen ? 'border-amber/60 text-amber' : sideError ? 'border-alert/40 text-alert' : 'border-edge text-dim hover:border-amber/50 hover:text-ink'
            }`}
          >
            sessões
            {sideChats.length > 0 && <span className="tabular-nums text-faint">{sideChats.length}</span>}
          </button>
          <ConnBadge state={connState} />
        </div>
      </div>

      {outOfSpace && (
        <div className="hc-fade-in flex items-center gap-2 border-b border-edge bg-amber/[0.04] px-4 py-1 text-[11px] text-dim" role="status">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber/70" />
          <span className="min-w-0 truncate">
            <span className="text-ink/90">{title}</span> não pertence ao espaço <span className="label text-amber">{spaceLabel}</span> — a conversa segue
            aberta; troque de bot na rail.
          </span>
        </div>
      )}

      {profile && online && (
        <ChatTabs
          tabs={tabs}
          activeKey={activeKey}
          streaming={streaming}
          disabled={!online}
          onSelect={setActiveKey}
          onClose={closeTab}
          onRename={renameTab}
          onReorder={reorderTabs}
          onNew={() => void onNewSide()}
          onCloseMany={closeMany}
          onReopen={reopenTab}
          canReopen={closedCount > 0}
          onPopout={popoutTab}
        />
      )}

      {drawerOpen && rpc && profile && online && (
        <div className="absolute inset-x-0 bottom-0 z-30" style={{ top: headerH }}>
          <div className="absolute inset-0 bg-void/40" onClick={() => setDrawerOpen(false)} />
          <SessionDrawer
            rpc={rpc}
            profile={profile}
            botTitle={title}
            openIds={openIds}
            activeId={activeTab.kind === 'side' ? (activeTab.storedId ?? null) : null}
            runtimeOf={(id) => {
              const k = sideKey(id)
              const rid = runtimeByKey.current.get(k)
              return rid ? { runtimeId: rid, running: streaming.has(k) } : null
            }}
            refreshNonce={drawerNonce}
            onOpen={(row) => {
              openSide(row)
              setDrawerOpen(false)
            }}
            onRenamed={(id, t) => setSideTabs((prev) => prev.map((x) => (x.storedId === id ? { ...x, title: t } : x)))}
            onDeleted={() => refreshSides()}
            onClose={() => setDrawerOpen(false)}
          />
        </div>
      )}

      {/* corpo */}
      {!rpc || connState !== 'open' ? (
        <Centered>
          <div className="label mb-2 text-amber">backend {connState === 'connecting' ? 'conectando' : 'desconectado'}</div>
          <p className="max-w-sm text-dim">
            {connState === 'connecting'
              ? 'Abrindo o WebSocket do hermes serve…'
              : 'Sem conexão com o hermes serve. O chat volta sozinho quando a conexão reabrir.'}
          </p>
        </Centered>
      ) : !profile ? (
        <Centered>
          <p className="text-dim">Selecione um bot na rail para abrir o Bot Chat dele.</p>
        </Centered>
      ) : load.phase === 'error' ? (
        <Centered>
          <div className="max-w-md rounded-lg border border-alert/40 bg-panel p-4 text-left">
            <div className="label mb-1 text-alert">Falha ao abrir o chat</div>
            <pre className="whitespace-pre-wrap text-[12px] text-dim">{load.message}</pre>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setReloadNonce((n) => n + 1)}
                className="rounded border border-edge2 px-3 py-1 text-[12px] text-ink hover:border-amber/60"
              >
                tentar de novo
              </button>
              {activeTab.kind === 'side' && (
                <button
                  onClick={() => closeTab(activeTab.key)}
                  className="rounded border border-edge px-3 py-1 text-[12px] text-dim hover:border-alert/60 hover:text-alert"
                >
                  fechar aba
                </button>
              )}
            </div>
          </div>
        </Centered>
      ) : (
        <Transcript
          items={chat.items}
          verbose={verbose}
          running={chat.running}
          status={chat.status}
          botName={title}
          baseline={chat.baseline}
          empty={
            load.phase === 'loading' ? (
              <div className="py-10 text-center text-dim">
                abrindo {target.kind === 'canonical' ? 'Bot Chat' : `“${target.title}”`} de {title}…
              </div>
            ) : (
              <div className="py-10 text-center text-faint">
                {target.kind === 'canonical' ? 'Bot Chat vazio' : 'side-chat novo'} — mande a primeira mensagem.
              </div>
            )
          }
          footer={
            visibleApprovals.length > 0 ? (
              <div className="flex flex-col gap-2">
                {visibleApprovals.map((a) => (
                  <div key={a.key}>
                    {a.sessionId !== sid && (
                      <div className="label mb-1 text-amber">outra sessão · {a.sessionId || '?'}</div>
                    )}
                    <ApprovalCard approval={a} onRespond={respond} />
                  </div>
                ))}
              </div>
            ) : undefined
          }
        />
      )}

      <Composer
        title={title}
        disabled={composerDisabled}
        disabledReason={disabledReason}
        running={chat.running}
        commands={commands}
        quick={quick}
        prefill={prefill}
        rpc={rpc}
        sessionId={sid}
        onSend={onSend}
        onCancel={onCancel}
        footerLeft={
          [
            ctxPct !== null ? `contexto ${ctxPct}%` : null,
            totalTok !== null ? `${totalTok.toLocaleString('pt-BR')} tokens` : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
      />
    </section>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">{children}</div>
}

function ConnBadge({ state }: { state: ConnState }) {
  const map: Record<ConnState, { label: string; cls: string }> = {
    idle: { label: 'ocioso', cls: 'text-faint' },
    connecting: { label: 'conectando', cls: 'text-amber' },
    open: { label: 'ws aberto', cls: 'text-phos glow-phos' },
    closed: { label: 'fechado', cls: 'text-faint' },
    error: { label: 'erro', cls: 'text-alert' },
  }
  const { label, cls } = map[state]
  return (
    <span className={`flex items-center gap-2 text-[11px] ${cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
}
