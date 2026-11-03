import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HermesRpc } from '../../lib/rpc'
import {
  interruptTurn,
  parseGatewayEvent,
  resolveBotChat,
  respondApproval,
  resumeSession,
  submitPrompt,
  type ApprovalChoice,
  type ApprovalRequest,
} from '../../lib/gateway'
import { api, invoke } from '../../lib/ipc'
import { toast } from '../../lib/toast'
import { botTitle } from '../../lib/bots'
import { HOST_LABEL, HOST_THIS } from '../../lib/platform'
import {
  DEFAULT_VAD,
  EnergyVad,
  LiveSession,
  MIC_SETTINGS_URL,
  MicInput,
  SCREEN_SETTINGS_URL,
  SpeechOut,
  TurnRecorder,
  delegationPrompt,
  errText,
  isComputerTool,
  isStopPhrase,
  levelOf,
  micErrorMessage,
  parseComputerArgs,
  probeVoice,
  stripForSpeech,
  toLiveHistory,
  transcribe,
  type VoiceProbe,
} from '../../lib/voice'
import { Badge, Button, Kbd, cx } from '../ui'
import { VoiceOrb, type OrbPhase } from './VoiceOrb'
import { MacLivePanel, type AgentAction } from './MacLivePanel'

// Voice mode do cockpit (overlay em tela cheia). CONTRATO: export e props fixos;
// o shell monta global e controla `open` (evento hc:voice / ⌘⇧V).
//
// Motor: GPT-Live (WebRTC, delegação ao Hermes) quando o profile do bot selecionou
// voice_chat_mode=gpt-live e há chave; senão turno a turno (gravar → transcrever →
// prompt.submit no Bot Chat → fala por speak-stream/speak). Ver lib/voice.ts.
// Computer use: tool.* do RPC na sessão + screenshot do host enquanto o tool roda.

type Engine = 'live' | 'turnos'
type ListenMode = 'continuo' | 'ptt'

const LISTEN_KEY = 'hermes-cockpit.voice.listen'
const SPEAK_KEY = 'hermes-cockpit.voice.speak'
const SHOT_MS = 1500
const MIN_UTTERANCE_MS = 450
const BARGE_LEVEL = 0.16
const BARGE_MS = 220

const PHASE_LABEL: Record<OrbPhase, string> = {
  preparando: 'preparando',
  ouvindo: 'ouvindo',
  pronto: 'segure espaço para falar',
  gravando: 'gravando',
  transcrevendo: 'transcrevendo',
  pensando: 'pensando',
  falando: 'falando',
  agindo: `agindo no ${HOST_LABEL}`,
  erro: 'erro',
}

function readPref<T extends string>(key: string, allowed: readonly T[], dflt: T): T {
  try {
    const v = localStorage.getItem(key)
    return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : dflt
  } catch {
    return dflt
  }
}
function writePref(key: string, v: string): void {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* sem storage: só não persiste */
  }
}

interface Fatal {
  kind: 'mic' | 'sessao' | 'rpc' | 'bot'
  message: string
}

export function VoiceOverlay(props: { rpc: HermesRpc | null; bot: string | null; open: boolean; onClose: () => void }) {
  const { rpc, bot, open, onClose } = props

  // ── estado de UI ──
  const [engine, setEngine] = useState<Engine | null>(null)
  const [engineNote, setEngineNote] = useState<string | null>(null)
  const [probe, setProbe] = useState<VoiceProbe | null>(null)
  const [listen, setListenState] = useState<ListenMode>(() => readPref(LISTEN_KEY, ['continuo', 'ptt'] as const, 'continuo'))
  const [speakReplies, setSpeakReplies] = useState<boolean>(() => readPref(SPEAK_KEY, ['on', 'off'] as const, 'on') === 'on')
  const [ready, setReady] = useState(false)
  const [fatal, setFatal] = useState<Fatal | null>(null)
  const [softError, setSoftError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [computerRunning, setComputerRunning] = useState(0)
  const [userCaption, setUserCaption] = useState('')
  const [botCaption, setBotCaption] = useState('')
  const [statusLine, setStatusLine] = useState<string | null>(null)
  const [actions, setActions] = useState<AgentAction[]>([])
  const [shot, setShot] = useState<string | null>(null)
  const [shotAt, setShotAt] = useState<number | null>(null)
  const [shotError, setShotError] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [speechNote, setSpeechNote] = useState<string | null>(null)
  const [sttProvider, setSttProvider] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [pttHeld, setPttHeld] = useState(false)

  // ── refs do motor ──
  const sidRef = useRef<string | null>(null)
  const botRef = useRef<string | null>(bot)
  botRef.current = bot
  const rpcRef = useRef<HermesRpc | null>(rpc)
  rpcRef.current = rpc
  const micRef = useRef<MicInput | null>(null)
  const speechRef = useRef<SpeechOut | null>(null)
  const recRef = useRef<TurnRecorder | null>(null)
  const vadRef = useRef<EnergyVad>(new EnergyVad(DEFAULT_VAD))
  const liveRef = useRef<LiveSession | null>(null)
  const engineRef = useRef<Engine | null>(null)
  const listenRef = useRef<ListenMode>(listen)
  listenRef.current = listen
  const speakRef = useRef(speakReplies)
  speakRef.current = speakReplies
  const busyRef = useRef(false)
  const handleRef = useRef<ReturnType<SpeechOut['begin']> | null>(null)
  const replyRef = useRef('')
  const deltaSeenRef = useRef(false)
  const delegationRef = useRef<string | null>(null)
  const liveSpokenRef = useRef(0)
  const liveUserRef = useRef('')
  const lastToolThinkRef = useRef<string | null>(null)
  const processingRef = useRef(false)
  const epochRef = useRef(0)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const setListen = useCallback((m: ListenMode) => {
    setListenState(m)
    writePref(LISTEN_KEY, m)
    const live = liveRef.current
    if (live) live.setMuted(m === 'ptt')
  }, [])

  // ── derivação da fase ──
  const phase: OrbPhase = useMemo(() => {
    if (fatal) return 'erro'
    if (!ready) return 'preparando'
    if (recording || (engine === 'live' && pttHeld)) return 'gravando'
    if (transcribing) return 'transcrevendo'
    if (speaking) return 'falando'
    if (computerRunning > 0) return 'agindo'
    if (busy) return 'pensando'
    return listen === 'ptt' ? 'pronto' : 'ouvindo'
  }, [fatal, ready, recording, transcribing, speaking, computerRunning, busy, listen, engine, pttHeld])

  const micLevel = useCallback(() => micRef.current?.level() ?? 0, [])
  const botLevel = useCallback(() => {
    const live = liveRef.current
    if (live?.outAnalyser) return levelOf(live.outAnalyser)
    return speechRef.current?.level() ?? 0
  }, [])

  // ── envio de turno (turno a turno) ──
  const submitTurn = useCallback(async (text: string) => {
    const r = rpcRef.current
    const sid = sidRef.current
    if (!r || !sid) return
    setUserCaption(text)
    setBotCaption('')
    speechRef.current?.stop()
    try {
      if (busyRef.current) await interruptTurn(r, sid).catch(() => undefined)
      await submitPrompt(r, sid, text)
    } catch (e) {
      setSoftError(`falha ao enviar ao bot: ${errText(e)}`)
    }
  }, [])

  const processRecording = useCallback(async () => {
    const rec = recRef.current
    const profile = botRef.current
    if (!rec || !profile) return
    const got = await rec.stop()
    setRecording(false)
    vadRef.current.reset()
    if (!got || got.ms < MIN_UTTERANCE_MS) return
    processingRef.current = true
    setTranscribing(true)
    setSoftError(null)
    const epoch = epochRef.current
    try {
      const res = await transcribe(profile, got.blob)
      if (epoch !== epochRef.current) return
      if (res.provider) setSttProvider(res.provider)
      if (!res.text) return // silêncio: volta a ouvir
      if (isStopPhrase(res.text)) {
        onCloseRef.current()
        return
      }
      await submitTurn(res.text)
    } catch (e) {
      if (epoch !== epochRef.current) return
      const msg = errText(e)
      setSoftError(/stt|provider|transcri/i.test(msg) ? `sem provedor de transcrição utilizável: ${msg}` : `transcrição falhou: ${msg}`)
    } finally {
      processingRef.current = false
      setTranscribing(false)
    }
  }, [submitTurn])

  const startRecording = useCallback(() => {
    const mic = micRef.current
    const rec = recRef.current
    if (!mic?.stream || !rec || rec.recording || processingRef.current) return
    speechRef.current?.stop()
    try {
      rec.start(mic.stream)
      setRecording(true)
    } catch (e) {
      setSoftError(`gravação falhou: ${errText(e)}`)
    }
  }, [])

  // ── eventos do RPC na sessão do bot ──
  const onGatewayEvent = useCallback((method: string, params: unknown) => {
    const ev = parseGatewayEvent(method, params)
    if (!ev || !ev.session_id || ev.session_id !== sidRef.current) return
    const p = ev.payload ?? {}
    const profile = botRef.current
    switch (ev.type) {
      case 'message.start': {
        busyRef.current = true
        setBusy(true)
        replyRef.current = ''
        deltaSeenRef.current = false
        liveSpokenRef.current = 0
        setBotCaption('')
        if (engineRef.current === 'turnos' && speakRef.current && profile && speechRef.current) {
          handleRef.current = speechRef.current.begin(profile)
          const h = handleRef.current
          void h.done.then(() => {
            const sp = speechRef.current
            if (sp) setSpeechNote(sp.route === 'sistema' ? sp.routeNote ?? 'usando a voz do sistema' : sp.routeNote)
          })
        }
        return
      }
      case 'message.delta': {
        const t = typeof p.text === 'string' ? p.text : ''
        if (!t) return
        deltaSeenRef.current = true
        replyRef.current += t
        setBotCaption(replyRef.current)
        if (engineRef.current === 'turnos') handleRef.current?.append(t)
        else feedLive(false)
        return
      }
      case 'message.complete': {
        const final = typeof p.text === 'string' && p.text ? p.text : replyRef.current
        if (!deltaSeenRef.current && final) {
          replyRef.current = final
          if (engineRef.current === 'turnos') handleRef.current?.append(final)
        }
        setBotCaption(final)
        busyRef.current = false
        setBusy(false)
        setComputerRunning(0)
        if (p.status === 'interrupted') setStatusLine('turno interrompido')
        if (engineRef.current === 'turnos') {
          handleRef.current?.finish()
          handleRef.current = null
        } else feedLive(true)
        return
      }
      case 'tool.generating': {
        if (typeof p.name === 'string') setStatusLine(`preparando ${p.name}…`)
        return
      }
      case 'tool.start': {
        const name = String(p.name ?? 'tool')
        const id = String(p.tool_id ?? `${name}-${Date.now()}`)
        const computer = isComputerTool(name) ? parseComputerArgs(p.args ?? p.args_text) : null
        const label = String(p.context ?? p.preview ?? name).slice(0, 140) || name
        setActions((xs) => [...xs.slice(-79), { id, name, label, computer, status: 'rodando', startedAt: Date.now() }])
        if (isComputerTool(name)) setComputerRunning((n) => n + 1)
        setStatusLine(null)
        const live = liveRef.current
        if (live && delegationRef.current && lastToolThinkRef.current !== name) {
          lastToolThinkRef.current = name
          live.think(delegationRef.current, `Hermes is working: ${name}. Not done yet.`)
        }
        return
      }
      case 'tool.complete': {
        const id = String(p.tool_id ?? '')
        const name = String(p.name ?? '')
        const failed = Boolean(p.error) || p.status === 'error'
        setActions((xs) =>
          xs.map((a) =>
            a.id === id || (!id && a.name === name && a.status === 'rodando')
              ? {
                  ...a,
                  status: failed ? 'erro' : 'ok',
                  durationS: typeof p.duration_s === 'number' ? p.duration_s : undefined,
                  summary: typeof p.summary === 'string' ? p.summary.slice(0, 200) : a.summary,
                }
              : a,
          ),
        )
        if (isComputerTool(name)) {
          setComputerRunning((n) => Math.max(0, n - 1))
          void grabShot()
        }
        return
      }
      case 'status.update': {
        if (typeof p.text === 'string' && p.text) setStatusLine(p.text.slice(0, 160))
        return
      }
      case 'error': {
        if (typeof p.message === 'string') setSoftError(p.message.slice(0, 240))
        return
      }
      default:
        return
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** GPT-Live: devolve o texto do Hermes à voz em frases completas; no fim, o resto. */
  const feedLive = (final: boolean) => {
    const live = liveRef.current
    const did = delegationRef.current
    if (!live || !did) return
    const spoken = stripForSpeech(replyRef.current)
    if (!final) {
      const boundary = spoken.lastIndexOf('. ', spoken.length - 2)
      if (boundary + 1 > liveSpokenRef.current) {
        live.speak(did, spoken.slice(liveSpokenRef.current, boundary + 1))
        liveSpokenRef.current = boundary + 1
      }
      return
    }
    if (spoken.length > liveSpokenRef.current) live.speak(did, spoken.slice(liveSpokenRef.current))
    else if (liveSpokenRef.current === 0) live.think(did, 'Hermes finished that request without a spoken result.')
    liveSpokenRef.current = spoken.length
    delegationRef.current = null
    lastToolThinkRef.current = null
  }

  // ── screenshot ──
  const shotBusy = useRef(false)
  const grabShot = useCallback(async () => {
    if (shotBusy.current) return
    shotBusy.current = true
    try {
      const r = await invoke<{ dataUrl: string }>('ops:screenshot')
      setShot(r.dataUrl)
      setShotAt(Date.now())
      setShotError(null)
    } catch (e) {
      setShotError(errText(e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''))
    } finally {
      shotBusy.current = false
    }
  }, [])

  const polling = open && ready && !fatal && (pinned || computerRunning > 0)
  useEffect(() => {
    if (!polling) return
    void grabShot()
    const t = window.setInterval(() => void grabShot(), SHOT_MS)
    return () => window.clearInterval(t)
  }, [polling, grabShot])

  // ── aprovações pendentes (o card do chat pode estar atrás do overlay) ──
  useEffect(() => {
    if (!open || !busy || !rpc) {
      setApprovals([])
      return
    }
    let alive = true
    const tick = async () => {
      const sid = sidRef.current
      if (!sid) return
      try {
        const r = await rpc.call<{ approvals?: ApprovalRequest[] }>('approval.pending', { session_id: sid })
        if (alive) setApprovals(r?.approvals ?? [])
      } catch {
        /* gateway sem approval.pending: o card do chat continua valendo */
      }
    }
    void tick()
    const t = window.setInterval(() => void tick(), 1500)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [open, busy, rpc])

  const answerApproval = useCallback(
    async (a: ApprovalRequest, choice: ApprovalChoice) => {
      const r = rpcRef.current
      const sid = sidRef.current
      if (!r || !sid) return
      try {
        await respondApproval(r, sid, choice, a.request_id)
        setApprovals((xs) => xs.filter((x) => x.request_id !== a.request_id))
      } catch (e) {
        toast({ title: 'aprovação falhou', detail: errText(e), tone: 'error' })
      }
    },
    [],
  )

  // ── ciclo de vida da sessão de voz ──
  useEffect(() => {
    if (!open) return
    const epoch = ++epochRef.current
    const alive = () => epoch === epochRef.current
    setFatal(null)
    setSoftError(null)
    setReady(false)
    setEngine(null)
    engineRef.current = null
    setEngineNote(null)
    setUserCaption('')
    setBotCaption('')
    setStatusLine(null)
    setSpeechNote(null)
    setComputerRunning(0)
    busyRef.current = false
    setBusy(false)
    sidRef.current = null

    if (!bot) {
      setFatal({ kind: 'bot', message: 'selecione um bot na rail para conversar por voz' })
      return
    }
    if (!rpc || !rpc.isOpen()) {
      setFatal({ kind: 'rpc', message: 'sem conexão com o Hermes (ws fechado) — o voice mode precisa do gateway' })
      return
    }

    const mic = new MicInput()
    const speech = new SpeechOut()
    speech.onSpeaking = (on) => alive() && setSpeaking(on)
    micRef.current = mic
    speechRef.current = speech
    recRef.current = new TurnRecorder()
    vadRef.current = new EnergyVad(DEFAULT_VAD)
    const unsub = rpc.subscribe(onGatewayEvent)

    void (async () => {
      // 1) sessão canônica do bot (Bot Chat) — a mesma do ChatPane
      let history: Array<{ role: 'assistant' | 'user'; text: string }> = []
      try {
        const row = await resolveBotChat(rpc, bot)
        const resumed = await resumeSession(rpc, row.id, bot)
        if (!alive()) return
        sidRef.current = resumed.session_id
        const running = Boolean(resumed.running ?? resumed.info?.running)
        busyRef.current = running
        setBusy(running)
        history = (resumed.messages ?? [])
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text)
          .map((m) => ({ role: m.role as 'assistant' | 'user', text: String(m.text) }))
        if (resumed.pending_approval) setApprovals([resumed.pending_approval])
      } catch (e) {
        if (alive()) setFatal({ kind: 'sessao', message: `não foi possível abrir o Bot Chat de ${bot}: ${errText(e)}` })
        return
      }

      // 2) diagnóstico de voz do profile (não bloqueia o turno a turno)
      const pr = await probeVoice(bot).catch(() => null)
      if (!alive()) return
      setProbe(pr)

      // 3) microfone
      try {
        await mic.start()
      } catch (e) {
        if (alive()) setFatal({ kind: 'mic', message: micErrorMessage(e) })
        return
      }
      if (!alive()) {
        mic.stop()
        return
      }

      // 4) motor
      const wantsLive = pr?.live?.mode === 'gpt-live'
      if (wantsLive && pr?.live?.available) {
        const live = new LiveSession(bot, {
          onDelegation: (did, ctx) => {
            if (!alive() || liveRef.current !== live) return
            const { prompt, context } = delegationPrompt(ctx)
            if (prompt && isStopPhrase(prompt)) {
              onCloseRef.current()
              return
            }
            const r = rpcRef.current
            const sid = sidRef.current
            if (!r || !sid) return
            delegationRef.current = did
            liveSpokenRef.current = 0
            lastToolThinkRef.current = null
            setUserCaption(prompt)
            void (async () => {
              try {
                if (busyRef.current) await interruptTurn(r, sid).catch(() => undefined)
                await r.call('prompt.submit', { session_id: sid, text: prompt, surface: 'voice-live', voice_context: context })
              } catch (e) {
                setSoftError(`delegação ao Hermes falhou: ${errText(e)}`)
                live.speak(did, 'Desculpe, não consegui falar com o Hermes para esse pedido.')
                delegationRef.current = null
              }
            })()
          },
          onTranscript: (f) => {
            if (!alive()) return
            if (f.speaker === 'user') {
              liveUserRef.current += f.text
              setUserCaption(liveUserRef.current)
            } else {
              liveUserRef.current = ''
              setBotCaption((s) => (s.length > 600 ? s.slice(-400) : s) + f.text)
            }
          },
          onSpeakingChange: (on) => {
            if (!alive()) return
            if (on) setBotCaption((s) => (busyRef.current ? s : ''))
            setSpeaking(on)
          },
          onError: (m) => alive() && setSoftError(`GPT-Live: ${m}`),
          onClosed: (reason, usage) => {
            if (!alive() || liveRef.current !== live) return
            liveRef.current = null
            if (reason !== 'close_requested') {
              setFatal({
                kind: 'sessao',
                message: `sessão GPT-Live encerrada (${reason === 'connection_lost' ? 'conexão perdida' : reason}${usage != null ? ` · ${Math.round(usage)}s` : ''})`,
              })
            }
          },
        })
        liveRef.current = live
        try {
          await live.start(mic.stream!, toLiveHistory(history))
          if (!alive()) {
            live.close()
            return
          }
          engineRef.current = 'live'
          setEngine('live')
          if (listenRef.current === 'ptt') live.setMuted(true)
          setReady(true)
          return
        } catch (e) {
          liveRef.current = null
          live.close()
          if (!alive()) return
          setEngineNote(`GPT-Live não iniciou (${errText(e)}) — usando turno a turno`)
          toast({ title: 'GPT-Live indisponível', detail: errText(e), tone: 'warn' })
        }
      } else if (wantsLive) {
        setEngineNote(`GPT-Live selecionado, mas indisponível: ${pr?.live?.reason ?? 'sem chave'} — usando turno a turno`)
      } else if (!pr?.live) {
        setEngineNote(pr?.liveError ? `status do voice-live falhou (${pr.liveError}) — turno a turno` : null)
      }
      engineRef.current = 'turnos'
      setEngine('turnos')
      setReady(true)
      // aquece o TTS (lease do desktop: pré-carrega o provedor); falha não importa
      void (async () => {
        try {
          await api(`/api/audio/tts-lease?profile=${encodeURIComponent(bot)}`, { method: 'POST', body: { lease: 'cockpit:voice', active: true } })
        } catch {
          /* sem lease: a primeira fala só demora mais */
        }
      })()
    })()

    return () => {
      epochRef.current++
      unsub()
      liveRef.current?.close()
      liveRef.current = null
      recRef.current?.cancel()
      recRef.current = null
      handleRef.current = null
      speech.close()
      mic.stop()
      micRef.current = null
      speechRef.current = null
      delegationRef.current = null
      setRecording(false)
      setTranscribing(false)
      setSpeaking(false)
      setPttHeld(false)
      processingRef.current = false
      if (engineRef.current === 'turnos' && bot) {
        void api(`/api/audio/tts-lease?profile=${encodeURIComponent(bot)}`, {
          method: 'POST',
          body: { lease: 'cockpit:voice', active: false },
        }).catch(() => undefined)
      }
      engineRef.current = null
    }
  }, [open, bot, rpc, onGatewayEvent, retryKey])

  // ── VAD contínuo + barge-in (turno a turno) ──
  useEffect(() => {
    if (!open || !ready || engine !== 'turnos' || fatal) return
    let loudSince = 0
    const t = window.setInterval(() => {
      const mic = micRef.current
      if (!mic) return
      const lvl = mic.level()
      const now = performance.now()
      const sp = speechRef.current
      // barge-in: fala do usuário por cima da do bot
      if (sp?.isSpeaking) {
        if (lvl > BARGE_LEVEL) {
          if (!loudSince) loudSince = now
          if (now - loudSince > BARGE_MS) {
            sp.stop()
            handleRef.current = null
            loudSince = 0
            if (listenRef.current === 'continuo') {
              vadRef.current.reset()
              startRecording()
            }
          }
        } else loudSince = 0
        return
      }
      if (listenRef.current !== 'continuo' || processingRef.current) return
      const edge = vadRef.current.feed(lvl, now)
      if (edge === 'start') startRecording()
      else if (edge === 'end' && recRef.current?.recording) void processRecording()
    }, 40)
    return () => window.clearInterval(t)
  }, [open, ready, engine, fatal, startRecording, processRecording])

  // ── teclado: Esc fecha; espaço = push-to-talk ──
  useEffect(() => {
    if (!open) return
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.code !== 'Space' || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      pttDown()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e)) return
      e.preventDefault()
      e.stopPropagation()
      pttUp()
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pttDown = () => {
    if (!engineRef.current) return
    setPttHeld(true)
    if (engineRef.current === 'live') {
      liveRef.current?.setMuted(false)
      return
    }
    speechRef.current?.stop()
    handleRef.current = null
    vadRef.current.reset()
    startRecording()
  }
  const pttUp = () => {
    setPttHeld(false)
    if (engineRef.current === 'live') {
      const live = liveRef.current
      if (live && listenRef.current === 'ptt') {
        live.setMuted(true)
        live.instruct('The user has finished speaking. Respond now to what they said.')
      }
      return
    }
    if (recRef.current?.recording) void processRecording()
  }

  const stopAgent = useCallback(async () => {
    const r = rpcRef.current
    const sid = sidRef.current
    speechRef.current?.stop()
    handleRef.current = null
    if (!r || !sid) return
    try {
      await interruptTurn(r, sid)
      setStatusLine('interrompendo o agente…')
    } catch (e) {
      toast({ title: 'não foi possível parar o agente', detail: errText(e), tone: 'error' })
    }
  }, [])

  const openSettings = (url: string) => {
    void invoke('ops:open', { kind: 'url', url }).catch((e: unknown) =>
      toast({ title: 'não abriu os Ajustes', detail: errText(e), tone: 'error' }),
    )
  }

  if (!open) return null

  const showMac = pinned || actions.some((a) => a.computer) || computerRunning > 0 || Boolean(shot)
  const modeChip =
    engine === 'live'
      ? { text: `GPT-LIVE · ${probe?.live?.model ?? 'webrtc'}`, tone: 'phos' as const, hint: 'full-duplex WebRTC; o Hermes responde por delegação' }
      : engine === 'turnos'
        ? { text: 'TURNO A TURNO', tone: 'amber' as const, hint: 'gravar → /api/audio/transcribe → bot → speak-stream/speak' }
        : null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice mode"
      className="vo-root hc-fade-in fixed inset-0 z-[80] flex flex-col bg-void/95 text-ink backdrop-blur-md"
    >
      <style>{VOICE_CSS}</style>
      <div className="vo-aurora pointer-events-none absolute inset-0" data-phase={phase} />

      {/* topo */}
      <div className="drag relative flex h-12 shrink-0 items-center gap-3 border-b border-edge/70 pr-3 pl-20">
        <span className="text-[11px] font-semibold tracking-[0.22em] text-amber uppercase">Voz</span>
        {bot && <span className="text-[11px] tracking-wider text-dim uppercase">{botTitle(bot)}</span>}
        {modeChip && (
          <span title={modeChip.hint}>
            <Badge tone={modeChip.tone}>{modeChip.text}</Badge>
          </span>
        )}
        {engine === 'turnos' && probe?.stt && (
          <span className="hidden text-[10px] text-faint md:inline" title="voice-config do profile">
            stt {probe.stt.mode}
            {sttProvider ? ` · ${sttProvider}` : ''} · tts {probe.tts?.mode ?? '?'}
          </span>
        )}
        <div className="no-drag ml-auto flex items-center gap-2">
          {engine && (
            <div className="flex overflow-hidden rounded-md border border-edge2 text-[10px] tracking-wider uppercase" role="radiogroup" aria-label="modo de escuta">
              {(['continuo', 'ptt'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={listen === m}
                  onClick={() => setListen(m)}
                  className={cx('px-2.5 py-1', listen === m ? 'bg-amber/15 text-amber' : 'text-dim hover:text-ink')}
                >
                  {m === 'continuo' ? 'contínuo' : 'push-to-talk'}
                </button>
              ))}
            </div>
          )}
          {engine === 'turnos' && (
            <Button
              size="xs"
              variant={speakReplies ? 'outline' : 'ghost'}
              onClick={() => {
                const v = !speakReplies
                setSpeakReplies(v)
                writePref(SPEAK_KEY, v ? 'on' : 'off')
                if (!v) speechRef.current?.stop()
              }}
              title="falar as respostas do bot"
            >
              {speakReplies ? 'fala: on' : 'fala: off'}
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => setPinned((v) => !v)} title={`mostrar a tela ${HOST_THIS}`}>
            {pinned ? 'tela fixada' : 'ver tela'}
          </Button>
          <Button size="xs" variant="ghost" onClick={onClose} title="fechar (Esc)">
            fechar <Kbd keys="esc" />
          </Button>
        </div>
      </div>

      {/* corpo */}
      <div className={cx('relative flex min-h-0 flex-1', showMac ? 'flex-col lg:flex-row' : 'flex-col')}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 py-6">
          {fatal ? (
            <FatalPanel
              fatal={fatal}
              onRetry={() => setRetryKey((k) => k + 1)}
              onSettings={() => openSettings(MIC_SETTINGS_URL)}
            />
          ) : (
            <>
              <button
                type="button"
                className="no-drag relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber/60"
                aria-label={listen === 'ptt' ? 'segure para falar' : 'estado da voz'}
                onPointerDown={(e) => {
                  e.preventDefault()
                  pttDown()
                }}
                onPointerUp={pttUp}
                onPointerLeave={() => pttHeld && pttUp()}
              >
                <VoiceOrb phase={phase} micLevel={micLevel} botLevel={botLevel} size={320} />
              </button>
              <div className="flex flex-col items-center gap-1">
                <span
                  className={cx(
                    'text-[12px] font-semibold tracking-[0.3em] uppercase',
                    phase === 'falando' || phase === 'gravando' ? 'text-amber' : phase === 'agindo' || phase === 'pensando' ? 'text-cyanic' : 'text-phos',
                  )}
                  aria-live="polite"
                >
                  {PHASE_LABEL[phase]}
                </span>
                {statusLine && <span className="text-[11px] text-dim">{statusLine}</span>}
                <span className="text-[10px] text-faint">
                  {listen === 'ptt' ? (
                    <>
                      segure <Kbd keys="espaço" /> ou o orb para falar
                    </>
                  ) : engine === 'live' ? (
                    'fale à vontade — interrompa quando quiser'
                  ) : (
                    <>
                      fala detectada por energia · <Kbd keys="espaço" /> força gravação · fale por cima para interromper
                    </>
                  )}
                </span>
              </div>

              <Captions user={userCaption} bot={botCaption} speaking={speaking} />

              {approvals.length > 0 && (
                <div className="w-full max-w-xl space-y-2">
                  {approvals.map((a, i) => (
                    <div key={a.request_id ?? i} className="hc-rise rounded-md border border-amber/50 bg-amber/5 p-3 text-[11px]">
                      <div className="mb-1 text-[10px] font-semibold tracking-[0.18em] text-amber uppercase">aprovação pedida{a.tool_name ? ` · ${a.tool_name}` : ''}</div>
                      <div className="mb-2 break-words text-ink">{a.description || a.command || 'ação que exige aprovação'}</div>
                      {a.command && a.description && <pre className="mb-2 max-h-24 overflow-auto rounded bg-void/70 p-2 text-[10px] text-dim">{a.command}</pre>}
                      <div className="flex flex-wrap gap-2">
                        <Button size="xs" variant="primary" onClick={() => void answerApproval(a, 'once')}>aprovar uma vez</Button>
                        {a.allow_session !== false && (
                          <Button size="xs" variant="outline" onClick={() => void answerApproval(a, 'session')}>nesta sessão</Button>
                        )}
                        <Button size="xs" variant="danger" onClick={() => void answerApproval(a, 'deny')}>negar</Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-center gap-2">
                {(busy || computerRunning > 0) && (
                  <Button size="sm" variant="danger" onClick={() => void stopAgent()}>
                    parar agente
                  </Button>
                )}
                {speaking && engine === 'turnos' && (
                  <Button size="sm" variant="ghost" onClick={() => speechRef.current?.stop()}>
                    calar
                  </Button>
                )}
              </div>

              <div className="flex max-w-xl flex-col items-center gap-1 text-center">
                {engineNote && <span className="text-[10px] text-amber/80">{engineNote}</span>}
                {speechNote && <span className="text-[10px] text-amber/80">{speechNote}</span>}
                {softError && (
                  <span className="text-[11px] text-alert">
                    {softError}{' '}
                    <button type="button" className="no-drag underline decoration-dotted" onClick={() => setSoftError(null)}>
                      ok
                    </button>
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {showMac && !fatal && (
          <aside className="hc-slide-left flex min-h-0 w-full shrink-0 flex-col border-t border-edge/70 bg-panel/70 p-4 lg:w-[min(46vw,640px)] lg:border-t-0 lg:border-l">
            <MacLivePanel
              shot={shot}
              shotAt={shotAt}
              shotError={shotError}
              polling={polling}
              pinned={pinned}
              onPin={setPinned}
              onOpenSettings={() => openSettings(SCREEN_SETTINGS_URL)}
              actions={actions}
            />
          </aside>
        )}
      </div>
    </div>
  )
}

function Captions({ user, bot, speaking }: { user: string; bot: string; speaking: boolean }) {
  const botTail = bot.length > 420 ? `…${bot.slice(-420)}` : bot
  if (!user && !bot) return <div className="h-16" />
  return (
    <div className="flex w-full max-w-2xl flex-col gap-2">
      {user && (
        <div className="hc-fade-in">
          <span className="mr-2 text-[10px] font-semibold tracking-[0.2em] text-phos uppercase">você</span>
          <span className="text-[13px] text-ink/90">{user}</span>
        </div>
      )}
      {bot && (
        <div className="hc-fade-in">
          <span className={cx('mr-2 text-[10px] font-semibold tracking-[0.2em] uppercase', speaking ? 'text-amber' : 'text-dim')}>bot</span>
          <span className="font-display text-[15px] leading-relaxed text-ink">{stripForSpeech(botTail)}</span>
        </div>
      )}
    </div>
  )
}

function FatalPanel({ fatal, onRetry, onSettings }: { fatal: Fatal; onRetry: () => void; onSettings: () => void }) {
  return (
    <div className="hc-rise flex max-w-md flex-col items-center gap-3 text-center">
      <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden className="text-alert">
        <circle cx="28" cy="28" r="26" fill="none" stroke="currentColor" strokeOpacity="0.35" />
        <rect x="22" y="12" width="12" height="22" rx="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M16 28a12 12 0 0 0 24 0M28 40v5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        {fatal.kind === 'mic' && <path d="M12 44L44 12" stroke="currentColor" strokeWidth="1.5" />}
      </svg>
      <div className="text-[11px] font-semibold tracking-[0.2em] text-alert uppercase">
        {fatal.kind === 'mic' ? 'microfone' : fatal.kind === 'bot' ? 'sem bot' : fatal.kind === 'rpc' ? 'gateway' : 'sessão de voz'}
      </div>
      <div className="text-[12px] text-dim">{fatal.message}</div>
      <div className="flex gap-2">
        {fatal.kind === 'mic' && (
          <Button size="sm" variant="outline" onClick={onSettings}>
            abrir Ajustes de Microfone
          </Button>
        )}
        {fatal.kind !== 'bot' && (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            tentar de novo
          </Button>
        )}
      </div>
    </div>
  )
}

// Keyframes locais do overlay (prefixo vo-). Reduced motion desliga tudo.
const VOICE_CSS = `
.vo-aurora{opacity:.55;background:
  radial-gradient(60% 50% at 30% 70%, color-mix(in srgb, var(--color-cyanic) 7%, transparent), transparent 70%),
  radial-gradient(50% 40% at 70% 30%, color-mix(in srgb, var(--color-amber) 7%, transparent), transparent 70%);
  animation: vo-drift 18s ease-in-out infinite alternate;}
.vo-aurora[data-phase="falando"]{opacity:.8}
.vo-aurora[data-phase="agindo"],.vo-aurora[data-phase="pensando"]{opacity:.75;filter:hue-rotate(-20deg)}
.vo-aurora[data-phase="erro"]{opacity:.3;filter:grayscale(1)}
@keyframes vo-drift{from{transform:translate3d(-2%,1%,0) scale(1)}to{transform:translate3d(2%,-1%,0) scale(1.06)}}
.vo-scan{background:linear-gradient(180deg,transparent 0%,color-mix(in srgb,var(--color-cyanic) 16%,transparent) 50%,transparent 100%);
  background-size:100% 30%;background-repeat:no-repeat;animation:vo-scan 2.2s linear infinite}
@keyframes vo-scan{from{background-position:0 -30%}to{background-position:0 130%}}
.vo-ripple{transform-origin:9px 9px;animation:vo-ripple 1.1s var(--hc-ease-out) infinite}
@keyframes vo-ripple{from{transform:scale(1);opacity:.9}to{transform:scale(3);opacity:0}}
@media (prefers-reduced-motion: reduce){
  .vo-aurora,.vo-scan,.vo-ripple{animation:none!important}
  .vo-scan{display:none}
}
`
