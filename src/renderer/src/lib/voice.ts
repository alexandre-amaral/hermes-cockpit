// Motor do voice mode do cockpit — réplica do fluxo real do app desktop oficial
// (~/.hermes/hermes-agent/apps/desktop/src/lib/voice-live.ts, voice-playback.ts e
// composer/hooks/use-voice-live-conversation.ts) sobre o transporte do cockpit.
//
// Dois motores, escolhidos por GET /api/audio/voice-live/status?profile=<bot>:
//
//  1. GPT-Live (voice.voice_chat_mode: gpt-live + chave OpenAI): WebRTC full-duplex.
//     O renderer cria o RTCPeerConnection (mic → track, fala ← track remoto) e o
//     data channel `oai-events`; a troca SDP passa por POST /api/audio/voice-live/session
//     (a chave fica no host). Cada `session.delegation.created` vira um prompt.submit
//     com surface "voice-live" + voice_context; a resposta do Hermes volta como
//     `session.commentary.append` (falada/parafraseada pelo modelo de voz) e o
//     progresso de tools como `session.thinking.append`.
//
//  2. Turno a turno ("chained", padrão do Hermes): MediaRecorder → POST
//     /api/audio/transcribe (data URL base64) → prompt.submit no Bot Chat → fala via
//     WS /api/audio/speak-stream (texto incremental in, PCM int16 mono out, sample
//     rate no frame {type:"start"}; {type:"fallback"} = provedor sem streaming) →
//     POST /api/audio/speak (data URL) → por último a voz do sistema (speechSynthesis),
//     sempre sinalizada na UI.
//
// REST via api() (proxy no main com token); WS via window.hermes.ws (proxy no main,
// frames binários). Nenhuma chave de provedor chega ao renderer.

import { api } from './ipc'
import type { WsProxyData, WsProxyStateInfo } from '../env'

// ─── status / config ────────────────────────────────────────────────────────

export type VoiceChatMode = 'chained' | 'gpt-live'

export interface VoiceLiveStatus {
  mode: VoiceChatMode
  available: boolean
  reason: string | null
  model: string
  voice: string
}

export interface VoiceSideConfig {
  mode: string
  provider?: string
  reason?: string
}

export interface VoiceProbe {
  live: VoiceLiveStatus | null
  liveError?: string
  stt: VoiceSideConfig | null
  tts: VoiceSideConfig | null
  configError?: string
}

const q = (profile: string | null | undefined) => (profile ? `?profile=${encodeURIComponent(profile)}` : '')

export function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  // apiFetch: "400 Bad Request: {"detail":"..."}" → só o detail
  const m = raw.match(/^\d{3}[^:]*:\s*(\{.*\})\s*$/s)
  if (m) {
    try {
      const j = JSON.parse(m[1]) as { detail?: unknown }
      if (typeof j.detail === 'string') return `${raw.slice(0, 3)} · ${j.detail}`
    } catch {
      /* corpo truncado */
    }
  }
  return raw
}

/** Lê os dois endpoints de diagnóstico; falha de um não esconde o outro. */
export async function probeVoice(profile: string): Promise<VoiceProbe> {
  const [live, cfg] = await Promise.allSettled([
    api<{ ok?: boolean } & Partial<VoiceLiveStatus>>(`/api/audio/voice-live/status${q(profile)}`),
    api<{ ok?: boolean; stt?: VoiceSideConfig; tts?: VoiceSideConfig }>(`/api/audio/voice-config${q(profile)}`),
  ])
  const out: VoiceProbe = { live: null, stt: null, tts: null }
  if (live.status === 'fulfilled' && live.value?.ok) {
    const v = live.value
    out.live = {
      mode: v.mode === 'gpt-live' ? 'gpt-live' : 'chained',
      available: Boolean(v.available),
      reason: v.reason ?? null,
      model: String(v.model ?? ''),
      voice: String(v.voice ?? ''),
    }
  } else if (live.status === 'rejected') out.liveError = errText(live.reason)
  if (cfg.status === 'fulfilled' && cfg.value?.ok) {
    out.stt = cfg.value.stt ?? null
    out.tts = cfg.value.tts ?? null
  } else if (cfg.status === 'rejected') out.configError = errText(cfg.reason)
  return out
}

// ─── microfone ─────────────────────────────────────────────────────────────

export function micErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'sem permissão de microfone — habilite o Hermes Cockpit em Ajustes do Sistema › Privacidade e Segurança › Microfone'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'nenhum microfone encontrado'
  if (name === 'NotReadableError') return 'o microfone está em uso por outro app ou indisponível'
  return `falha ao abrir o microfone: ${errText(e)}`
}

export const MIC_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
export const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

/** Nível RMS 0..1 de um AnalyserNode (time domain). */
export function levelOf(an: AnalyserNode | null, buf?: Float32Array<ArrayBuffer>): number {
  if (!an) return 0
  const data = buf && buf.length === an.fftSize ? buf : new Float32Array(an.fftSize)
  an.getFloatTimeDomainData(data)
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
  return Math.min(1, Math.sqrt(sum / data.length) * 3.2)
}

/** Microfone com AnalyserNode (nível para o orb e para o VAD). */
export class MicInput {
  stream: MediaStream | null = null
  ctx: AudioContext | null = null
  analyser: AnalyserNode | null = null
  private buf: Float32Array<ArrayBuffer> | null = null

  async start(): Promise<MediaStream> {
    if (this.stream) return this.stream
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.stream = stream
    try {
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const an = ctx.createAnalyser()
      an.fftSize = 1024
      an.smoothingTimeConstant = 0.6
      src.connect(an)
      this.ctx = ctx
      this.analyser = an
      this.buf = new Float32Array(an.fftSize)
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    } catch {
      /* sem analyser: sem nível visual nem VAD — PTT continua funcionando */
    }
    return stream
  }

  level(): number {
    return levelOf(this.analyser, this.buf ?? undefined)
  }

  setEnabled(on: boolean): void {
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = on
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.analyser?.disconnect()
    this.analyser = null
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }
}

/** Gravação de um turno sobre o stream do mic (não reabre o dispositivo). */
export class TurnRecorder {
  private rec: MediaRecorder | null = null
  private chunks: Blob[] = []
  private startedAt = 0

  get recording(): boolean {
    return this.rec?.state === 'recording'
  }

  start(stream: MediaStream): void {
    if (this.recording) return
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(
      (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
    )
    this.chunks = []
    this.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data)
    }
    this.startedAt = performance.now()
    this.rec.start(250)
  }

  /** Para e devolve o áudio (null se nada útil foi gravado). */
  stop(): Promise<{ blob: Blob; ms: number } | null> {
    const rec = this.rec
    this.rec = null
    if (!rec || rec.state === 'inactive') return Promise.resolve(null)
    const ms = performance.now() - this.startedAt
    return new Promise((resolve) => {
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm'
        const blob = new Blob(this.chunks, { type })
        this.chunks = []
        resolve(blob.size > 0 ? { blob, ms } : null)
      }
      try {
        rec.stop()
      } catch {
        resolve(null)
      }
    })
  }

  cancel(): void {
    const rec = this.rec
    this.rec = null
    this.chunks = []
    try {
      if (rec && rec.state !== 'inactive') rec.stop()
    } catch {
      /* ignore */
    }
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(fr.error ?? new Error('falha ao ler o áudio'))
    fr.readAsDataURL(blob)
  })
}

/** POST /api/audio/transcribe — "" = silêncio (o backend trata "empty transcript" como ok). */
export async function transcribe(profile: string, blob: Blob): Promise<{ text: string; provider?: string }> {
  const mime = (blob.type || 'audio/webm').split(';')[0]
  const dataUrl = await blobToDataUrl(blob)
  const res = await api<{ ok?: boolean; transcript?: string; provider?: string }>(`/api/audio/transcribe${q(profile)}`, {
    method: 'POST',
    body: { data_url: dataUrl, mime_type: mime },
  })
  return { text: String(res?.transcript ?? '').trim(), provider: res?.provider }
}

// ─── VAD por energia ───────────────────────────────────────────────────────

export interface VadOptions {
  /** nível (0..1) acima do qual conta como fala */
  threshold: number
  /** ms de fala contínua para abrir */
  attackMs: number
  /** ms de silêncio para fechar */
  releaseMs: number
}

export const DEFAULT_VAD: VadOptions = { threshold: 0.075, attackMs: 140, releaseMs: 900 }

/** Porta de voz simples: estado aberto/fechado com histerese por tempo. */
export class EnergyVad {
  private open = false
  private aboveSince = 0
  private belowSince = 0
  private noise = 0.02
  constructor(private opts: VadOptions = DEFAULT_VAD) {}

  get isOpen(): boolean {
    return this.open
  }

  reset(): void {
    this.open = false
    this.aboveSince = 0
    this.belowSince = 0
  }

  /** Alimenta um nível; devolve 'start' | 'end' na transição. */
  feed(level: number, now = performance.now()): 'start' | 'end' | null {
    // piso de ruído adaptativo (só aprende em silêncio)
    if (!this.open && level < this.opts.threshold) this.noise = this.noise * 0.98 + level * 0.02
    const thr = Math.max(this.opts.threshold, this.noise * 2.4)
    if (level >= thr) {
      this.belowSince = 0
      if (!this.aboveSince) this.aboveSince = now
      if (!this.open && now - this.aboveSince >= this.opts.attackMs) {
        this.open = true
        return 'start'
      }
    } else {
      this.aboveSince = 0
      if (this.open) {
        if (!this.belowSince) this.belowSince = now
        if (now - this.belowSince >= this.opts.releaseMs) {
          this.open = false
          this.belowSince = 0
          return 'end'
        }
      }
    }
    return null
  }
}

// ─── fala (TTS) ────────────────────────────────────────────────────────────

export type SpeechRoute = 'stream' | 'post' | 'sistema'

let wsSeq = 0

/**
 * Saída de fala com AnalyserNode (nível da fala do bot para o orb). Uma "fala" por
 * resposta: begin() abre o speak-stream e aceita texto incremental; o fallback
 * acontece sozinho (POST e depois voz do sistema) quando o provedor não faz stream.
 */
export class SpeechOut {
  ctx: AudioContext | null = null
  analyser: AnalyserNode | null = null
  private buf: Float32Array<ArrayBuffer> | null = null
  private sources = new Set<AudioScheduledSourceNode>()
  private nextAt = 0
  private stopCurrent: (() => void) | null = null
  private sysSpeaking = false
  /** última rota usada e o erro que levou ao fallback (para a UI) */
  route: SpeechRoute | null = null
  routeNote: string | null = null
  onSpeaking: (on: boolean) => void = () => {}
  private speaking = false

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext()
      const an = ctx.createAnalyser()
      an.fftSize = 1024
      an.smoothingTimeConstant = 0.5
      an.connect(ctx.destination)
      this.ctx = ctx
      this.analyser = an
      this.buf = new Float32Array(an.fftSize)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined)
    return this.ctx
  }

  level(): number {
    if (this.sysSpeaking) return 0.35 + 0.15 * Math.sin(performance.now() / 120)
    return levelOf(this.analyser, this.buf ?? undefined)
  }

  get isSpeaking(): boolean {
    return this.speaking
  }

  private setSpeaking(on: boolean): void {
    if (on === this.speaking) return
    this.speaking = on
    this.onSpeaking(on)
  }

  private playBuffer(buffer: AudioBuffer): void {
    const ctx = this.ensureCtx()
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.analyser ?? ctx.destination)
    const at = Math.max(ctx.currentTime + 0.04, this.nextAt)
    src.start(at)
    this.nextAt = at + buffer.duration
    this.sources.add(src)
    this.setSpeaking(true)
    src.onended = () => {
      this.sources.delete(src)
      if (!this.sources.size) this.setSpeaking(false)
    }
  }

  private pcmCarry: Uint8Array | null = null
  private playPcm(data: ArrayBuffer, rate: number): void {
    let bytes = new Uint8Array(data)
    if (this.pcmCarry) {
      const j = new Uint8Array(this.pcmCarry.length + bytes.length)
      j.set(this.pcmCarry)
      j.set(bytes, this.pcmCarry.length)
      bytes = j
      this.pcmCarry = null
    }
    const usable = bytes.length - (bytes.length % 2)
    if (bytes.length !== usable) this.pcmCarry = bytes.slice(usable)
    if (!usable) return
    // cópia alinhada (o slice do IPC pode vir com offset ímpar)
    const aligned = bytes.slice(0, usable)
    const pcm = new Int16Array(aligned.buffer, 0, usable / 2)
    const ctx = this.ensureCtx()
    const buffer = ctx.createBuffer(1, pcm.length, rate)
    const ch = buffer.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768
    this.playBuffer(buffer)
  }

  /** Interrompe qualquer fala (barge-in). */
  stop(): void {
    const s = this.stopCurrent
    this.stopCurrent = null
    s?.()
    for (const src of this.sources) {
      try {
        src.stop()
      } catch {
        /* já parou */
      }
    }
    this.sources.clear()
    this.nextAt = 0
    this.pcmCarry = null
    if (this.sysSpeaking && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
    this.sysSpeaking = false
    this.setSpeaking(false)
  }

  /**
   * Abre uma fala incremental. `append` recebe deltas crus (o servidor corta por
   * frase e tira markdown); `finish` fecha o texto. `done` resolve quando o áudio
   * terminou (ou foi interrompido) com a rota usada.
   */
  begin(profile: string): { append: (t: string) => void; finish: () => void; done: Promise<SpeechRoute | 'erro'> } {
    this.stop()
    let full = ''
    let finished = false
    let settled = false
    let started = false
    let rate = 24000
    let resolveDone: (r: SpeechRoute | 'erro') => void = () => {}
    const done = new Promise<SpeechRoute | 'erro'>((r) => (resolveDone = r))
    const bridge = typeof window !== 'undefined' ? window.hermes?.ws : undefined
    const id = `voice-tts-${Date.now().toString(36)}-${++wsSeq}`
    const pending: string[] = []
    let open = false
    let offFrame: () => void = () => {}
    let offState: () => void = () => {}

    const closeWs = () => {
      offFrame()
      offState()
      if (bridge) bridge.close(id, 1000, 'fim')
    }
    const settle = (r: SpeechRoute | 'erro') => {
      if (settled) return
      settled = true
      closeWs()
      resolveDone(r)
    }
    const drainThenSettle = () => {
      const ms = this.ctx ? Math.max(0, this.nextAt - this.ctx.currentTime) * 1000 : 0
      window.setTimeout(() => settle('stream'), ms + 120)
    }
    const fallback = () => {
      if (settled) return
      closeWs()
      // espera o texto completo e fala de uma vez
      const go = async () => {
        while (!finished && !settled) await new Promise((r) => setTimeout(r, 120))
        if (settled) return
        const r = await this.speakWhole(profile, full)
        settle(r)
      }
      void go()
    }

    this.stopCurrent = () => settle(started ? 'stream' : 'erro')

    if (!bridge) {
      fallback()
    } else {
      offFrame = bridge.onFrame((fid: string, data: WsProxyData) => {
        if (fid !== id || settled) return
        if (typeof data !== 'string') {
          if (!started) {
            started = true
            this.route = 'stream'
            this.routeNote = null
          }
          this.playPcm(data, rate)
          return
        }
        let f: { type?: string; sample_rate?: number }
        try {
          f = JSON.parse(data) as typeof f
        } catch {
          return
        }
        if (f.type === 'start') {
          rate = f.sample_rate || 24000
          this.ensureCtx()
        } else if (f.type === 'end') drainThenSettle()
        else if (f.type === 'fallback') fallback()
      })
      offState = bridge.onState((sid: string, info: WsProxyStateInfo) => {
        if (sid !== id || settled) return
        if (info.state === 'open') {
          open = true
          for (const p of pending.splice(0)) bridge.send(id, p)
        } else if (info.state === 'closed' || info.state === 'error') {
          if (started) drainThenSettle()
          else fallback()
        }
      })
      void bridge.open(id, `/api/audio/speak-stream${q(profile)}`).then(
        (r) => {
          if (!r.ok && !started) fallback()
        },
        () => !started && fallback(),
      )
    }

    const send = (frame: object) => {
      if (!bridge || settled) return
      const s = JSON.stringify(frame)
      if (open) bridge.send(id, s)
      else pending.push(s)
    }

    return {
      append: (t: string) => {
        if (!t || finished) return
        full += t
        send({ text: t })
      },
      finish: () => {
        if (finished) return
        finished = true
        send({ done: true })
        if (!full.trim()) settle('stream')
      },
      done,
    }
  }

  /** POST /api/audio/speak → toca o data URL; falhou → voz do sistema. */
  async speakWhole(profile: string, text: string): Promise<SpeechRoute | 'erro'> {
    const clean = stripForSpeech(text)
    if (!clean) return 'post'
    let stopped = false
    this.stopCurrent = () => {
      stopped = true
    }
    try {
      const res = await api<{ ok?: boolean; data_url?: string }>(`/api/audio/speak${q(profile)}`, {
        method: 'POST',
        body: { text: clean.slice(0, 4000) },
      })
      if (stopped) return 'post'
      if (!res?.data_url) throw new Error('resposta sem áudio')
      const bin = await (await fetch(res.data_url)).arrayBuffer()
      const ctx = this.ensureCtx()
      const buffer = await ctx.decodeAudioData(bin)
      if (stopped) return 'post'
      this.route = 'post'
      this.routeNote = null
      this.playBuffer(buffer)
      await new Promise<void>((r) => {
        const tick = () => (!this.sources.size || stopped ? r() : setTimeout(tick, 120))
        setTimeout(tick, 120)
      })
      return 'post'
    } catch (e) {
      if (stopped) return 'erro'
      this.routeNote = `TTS do Hermes falhou (${errText(e).slice(0, 160)}) — usando a voz do sistema`
      return this.speakSystem(clean)
    }
  }

  /** speechSynthesis do próprio SO (último recurso, sempre sinalizado na UI). */
  speakSystem(text: string): Promise<SpeechRoute | 'erro'> {
    if (typeof speechSynthesis === 'undefined') return Promise.resolve('erro')
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'pt-BR'
      const v = speechSynthesis.getVoices().find((x) => x.lang?.toLowerCase().startsWith('pt'))
      if (v) u.voice = v
      this.route = 'sistema'
      this.sysSpeaking = true
      this.setSpeaking(true)
      const end = () => {
        this.sysSpeaking = false
        this.setSpeaking(false)
        resolve('sistema')
      }
      u.onend = end
      u.onerror = end
      this.stopCurrent = () => {
        speechSynthesis.cancel()
        end()
      }
      speechSynthesis.speak(u)
    })
  }

  close(): void {
    this.stop()
    this.analyser?.disconnect()
    this.analyser = null
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }
}

/** Texto falável: sem blocos de código, markdown, URLs longas. */
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (código omitido) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~>|]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── GPT-Live (WebRTC) ─────────────────────────────────────────────────────

export interface LiveHistoryMessage {
  type: 'message'
  role: 'assistant' | 'developer' | 'user'
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>
}

export interface LiveFragment {
  speaker: 'assistant' | 'user'
  text: string
  startMs: number
  endMs: number
}

export interface LiveHandlers {
  onDelegation: (delegationId: string, context: LiveFragment[]) => void
  onError: (message: string) => void
  onClosed: (reason: string, usageSeconds: number | null) => void
  onTranscript?: (f: LiveFragment) => void
  onSpeakingChange?: (speaking: boolean) => void
}

const LIVE_APPEND_LIMIT = 1400
const LIVE_CONTEXT_MS = 5 * 60_000

export function chunkForCommentary(text: string, limit = LIVE_APPEND_LIMIT): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  if (clean.length <= limit) return [clean]
  const out: string[] = []
  let cur = ''
  for (const s of clean.split(/(?<=[.!?])\s+/)) {
    if (s.length > limit) {
      if (cur) out.push(cur)
      cur = ''
      for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit))
      continue
    }
    const cand = cur ? `${cur} ${s}` : s
    if (cand.length > limit) {
      out.push(cur)
      cur = s
    } else cur = cand
  }
  if (cur) out.push(cur)
  return out
}

export function toLiveHistory(turns: Array<{ role: 'assistant' | 'user'; text: string }>, maxMessages = 24, maxChars = 6000): LiveHistoryMessage[] {
  const out: LiveHistoryMessage[] = []
  let budget = maxChars
  for (const t of [...turns].reverse()) {
    const text = t.text.replace(/\s+/g, ' ').trim().slice(0, 1200)
    if (!text) continue
    if (out.length >= maxMessages || budget - text.length < 0) break
    budget -= text.length
    out.unshift({ type: 'message', role: t.role, content: [{ type: t.role === 'assistant' ? 'output_text' : 'input_text', text }] })
  }
  return out
}

/** Prompt (últimas palavras do usuário) + contexto falado recente (só para o modelo). */
export function delegationPrompt(context: LiveFragment[]): { prompt: string; context: string } {
  const turns: Array<{ speaker: 'assistant' | 'user'; text: string }> = []
  for (const f of context) {
    const last = turns.at(-1)
    if (last && last.speaker === f.speaker) last.text += f.text
    else turns.push({ speaker: f.speaker, text: f.text })
  }
  const lastUser = [...turns].reverse().find((t) => t.speaker === 'user')
  const prompt = (lastUser?.text ?? '').replace(/\s+/g, ' ').trim()
  const transcript = turns
    .map((t) => `${t.speaker === 'user' ? 'User' : 'Voice assistant'}: ${t.text.replace(/\s+/g, ' ').trim()}`)
    .filter((l) => !l.endsWith(': '))
    .join('\n')
  return { prompt: prompt || transcript.slice(-400), context: transcript }
}

export class LiveSession {
  readonly audio: HTMLAudioElement
  private peer: RTCPeerConnection | null = null
  private events: RTCDataChannel | null = null
  private mic: MediaStream | null = null
  private closeTimer: number | null = null
  private finalized = false
  private seq = 0
  private transcript: LiveFragment[] = []
  private probe: number | null = null
  private ctx: AudioContext | null = null
  outAnalyser: AnalyserNode | null = null
  private lastSpeaking = false
  sessionId: string | null = null
  activeDelegationId: string | null = null

  constructor(private readonly profile: string, private readonly h: LiveHandlers) {
    this.audio = new Audio()
    this.audio.autoplay = true
  }

  private nextId(p: string): string {
    return `${p}_${++this.seq}`
  }

  private send(ev: Record<string, unknown>): boolean {
    if (!this.events || this.events.readyState !== 'open') return false
    this.events.send(JSON.stringify(ev))
    return true
  }

  contextWindow(): LiveFragment[] {
    const last = this.transcript.at(-1)
    if (!last) return []
    const floor = last.endMs - LIVE_CONTEXT_MS
    return this.transcript.filter((f) => f.endMs >= floor).slice(-80)
  }

  /** `mic` é o stream já aberto pelo MicInput (um só pedido de permissão). */
  async start(mic: MediaStream, history: LiveHistoryMessage[]): Promise<void> {
    if (this.peer) throw new Error('sessão GPT-Live já iniciada')
    const pc = new RTCPeerConnection()
    this.peer = pc
    this.mic = mic
    pc.addEventListener('track', (ev) => {
      const stream = new MediaStream([ev.track])
      this.audio.srcObject = stream
      void this.audio.play().catch(() => undefined)
      this.armProbe(stream)
    })
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.finish('connection_lost', null)
    })
    for (const t of mic.getAudioTracks()) pc.addTrack(t, mic)
    const ch = pc.createDataChannel('oai-events')
    this.events = ch
    ch.addEventListener('message', ({ data }) => this.handle(String(data)))
    ch.addEventListener('close', () => !this.finalized && this.finish('connection_lost', null))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitIce(pc)
    const sdp = pc.localDescription?.sdp
    if (!sdp) throw new Error('SDP local ausente')
    const res = await api<{ ok?: boolean; session?: { id: string }; transport?: { sdp: string } }>(
      `/api/audio/voice-live/session${q(this.profile)}`,
      { method: 'POST', body: { sdp, history } },
    )
    if (!res?.ok || !res.transport?.sdp) throw new Error('criação da sessão GPT-Live falhou')
    this.sessionId = res.session?.id ?? null
    await pc.setRemoteDescription({ type: 'answer', sdp: res.transport.sdp })
  }

  private armProbe(stream: MediaStream): void {
    try {
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const an = ctx.createAnalyser()
      an.fftSize = 1024
      src.connect(an)
      this.ctx = ctx
      this.outAnalyser = an
      const buf = new Float32Array(an.fftSize)
      let quiet = 0
      this.probe = window.setInterval(() => {
        const lvl = levelOf(an, buf)
        const loud = lvl > 0.04
        quiet = loud ? 0 : quiet + 1
        const speaking = loud || quiet < 4
        if (speaking !== this.lastSpeaking) {
          this.lastSpeaking = speaking
          this.h.onSpeakingChange?.(speaking)
        }
      }, 100)
    } catch {
      /* sem indicador de fala; a conversa segue */
    }
  }

  private handle(raw: string): void {
    let ev: {
      type?: string
      delta?: string
      start_ms?: number
      end_ms?: number
      delegation?: { id?: string }
      error?: { code?: string | null; message?: string }
      usage?: { seconds?: number }
      reason?: string
      session?: { id?: string }
    }
    try {
      ev = JSON.parse(raw) as typeof ev
    } catch {
      return
    }
    switch (ev.type) {
      case 'session.started':
        this.sessionId = ev.session?.id ?? this.sessionId
        return
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        const f: LiveFragment = {
          speaker: ev.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
          text: ev.delta ?? '',
          startMs: ev.start_ms ?? 0,
          endMs: ev.end_ms ?? 0,
        }
        this.transcript.push(f)
        if (this.transcript.length > 2000) this.transcript.splice(0, 500)
        this.h.onTranscript?.(f)
        return
      }
      case 'session.delegation.created': {
        const id = ev.delegation?.id
        if (id) {
          this.activeDelegationId = id
          this.h.onDelegation(id, this.contextWindow())
        }
        return
      }
      case 'error':
        if (ev.error?.code === 'context_injection_incomplete') return
        this.h.onError(ev.error?.message ?? 'erro do GPT-Live')
        return
      case 'session.closed':
        this.finish(ev.reason ?? 'closed', ev.usage?.seconds ?? null)
        return
      default:
        return
    }
  }

  think(delegationId: string | null, content: string): void {
    const text = content.replace(/\s+/g, ' ').trim().slice(0, LIVE_APPEND_LIMIT)
    if (text) this.send({ type: 'session.thinking.append', delegation_id: delegationId, content: text, event_id: this.nextId('think') })
  }

  speak(delegationId: string | null, content: string): void {
    for (const c of chunkForCommentary(content))
      this.send({ type: 'session.commentary.append', delegation_id: delegationId, content: c, event_id: this.nextId('say') })
  }

  instruct(content: string): void {
    const text = content.trim().slice(0, LIVE_APPEND_LIMIT)
    if (text) this.send({ type: 'session.instructions.append', delegation_id: null, content: text, event_id: this.nextId('instr') })
  }

  setMuted(muted: boolean): void {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted
    this.send({ type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute', event_id: this.nextId(muted ? 'mute' : 'unmute') })
  }

  /** Barge-in local: corta o áudio do bot já tocando. */
  duck(on: boolean): void {
    this.audio.muted = on
  }

  close(): void {
    if (this.finalized) return
    if (!this.send({ type: 'session.close' })) {
      this.finish('close_requested', null)
      return
    }
    this.closeTimer = window.setTimeout(() => this.finish('close_requested', null), 15_000)
  }

  private finish(reason: string, usage: number | null): void {
    if (this.finalized) return
    this.finalized = true
    if (this.closeTimer) window.clearTimeout(this.closeTimer)
    if (this.probe) window.clearInterval(this.probe)
    this.outAnalyser?.disconnect()
    void this.ctx?.close().catch(() => undefined)
    this.events?.close()
    this.peer?.close()
    this.audio.srcObject = null
    this.audio.pause()
    // o mic pertence ao MicInput do overlay — não para aqui
    this.h.onClosed(reason, usage)
  }
}

function waitIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', on)
      resolve()
    }, 10_000)
    function on() {
      if (pc.iceGatheringState !== 'complete') return
      window.clearTimeout(t)
      pc.removeEventListener('icegatheringstatechange', on)
      resolve()
    }
    pc.addEventListener('icegatheringstatechange', on)
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') {
        window.clearTimeout(t)
        reject(new Error('conexão WebRTC falhou'))
      }
    })
  })
}

// ─── computer use: leitura dos args do tool ────────────────────────────────

export interface ComputerAction {
  action: string
  app?: string
  coordinate?: [number, number]
  from?: [number, number]
  to?: [number, number]
  element?: number
  text?: string
  keys?: string
  direction?: string
}

export const COMPUTER_TOOL = 'computer_use'

export function isComputerTool(name: unknown): boolean {
  return typeof name === 'string' && (name === COMPUTER_TOOL || name.endsWith(`.${COMPUTER_TOOL}`) || name.startsWith('computer_use'))
}

function pair(v: unknown): [number, number] | undefined {
  return Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : undefined
}

export function parseComputerArgs(args: unknown): ComputerAction | null {
  let a = args
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a)
    } catch {
      return null
    }
  }
  if (!a || typeof a !== 'object') return null
  const o = a as Record<string, unknown>
  if (typeof o.action !== 'string') return null
  return {
    action: o.action,
    app: typeof o.app === 'string' ? o.app : undefined,
    coordinate: pair(o.coordinate),
    from: pair(o.from_coordinate),
    to: pair(o.to_coordinate),
    element: typeof o.element === 'number' ? o.element : undefined,
    text: typeof o.text === 'string' ? o.text : typeof o.value === 'string' ? o.value : undefined,
    keys: typeof o.keys === 'string' ? o.keys : undefined,
    direction: typeof o.direction === 'string' ? o.direction : undefined,
  }
}

const ACTION_LABEL: Record<string, string> = {
  capture: 'captura de tela',
  click: 'clique',
  double_click: 'clique duplo',
  right_click: 'clique direito',
  middle_click: 'clique do meio',
  drag: 'arrastar',
  scroll: 'rolar',
  type: 'digitar',
  key: 'tecla',
  set_value: 'definir valor',
  wait: 'esperar',
  list_apps: 'listar apps',
  list_windows: 'listar janelas',
  focus_app: 'focar app',
}

export function describeComputer(a: ComputerAction): string {
  const base = ACTION_LABEL[a.action] ?? a.action
  const bits: string[] = [base]
  if (a.element != null) bits.push(`elemento #${a.element}`)
  if (a.coordinate) bits.push(`(${a.coordinate[0]}, ${a.coordinate[1]})`)
  if (a.from && a.to) bits.push(`(${a.from.join(',')}) → (${a.to.join(',')})`)
  if (a.keys) bits.push(a.keys)
  if (a.text) bits.push(`“${a.text.length > 48 ? `${a.text.slice(0, 48)}…` : a.text}”`)
  if (a.direction) bits.push(a.direction)
  if (a.app) bits.push(`· ${a.app}`)
  return bits.join(' ')
}

/** Frases de parada faladas (encerram a conversa em vez de virar turno). */
export function isStopPhrase(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, '')
    .trim()
  return /^(para|pare|parar|chega|encerrar|encerra|tchau|stop|sair)( (a )?(conversa|voz))?$/.test(t)
}
