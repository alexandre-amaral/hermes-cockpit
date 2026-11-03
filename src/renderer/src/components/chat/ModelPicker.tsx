import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api } from '../../lib/ipc'
import type { HermesRpc } from '../../lib/rpc'
import { toast } from '../../lib/toast'
import {
  modelInfo,
  modelOptions,
  setProfileDefaultModel,
  switchModel,
  type ModelInfo,
  type ModelOptionProvider,
  type ModelOptions,
} from '../../lib/gateway'

export type ModelScope = 'chat' | 'bot'

interface Props {
  rpc: HermesRpc
  profile: string
  /** título humano do bot (cabeçalho) */
  botTitle: string
  /** id runtime da sessão ativa — config.set só troca modelo com sessão viva */
  sessionId: string | null
  /** a aba ativa é o Bot Chat canônico (segue o config do profile) */
  isBotChat: boolean
  currentModel: string | null
  currentProvider: string | null
  fallback: { model: string; provider?: string }[]
  onClose: () => void
  /** chamado após troca bem-sucedida (o ChatPane recarrega o chip / nota no chat) */
  onSwitched: (r: { model: string; provider: string; scope: ModelScope; note: string }) => void
}

interface Entry {
  key: string
  provider: ModelOptionProvider
  model: string
  current: boolean
  fallbackIdx: number
  unavailable: boolean
}

const LOCAL_SLUGS = /^(ollama|lmstudio|lm-studio|llamacpp|llama-cpp|llama\.cpp|vllm|local|mlx|localai|jan)$/i
const HIDDEN_PROVIDER = /codex/i // o usuário não usa mais Codex — fora da UI

function isLocal(p: ModelOptionProvider): boolean {
  if (LOCAL_SLUGS.test(p.slug)) return true
  const url = String(p.api_url ?? '')
  return /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(url)
}

function fmtCtx(n: number): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  return `${Math.round(n / 1000)}k`
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Seletor de modelo do cockpit: painel com busca, grupos por provider, badges
// local/cloud, raciocínio/rápido/preço, atual e fallback destacados, teclado
// (↑↓ ⏎ esc) e escopo:
//  - "este chat": config.set {value:"<m> --provider <p> --session"} na sessão viva.
//    No Bot Chat (follow_profile_config) vale até o próximo resume.
//  - "padrão do bot": PUT /api/profiles/<bot>/model (config.yaml DO PROFILE, nunca o
//    do serve) + a mesma troca --session na sessão viva para valer já.
export function ModelPicker(props: Props) {
  const { rpc, profile, botTitle, sessionId, isBotChat, currentModel, currentProvider, fallback, onClose, onSwitched } = props
  const [opts, setOpts] = useState<ModelOptions | null>(null)
  const [info, setInfo] = useState<ModelInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ModelScope>(sessionId ? 'chat' : 'bot')
  const [busy, setBusy] = useState<string | null>(null)
  const [sel, setSel] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [confirm, setConfirm] = useState<{ entry: Entry; message: string } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback(
    (refresh = false) => {
      let alive = true
      if (refresh) setRefreshing(true)
      setError(null)
      modelOptions(rpc, { profile, sessionId: sessionId ?? undefined, refresh })
        .then((o) => alive && setOpts(o))
        .catch((e) => alive && setError(errText(e)))
        .finally(() => alive && setRefreshing(false))
      return () => {
        alive = false
      }
    },
    [rpc, profile, sessionId],
  )

  useEffect(() => load(false), [load])

  useEffect(() => {
    let alive = true
    modelInfo(api, profile)
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setInfo(null)) // contexto é opcional: sem REST, some o badge
    return () => {
      alive = false
    }
  }, [profile])

  // clique fora fecha (o chip que abre o painel é ignorado — ele mesmo alterna)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (root.current?.contains(t) || t.closest?.('[data-model-chip]')) return
      onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [onClose])

  const current = opts?.model || currentModel || ''
  const currentProv = opts?.provider || currentProvider || ''

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const terms = q.split(/\s+/).filter(Boolean)
    const provs = (opts?.providers ?? []).filter((p) => p.authenticated !== false && !HIDDEN_PROVIDER.test(p.slug))
    const out: { provider: ModelOptionProvider; local: boolean; entries: Entry[] }[] = []
    for (const p of provs) {
      const unavailable = new Set(p.unavailable_models ?? [])
      const hay = `${p.slug} ${p.name}`.toLowerCase()
      const entries: Entry[] = p.models
        .filter((m) => !terms.length || terms.every((t) => m.toLowerCase().includes(t) || hay.includes(t)))
        .map((m) => ({
          key: `${p.slug}/${m}`,
          provider: p,
          model: m,
          current: m === current && p.slug === currentProv,
          fallbackIdx: fallback.findIndex((f) => f.model === m && (!f.provider || f.provider === p.slug)),
          unavailable: unavailable.has(m),
        }))
      if (entries.length) out.push({ provider: p, local: isLocal(p), entries })
    }
    // provider atual primeiro, depois locais, depois o resto (ordem do backend)
    const rank = (g: (typeof out)[number]) => (g.provider.slug === currentProv ? 0 : g.local ? 1 : 2)
    return out.sort((a, b) => rank(a) - rank(b))
  }, [opts, query, current, currentProv, fallback])

  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups])

  // seleção inicial no modelo atual; ao filtrar, volta ao primeiro resultado
  useEffect(() => {
    if (query) setSel(0)
    else {
      const i = flat.findIndex((e) => e.current)
      setSel(i >= 0 ? i : 0)
    }
    // flat muda junto com query; só reagir à query e à 1ª carga
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts])

  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const apply = async (entry: Entry, confirmed = false) => {
    const { model } = entry
    const provider = entry.provider.slug
    if (scope === 'chat' && !sessionId) {
      setError('sem sessão viva — "este chat" exige o chat aberto')
      return
    }
    setBusy(entry.key)
    setError(null)
    try {
      let deferred = false
      let warning: string | null = null
      if (sessionId) {
        const res = await switchModel(rpc, { sessionId, profile, model, provider, persist: false, confirm: confirmed })
        if (res.confirm_required) {
          setConfirm({ entry, message: res.confirm_message || 'Modelo caro — confirmar a troca?' })
          return
        }
        deferred = Boolean(res.deferred)
        warning = res.warning ?? null
      }
      if (scope === 'bot') await setProfileDefaultModel(api, profile, provider, model)
      const scopeLabel = scope === 'bot' ? `padrão do ${botTitle}` : isBotChat ? 'este chat (até o próximo resume)' : 'este chat'
      const parts = [`modelo → ${model} (${entry.provider.name || provider}) · ${scopeLabel}`]
      if (deferred) parts.push('aplica no próximo turno')
      if (warning) parts.push(warning)
      const note = parts.join(' · ')
      toast({ title: `Modelo: ${model}`, detail: parts.slice(1).join(' · ') || scopeLabel, tone: warning ? 'warn' : 'ok' })
      onSwitched({ model, provider, scope, note })
      onClose()
    } catch (e) {
      const msg = errText(e)
      setError(msg)
      toast({ title: 'Troca de modelo falhou', detail: msg, tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const listId = useId()
  // ↑↓ pulam modelos que o provider marca como indisponíveis.
  const step = (from: number, dir: 1 | -1): number => {
    const n = flat.length
    if (!n) return 0
    for (let k = 1; k <= n; k++) {
      const j = (((from + dir * k) % n) + n) % n
      if (!flat[j]?.unavailable) return j
    }
    return from
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      if (confirm) setConfirm(null)
      else onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => step(s, 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => step(s, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (confirm) {
        const c = confirm
        setConfirm(null)
        void apply(c.entry, true)
      } else if (flat[sel] && !flat[sel].unavailable && !busy) void apply(flat[sel])
    } else if (e.key === 'Tab' && !e.shiftKey && document.activeElement === input.current) {
      e.preventDefault()
      // "este chat" exige sessão viva (o radio fica desabilitado sem ela).
      if (sessionId) setScope((s) => (s === 'chat' ? 'bot' : 'chat'))
      else setScope('bot')
    }
  }

  const ctx = info && info.model === current ? info.effective_context_length : 0
  let idx = -1

  return (
    <div
      ref={root}
      onKeyDown={onKey}
      className="hc-glass hc-fade-in absolute left-0 top-full z-40 mt-1.5 flex max-h-[70vh] w-[480px] max-w-[86vw] flex-col overflow-hidden rounded-lg border border-edge2 shadow-2xl"
    >
      {/* cabeçalho: modelo atual + fallback */}
      <div className="border-b border-edge px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-2">
          <span className="label">Modelo · {botTitle}</span>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            title="recarregar catálogo dos providers"
            className="ml-auto rounded px-1.5 text-[11px] text-faint hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            {refreshing ? '…' : '↻'}
          </button>
          <button onClick={onClose} className="rounded px-1.5 text-faint hover:bg-hover hover:text-ink" aria-label="fechar">
            ✕
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-amber" />
            <span className="text-ink">{current || '—'}</span>
            {currentProv && <span className="text-faint">{currentProv}</span>}
            {ctx > 0 && <Badge tone="dim">ctx {fmtCtx(ctx)}</Badge>}
          </span>
          {fallback.length > 0 && (
            <span className="flex min-w-0 items-center gap-1.5 text-dim">
              <span className="text-cyanic">fallback</span>
              <span className="truncate">{fallback.map((f) => f.model).join(' → ')}</span>
            </span>
          )}
        </div>
      </div>

      {/* busca + escopo */}
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-faint">⌕</span>
          <input
            ref={input}
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat[sel] ? `${listId}-${sel}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="buscar modelo ou provider…"
            className="w-full rounded border border-edge bg-void py-1 pl-6 pr-2 text-[12px] text-ink placeholder:text-faint focus:border-amber/60 focus:outline-none"
          />
        </div>
        <div className="flex shrink-0 overflow-hidden rounded border border-edge2 text-[11px]" role="radiogroup" aria-label="escopo">
          {(['chat', 'bot'] as const).map((s) => (
            <button
              key={s}
              role="radio"
              aria-checked={scope === s}
              disabled={s === 'chat' && !sessionId}
              onClick={() => setScope(s)}
              title={
                s === 'chat'
                  ? 'só a sessão aberta (config.set --session)'
                  : `grava no config.yaml do profile ${profile} — vale para chats novos e para o Bot Chat`
              }
              className={`px-2 py-1 transition-colors disabled:opacity-40 ${
                scope === s ? 'bg-amber font-semibold text-void' : 'text-dim hover:bg-hover hover:text-ink'
              }`}
            >
              {s === 'chat' ? 'este chat' : 'padrão do bot'}
            </button>
          ))}
        </div>
      </div>

      {(scope === 'chat' && isBotChat) || !sessionId || error || confirm ? (
        <div className="space-y-1.5 border-b border-edge px-3 py-1.5 text-[11px]">
          {scope === 'chat' && isBotChat && (
            <div className="text-faint">
              O Bot Chat segue o config do profile: a troca "este chat" vale até o próximo resume. Para fixar, use{' '}
              <button onClick={() => setScope('bot')} className="text-amber hover:underline">
                padrão do bot
              </button>
              .
            </div>
          )}
          {!sessionId && <div className="text-amber">sem sessão viva — só dá para gravar o padrão do bot</div>}
          {error && <div className="text-alert">{error}</div>}
          {confirm && (
            <div className="rounded border border-dashed border-amber/60 px-2 py-1.5">
              <div className="text-amber">{confirm.message}</div>
              <div className="mt-1.5 flex gap-2">
                <button
                  onClick={() => {
                    const c = confirm
                    setConfirm(null)
                    void apply(c.entry, true)
                  }}
                  className="rounded bg-amber px-2 py-0.5 text-[11px] font-semibold text-void"
                >
                  confirmar ⏎
                </button>
                <button onClick={() => setConfirm(null)} className="rounded border border-edge2 px-2 py-0.5 text-[11px] text-dim">
                  cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* lista */}
      <div ref={list} id={listId} role="listbox" aria-label="modelos" className="min-h-0 flex-1 overflow-y-auto py-1">
        {!opts && !error && (
          <div className="space-y-1.5 px-3 py-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="hc-shimmer h-4 rounded" style={{ width: `${70 - i * 12}%` }} />
            ))}
          </div>
        )}
        {opts && flat.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-faint">{query ? `nada para "${query}"` : 'nenhum modelo disponível'}</div>
        )}
        {groups.map((g) => (
          <div key={g.provider.slug} className="pb-1">
            <div className="sticky top-0 z-[1] flex items-center gap-2 bg-panel/95 px-3 py-1 backdrop-blur-sm">
              <span className="label text-dim">{g.provider.name || g.provider.slug}</span>
              <Badge tone={g.local ? 'phos' : 'cyan'}>{g.local ? 'local' : 'cloud'}</Badge>
              {g.provider.free_tier && <Badge tone="phos">free tier</Badge>}
              {g.provider.warning && <span className="truncate text-[10.5px] text-warn" title={g.provider.warning}>{g.provider.warning}</span>}
              <span className="ml-auto text-[10px] text-faint">
                {g.entries.length}
                {g.provider.total_models && g.provider.total_models > g.provider.models.length ? `/${g.provider.total_models}` : ''}
              </span>
            </div>
            {g.entries.map((e) => {
              idx++
              const i = idx
              const caps = g.provider.capabilities?.[e.model]
              const price = g.provider.pricing?.[e.model]
              const active = i === sel
              return (
                <button
                  key={e.key}
                  data-idx={i}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={active}
                  aria-disabled={e.unavailable || undefined}
                  tabIndex={-1}
                  disabled={busy !== null || e.unavailable}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => void apply(e)}
                  className={`flex w-full min-w-0 items-center gap-2 px-3 py-[3px] text-left text-[12px] transition-colors ${e.unavailable ? 'disabled:cursor-not-allowed' : 'disabled:cursor-wait'} ${
                    active ? 'bg-sel' : ''
                  } ${e.current ? 'text-amber' : e.unavailable ? 'text-faint' : 'text-ink'}`}
                >
                  <span className={`w-2 shrink-0 text-center text-[10px] ${active ? 'text-amber' : 'text-transparent'}`}>›</span>
                  <span className="min-w-0 truncate">{e.model}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {busy === e.key && <span className="text-faint">…</span>}
                    {e.current && <Badge tone="amber">atual</Badge>}
                    {e.fallbackIdx >= 0 && <Badge tone="cyan">fallback{fallback.length > 1 ? ` ${e.fallbackIdx + 1}` : ''}</Badge>}
                    {e.unavailable && <Badge tone="dim">indisponível</Badge>}
                    {caps?.reasoning && <Badge tone="dim">raciocínio</Badge>}
                    {caps?.fast && <Badge tone="dim">rápido</Badge>}
                    {price?.free ? (
                      <Badge tone="phos">grátis</Badge>
                    ) : price?.input || price?.output ? (
                      <span className="text-[10px] text-faint" title="preço de entrada / saída informado pelo provider">
                        {price.input ?? '?'} / {price.output ?? '?'}
                      </span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 border-t border-edge px-3 py-1 text-[10px] text-faint">
        <span>↑↓ navegar</span>
        <span>⏎ aplicar</span>
        <span>tab escopo</span>
        <span>esc fechar</span>
        <span className="ml-auto">{flat.length} modelos</span>
      </div>
    </div>
  )
}

function Badge({ tone, children }: { tone: 'amber' | 'cyan' | 'phos' | 'dim'; children: ReactNode }) {
  const cls = {
    amber: 'border-amber/50 text-amber',
    cyan: 'border-cyanic/40 text-cyanic',
    phos: 'border-phos/40 text-phos',
    dim: 'border-edge2 text-faint',
  }[tone]
  return <span className={`rounded border px-1 py-px text-[9.5px] uppercase leading-none tracking-[0.06em] ${cls}`}>{children}</span>
}
