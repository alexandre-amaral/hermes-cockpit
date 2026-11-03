import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { fmtRunTokens } from '../../lib/swarm-tokens'
import { STATUS_LABEL, errMsg, fmtDuration, isActive, runElapsedMs, useNow, useSwarm, type RunMeta } from '../../lib/swarm'
import { invoke } from '../../lib/ipc'
import { toast } from '../../lib/toast'
import { requestTerminal } from '../devtools/TerminalTab'
import type { ChatItem } from '../../lib/chat-store'
import { CodeBlock, Markdown } from './Markdown'

interface Props {
  items: ChatItem[]
  verbose: boolean
  running: boolean
  status: string
  /** nome humano do bot (monograma/avatar das respostas) */
  botName?: string
  /** itens com índice ≥ baseline chegaram depois do load → animam a entrada */
  baseline?: number
  /** cards extras no fim do transcript (aprovações) */
  footer?: ReactNode
  empty?: ReactNode
}

export function Transcript({ items, verbose, running, status, botName, baseline = 0, footer, empty }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const lastCount = useRef(items.length)

  // auto-scroll enquanto o usuário estiver no fim; conta novidades quando não está
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (stick.current) el.scrollTop = el.scrollHeight
    else if (items.length > lastCount.current) setUnseen((n) => n + (items.length - lastCount.current))
    lastCount.current = items.length
  })

  // troca de sessão (lista encolhe/zera): volta a grudar no fim
  useEffect(() => {
    if (items.length <= baseline) {
      stick.current = true
      setAtBottom(true)
      setUnseen(0)
    }
  }, [baseline, items.length])

  const toBottom = () => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    setAtBottom(true)
    setUnseen(0)
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }

  const groups = groupItems(items)
  const monogram = (botName || '?').trim().charAt(0).toUpperCase() || '?'

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          stick.current = bottom
          if (bottom !== atBottom) setAtBottom(bottom)
          if (bottom) setUnseen(0)
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
      >
        {items.length === 0 && !running && !footer && empty}
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-3.5">
          {groups.map((g, gi) => {
            const first = g.kind === 'tools' ? g.tools[0] : g.item
            const prev = gi > 0 ? lastOf(groups[gi - 1]) : null
            const sep = first.ts && (!prev?.ts || dayKey(prev.ts) !== dayKey(first.ts)) ? <DaySep key={`d-${first.id}`} ts={first.ts} /> : null
            const fresh = g.index >= baseline
            const node =
              g.kind === 'tools' ? (
                <ToolGroup key={g.id} tools={g.tools} verbose={verbose} fresh={fresh} />
              ) : (
                <Row key={g.item.id} item={g.item} verbose={verbose} fresh={fresh} monogram={monogram} botName={botName} />
              )
            return sep ? [sep, node] : node
          })}
          {running && <TurnIndicator status={status} monogram={monogram} />}
          {footer}
        </div>
      </div>
      {!atBottom && (
        <button
          onClick={toBottom}
          className="hc-glass hc-rise absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-edge2 px-3 py-1 text-[11px] text-ink shadow-lg transition-[border-color,transform] duration-150 hover:-translate-y-px hover:border-amber/60"
        >
          <BounceArrow active={unseen > 0 || running} />
          <span className="label tracking-[0.12em] text-ink/90">voltar ao fim</span>
          {unseen > 0 && <span className="rounded-full bg-amber px-1.5 text-[10px] font-semibold text-void">{unseen}</span>}
        </button>
      )}
    </div>
  )
}

// ── agrupamento / datas ──────────────────────────────────────────────────────

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type Group = { kind: 'tools'; id: string; tools: ToolItem[]; index: number } | { kind: 'one'; item: ChatItem; index: number }

// tool calls consecutivas viram um bloco único (como no wireframe)
function groupItems(items: ChatItem[]): Group[] {
  const out: Group[] = []
  items.forEach((it, index) => {
    const last = out.at(-1)
    if (it.kind === 'tool') {
      if (last?.kind === 'tools') last.tools.push(it)
      else out.push({ kind: 'tools', id: `g-${it.id}`, tools: [it], index })
    } else out.push({ kind: 'one', item: it, index })
  })
  return out
}

function lastOf(g: Group): ChatItem {
  return g.kind === 'tools' ? g.tools[g.tools.length - 1] : g.item
}

function dayKey(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (dayKey(ts) === dayKey(today.getTime() / 1000)) return 'Hoje'
  if (dayKey(ts) === dayKey(y.getTime() / 1000)) return 'Ontem'
  return d.toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  })
}

function timeOf(ts?: number): string {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function fullTime(ts?: number): string | undefined {
  if (!ts) return undefined
  return new Date(ts * 1000).toLocaleString('pt-BR')
}

function DaySep({ ts }: { ts: number }) {
  return (
    <div className="sticky top-0 z-[5] -mx-1 flex items-center gap-3 py-1.5" role="separator">
      <span className="h-px flex-1 bg-gradient-to-r from-transparent to-edge2" />
      <span className="hc-glass rounded-full border border-edge px-2.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-dim">
        {dayLabel(ts)}
      </span>
      <span className="h-px flex-1 bg-gradient-to-l from-transparent to-edge2" />
    </div>
  )
}

function Stamp({ ts, side }: { ts?: number; side: 'left' | 'right' }) {
  if (!ts) return null
  return (
    <span
      title={fullTime(ts)}
      className={`pointer-events-none shrink-0 self-end pb-0.5 text-[10px] text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 ${
        side === 'left' ? 'order-first' : ''
      }`}
    >
      {timeOf(ts)}
    </span>
  )
}

// ── linhas ───────────────────────────────────────────────────────────────────

function Row({
  item,
  verbose,
  fresh,
  monogram,
  botName,
}: {
  item: ChatItem
  verbose: boolean
  fresh: boolean
  monogram: string
  botName?: string
}) {
  const anim = fresh ? 'hc-rise' : ''
  switch (item.kind) {
    case 'user':
      return (
        <div className={`group flex justify-end gap-2 ${anim}`}>
          <Stamp ts={item.ts} side="left" />
          <div className="max-w-[min(78%,62ch)] whitespace-pre-wrap break-words rounded-xl rounded-br-sm border border-edge2 bg-panel2 px-3.5 py-2 text-[13.5px] leading-[1.6] text-ink shadow-[var(--hc-shadow-1)]">
            {item.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className={`group flex gap-2.5 ${anim}`}>
          <div
            title={botName}
            className={`mt-0.5 flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-md border text-[11px] font-semibold ${
              item.streaming ? 'border-amber/60 text-amber hc-glow-amber' : 'border-edge2 text-dim'
            } bg-panel`}
          >
            {monogram}
          </div>
          <div className="min-w-0 max-w-[72ch] flex-1">
            {item.reasoning && <Reasoning text={item.reasoning} live={item.streaming && !item.text} verbose={verbose} />}
            {(item.text || item.streaming) && (
              <div className="break-words text-[13.5px] leading-[1.68] text-ink/95">
                <Markdown text={item.text} />
                {item.streaming && (item.text ? <StreamCursor /> : <TypingDots />)}
              </div>
            )}
          </div>
          <Stamp ts={item.ts} side="right" />
        </div>
      )
    case 'note': {
      const cls =
        item.tone === 'error'
          ? 'border-alert/40 text-alert'
          : item.tone === 'warn'
            ? 'border-amber/40 text-amber'
            : 'border-edge text-dim'
      return (
        <div className={`group flex gap-2 ${anim}`}>
          <div className={`flex-1 rounded border px-3 py-1.5 text-[12px] ${cls}`}>{item.text}</div>
          <Stamp ts={item.ts} side="right" />
        </div>
      )
    }
    case 'slash':
      return (
        <div className={`rounded border border-edge bg-panel px-3 py-2 ${anim}`}>
          <div className="label mb-1 text-cyanic">{item.command}</div>
          {item.warning && <div className="mb-1 text-[11.5px] text-amber">{item.warning}</div>}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-[12px] text-dim">{item.output || '(sem saída)'}</pre>
        </div>
      )
    default:
      return null
  }
}

/** Cursor de streaming: fade contínuo via Web Animations API (sem CSS novo). */
function StreamCursor() {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    // WAAPI ignora o bloco CSS de prefers-reduced-motion: cursor fica estático.
    if (!el || typeof el.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const a = el.animate([{ opacity: 1 }, { opacity: 0.15 }], {
      duration: 650,
      iterations: Infinity,
      direction: 'alternate',
      easing: 'ease-in-out',
    })
    return () => a.cancel()
  }, [])
  return <span ref={ref} className="ml-0.5 inline-block h-[1.05em] w-[0.5em] rounded-[1px] bg-amber align-[-0.15em]" />
}

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

/** Raciocínio sempre colapsado (abre sozinho só no verbose enquanto pensa). */
function Reasoning({ text, live, verbose }: { text: string; live: boolean; verbose: boolean }) {
  const [open, setOpen] = useState(verbose && live)
  useEffect(() => {
    if (verbose && live) setOpen(true)
  }, [verbose, live])
  const words = text.trim().split(/\s+/).length
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded px-1 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-faint transition-colors hover:text-dim"
      >
        <span className={`inline-block transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>▸</span>
        {live ? <span className="hc-shimmer rounded px-1 text-dim">pensando…</span> : <span>raciocínio</span>}
        <span className="normal-case tracking-normal text-faint/70">· {words} palavras</span>
      </button>
      {open && (
        <div className="hc-fade-in mt-1 max-h-72 overflow-auto whitespace-pre-wrap border-l border-edge2 pl-3 text-[12px] leading-relaxed text-faint">
          {text}
        </div>
      )}
    </div>
  )
}

/** Três pontos em onda (WAAPI) — indicador de "digitando" antes do 1º token. */
function TypingDots({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion()) return
    const anims = Array.from(el.children).map((c, i) =>
      (c as HTMLElement).animate(
        [
          { transform: 'translateY(0)', opacity: 0.35 },
          { transform: 'translateY(-3px)', opacity: 1 },
          { transform: 'translateY(0)', opacity: 0.35 },
        ],
        { duration: 900, iterations: Infinity, delay: i * 140, easing: 'ease-in-out' },
      ),
    )
    return () => anims.forEach((a) => a.cancel())
  }, [])
  return (
    <span ref={ref} aria-label="digitando" className={`inline-flex items-end gap-[3px] align-middle ${className}`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className="inline-block h-[5px] w-[5px] rounded-full bg-amber opacity-40" />
      ))}
    </span>
  )
}

function BounceArrow({ active }: { active: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !active || reducedMotion()) return
    const a = el.animate([{ transform: 'translateY(-1px)' }, { transform: 'translateY(2px)' }, { transform: 'translateY(-1px)' }], {
      duration: 1100,
      iterations: Infinity,
      easing: 'ease-in-out',
    })
    return () => a.cancel()
  }, [active])
  return (
    <span ref={ref} className="inline-block text-amber">
      ↓
    </span>
  )
}

// ── tool calls ───────────────────────────────────────────────────────────────

/** Ações do turno: 1 ferramenta = card direto; várias = card "N ações" com timeline.
 *  Abre sozinho enquanto alguma roda ou se tem delegação ao Claude Code. */
function ToolGroup({ tools, verbose, fresh }: { tools: ToolItem[]; verbose: boolean; fresh: boolean }) {
  const runningN = tools.filter((t) => t.status === 'running').length
  const failedN = tools.filter((t) => t.status !== 'running' && looksFailed(t)).length
  const delegated = tools.some((t) => DELEGATION_RE.test(t.name))
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? (verbose || runningN > 0 || delegated)
  if (tools.length === 1)
    return (
      <div className={`ml-8 ${fresh ? 'hc-rise' : ''}`}>
        <ToolCard tool={tools[0]} verbose={verbose} />
      </div>
    )
  const total = tools.reduce((acc, t) => acc + (t.duration ?? 0), 0)
  const names = [...new Set(tools.map((t) => t.name))]
  const current = [...tools].reverse().find((t) => t.status === 'running')
  return (
    <div className={`ml-8 overflow-hidden rounded-lg border bg-panel/50 ${runningN ? 'border-amber/35' : failedN ? 'border-alert/30' : 'border-edge'} ${fresh ? 'hc-rise' : ''}`}>
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] hover:bg-hover/70"
      >
        <span className={`inline-block w-3 text-faint transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>▸</span>
        <span className={`label tracking-[0.14em] ${runningN ? 'text-amber' : 'text-ink/85'}`}>{tools.length} ações</span>
        <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
          {tools.slice(0, 14).map((t) => (
            <span
              key={t.id}
              className={`h-1.5 w-1.5 rounded-full ${t.status === 'running' ? 'hc-pulse-dot bg-amber' : looksFailed(t) ? 'bg-alert' : 'bg-phos/70'}`}
            />
          ))}
        </span>
        <span className="min-w-0 truncate text-faint">
          {current ? `${current.name}${current.context ? ` · ${current.context}` : ''}` : names.slice(0, 4).join(' · ')}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[10.5px] text-faint">
          {failedN > 0 && <span className="text-alert">{failedN} falha(s)</span>}
          {total > 0 && <span className="tabular-nums">{fmtDur(total)}</span>}
          {runningN ? <span className="hc-pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" /> : <span className={failedN ? 'text-alert' : 'text-phos'}>{failedN ? '!' : '✓'}</span>}
        </span>
      </button>
      {open && (
        <ol className="hc-fade-in relative border-t border-edge/60 py-1.5 pl-5 pr-2">
          <span className="absolute bottom-3 left-[13px] top-3 w-px bg-edge2" aria-hidden />
          {tools.map((t) => (
            <li key={t.id} className="relative py-0.5 pl-3">
              <span
                aria-hidden
                className={`absolute left-[-10px] top-[11px] h-[7px] w-[7px] rounded-full border ${
                  t.status === 'running' ? 'hc-pulse-dot border-amber bg-amber' : looksFailed(t) ? 'border-alert bg-alert/70' : 'border-phos/60 bg-void'
                }`}
              />
              <ToolCard tool={t} verbose={verbose} />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

const DELEGATION_RE = /claude_(spawn|spawn_many|send)/

function toolIcon(name: string): string {
  const n = name.toLowerCase()
  if (/terminal|shell|bash|exec|command|process/.test(n)) return '›_'
  if (/patch|edit|write|replace|create_file|apply/.test(n)) return '✎'
  if (/read|file|cat|view|open/.test(n)) return '▤'
  if (/search|grep|find|glob|web|fetch|browse|url/.test(n)) return '⌕'
  if (/delegate|agent|spawn|subagent|claude/.test(n)) return '⇢'
  if (/todo|plan|task/.test(n)) return '☐'
  if (/memory|remember|recall/.test(n)) return '◈'
  if (/image|vision|screenshot|camera/.test(n)) return '◩'
  if (/mcp/.test(n)) return '⧉'
  return '⚙'
}

function looksFailed(t: ToolItem): boolean {
  const s = `${t.summary}\n${t.result}`.trim().slice(0, 400)
  return /^(error|erro|failed|falh|traceback|exception)/i.test(s) || /"success"\s*:\s*false|"error"\s*:\s*"[^"]/.test(s)
}

function useElapsed(startedMs: number | undefined, on: boolean): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on || !startedMs) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [on, startedMs])
  return on && startedMs ? Math.max(0, (now - startedMs) / 1000) : null
}

function fmtDur(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)}ms`
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
}

function ToolCard({ tool, verbose }: { tool: ToolItem; verbose: boolean }) {
  const [open, setOpen] = useState(false)
  const running = tool.status === 'running'
  const failed = !running && looksFailed(tool)
  const elapsed = useElapsed(tool.startedMs, running)
  const hasArgs = Boolean(tool.args && Object.keys(tool.args).length)
  const hasDetail = hasArgs || Boolean(tool.summary || tool.result)
  const dur = tool.duration ?? elapsed
  const tone = running ? 'border-amber/40' : failed ? 'border-alert/40' : 'border-edge'

  return (
    <div className={`overflow-hidden rounded-md border bg-panel/60 font-mono text-[11.5px] ${tone}`}>
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left ${hasDetail ? 'cursor-pointer hover:bg-hover' : 'cursor-default'}`}
      >
        <span className={`w-4 shrink-0 text-center ${running ? 'text-amber' : failed ? 'text-alert' : 'text-dim'}`}>{toolIcon(tool.name)}</span>
        <span className={`shrink-0 ${running ? 'text-amber' : 'text-ink/90'}`}>{tool.name}</span>
        {tool.context && <span className="min-w-0 truncate text-faint">{tool.context}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {dur !== null && <span className="text-[10.5px] text-faint">{fmtDur(dur)}</span>}
          {running ? (
            <span className="hc-pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" title="executando" />
          ) : failed ? (
            <span className="text-alert" title="falhou">✕</span>
          ) : (
            <span className="text-phos" title="concluída">✓</span>
          )}
          {hasDetail && <span className="text-faint">{open ? '▾' : '▸'}</span>}
        </span>
      </button>
      {DELEGATION_RE.test(tool.name) && <DelegationStrip tool={tool} />}
      {!open && verbose && tool.summary && <div className="truncate border-t border-edge/60 px-2.5 py-0.5 pl-8 text-faint">{tool.summary}</div>}
      {open && (
        <div className="hc-fade-in space-y-1.5 border-t border-edge/60 px-2.5 py-2">
          {hasArgs && (
            <div>
              <div className="label mb-0.5 text-[9px]">entrada</div>
              <CodeBlock lang="json" code={safeJson(tool.args)} />
            </div>
          )}
          {tool.summary && <div className="text-dim">{tool.summary}</div>}
          {tool.result && (
            <div>
              <div className="label mb-0.5 text-[9px]">saída</div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-void px-2 py-1 text-faint">
                {tool.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TurnIndicator({ status, monogram }: { status: string; monogram: string }) {
  return (
    <div className="hc-fade-in flex items-center gap-2.5 text-[11.5px]" role="status" aria-live="polite">
      <span className="flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-md border border-amber/50 bg-panel text-[11px] font-semibold text-amber hc-glow-amber">
        {monogram}
      </span>
      <span className="flex min-w-0 items-center gap-2 rounded-full border border-edge bg-panel/60 px-2.5 py-1">
        <TypingDots />
        <span className="label tracking-[0.14em] text-amber">trabalhando</span>
        {status && <span className="min-w-0 truncate text-dim">· {status}</span>}
      </span>
    </div>
  )
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

const RUN_ID_RE = /r-\d{8}-\d{6}-[0-9a-f]{4}/g

/** Delegação ao Claude Code vista do chat: instâncias criadas pelo bot, ao vivo. */
function DelegationStrip({ tool }: { tool: ToolItem }) {
  const ids = useMemo(() => [...new Set(`${tool.result ?? ''} ${tool.summary ?? ''}`.match(RUN_ID_RE) ?? [])], [tool.result, tool.summary])
  const s = useSwarm()
  const runs = ids.map((id) => s.runs.find((r) => r.id === id)).filter((r): r is RunMeta => Boolean(r))
  const anyActive = runs.some((r) => isActive(r.status))
  const now = useNow(1000, anyActive)
  const withTok = runs.filter((r) => r.tokensTotal != null)
  const totalTokens = withTok.length ? withTok.reduce((acc, r) => acc + (r.tokensTotal ?? 0), 0) : null
  if (!ids.length) return null
  return (
    <div className="hc-fade-in border-t border-edge/60 bg-void/40 px-2.5 py-1.5">
      <div className="mb-1 flex items-center gap-2 text-[10px]">
        <span className={`h-1.5 w-1.5 rotate-45 ${anyActive ? 'hc-pulse-dot bg-phos' : 'bg-faint'}`} />
        <span className="label text-[9.5px]">delegado ao Claude Code · {ids.length} instância(s)</span>
        {totalTokens != null && <span className="tabular-nums text-faint">{fmtRunTokens(totalTokens)}</span>}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('hc:view', { detail: 'swarm' }))}
          className="ml-auto rounded border border-edge2 px-1.5 text-[10px] text-dim hover:border-phos/60 hover:text-phos"
        >
          ver árvore ↗
        </button>
      </div>
      {ids.map((id) => {
        const r = runs.find((x) => x.id === id)
        return <DelegationRow key={id} id={id} run={r} now={now} />
      })}
    </div>
  )
}

/** Fase da run → preenchimento da mini barra (sem total conhecido: fila 8%, rodando
 *  indeterminado, aguardando 60%, fim 100%). */
function DelegationRow({ id, run: r, now }: { id: string; run: RunMeta | undefined; now: number }) {
  const active = r ? isActive(r.status) : false
  const tone = !r ? 'bg-faint' : r.status === 'done' ? 'bg-phos' : r.status === 'error' ? 'bg-alert' : r.status === 'cancelled' ? 'bg-faint' : r.status === 'waiting_approval' ? 'bg-warn' : 'bg-phos'
  const pct = !r ? 0 : r.status === 'queued' ? 8 : r.status === 'waiting_approval' ? 60 : 100
  const openHere = (mode: 'watch' | 'resume') => {
    invoke<{ cwd: string; cmd: string; title: string }>('swarm:terminalCommand', id, mode)
      .then((t) => requestTerminal(t))
      .catch((e: unknown) => toast({ title: 'Não abriu no app', detail: errMsg(e), tone: 'error' }))
  }
  return (
    <div className="group/run flex min-w-0 flex-col gap-1 py-1 text-[10.5px]">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? `hc-pulse-dot ${tone}` : tone}`} />
        <span className="min-w-0 flex-1 truncate text-ink/90" title={r?.task || id}>
          {r?.title ?? id}
        </span>
        {r?.repo && <span className="hidden shrink-0 truncate text-faint sm:inline">{r.repo.split('/').filter(Boolean).at(-1)}</span>}
        {r && <span className={`shrink-0 ${r.status === 'error' ? 'text-alert' : r.status === 'waiting_approval' ? 'text-warn' : 'text-faint'}`}>{STATUS_LABEL[r.status]}</span>}
        {r?.numTurns != null && <span className="shrink-0 tabular-nums text-faint">{r.numTurns}t</span>}
        {r && <span className="shrink-0 tabular-nums text-faint">{fmtDuration(runElapsedMs(r, now))}</span>}
        {r?.tokensTotal != null && <span className="shrink-0 tabular-nums text-dim">{fmtRunTokens(r.tokensTotal)}</span>}
        <button
          type="button"
          onClick={() => openHere(active ? 'watch' : 'resume')}
          title={active ? 'acompanhar no terminal do cockpit' : 'retomar a sessão do Claude Code no terminal do cockpit'}
          className="shrink-0 rounded border border-edge2 px-1.5 text-[10px] text-dim opacity-70 transition-opacity hover:border-phos/60 hover:text-phos group-hover/run:opacity-100"
        >
          abrir aqui
        </button>
      </div>
      <span className="relative ml-3.5 block h-[3px] overflow-hidden rounded-full bg-edge" aria-hidden>
        {r && (
          <span
            className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${tone} ${r.status === 'running' ? 'hc-shimmer opacity-80' : 'opacity-70'}`}
            style={{ width: `${pct}%` }}
          />
        )}
      </span>
    </div>
  )
}
