import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fmtDuration, type SwarmEventLine } from '../../lib/swarm'
import { fmtRunTokens, resultTokens } from '../../lib/swarm-tokens'
import { Markdown } from '../chat/Markdown'
import { prettyJson, SkeletonRows, summarizeInput } from './ui'

// Renderiza o stream-json do Claude Code (`claude -p --output-format stream-json`):
// system/init, assistant (text, thinking, tool_use), user (tool_result) e result.
// Linhas desconhecidas aparecem como linha discreta com o tipo — nunca somem caladas.

type Block = Record<string, unknown>

type Item =
  | { k: 'init'; key: string; model?: string; cwd?: string; tools?: number; session?: string }
  | { k: 'text'; key: string; text: string }
  | { k: 'thinking'; key: string; text: string }
  | { k: 'tool'; key: string; id?: string; name: string; input: unknown; result?: { text: string; isError: boolean } }
  | { k: 'user'; key: string; text: string }
  | {
      k: 'result'
      key: string
      ok: boolean
      subtype?: string
      tokens?: number
      turns?: number
      durationMs?: number
      text?: string
    }
  | { k: 'task'; key: string; taskId: string; text: string; kind?: string; tokens?: number; tools?: number; durationMs?: number; done?: boolean }
  | { k: 'other'; key: string; label: string; raw: unknown }

function asArr(v: unknown): Block[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Block[]) : []
}

function resultText(c: unknown): string {
  if (typeof c === 'string') return c
  return asArr(c)
    .map((b) => (typeof b.text === 'string' ? b.text : b.type === 'image' ? '[imagem]' : ''))
    .filter(Boolean)
    .join('\n')
}

export function buildItems(lines: SwarmEventLine[]): Item[] {
  const out: Item[] = []
  const toolById = new Map<string, Extract<Item, { k: 'tool' }>>()
  lines.forEach((line, i) => {
    const ev = line.ev as Block | null
    if (!ev || typeof ev !== 'object') {
      out.push({ k: 'other', key: `o${i}`, label: 'linha', raw: line.ev })
      return
    }
    const type = String(ev.type ?? '')
    if (type === 'system') {
      if (ev.subtype === 'init') {
        out.push({
          k: 'init',
          key: `i${i}`,
          model: typeof ev.model === 'string' ? ev.model : undefined,
          cwd: typeof ev.cwd === 'string' ? ev.cwd : undefined,
          tools: Array.isArray(ev.tools) ? ev.tools.length : undefined,
          session: typeof ev.session_id === 'string' ? ev.session_id : undefined,
        })
      } else if (ev.subtype === 'task_started' || ev.subtype === 'task_progress' || ev.subtype === 'task_notification') {
        // Workflow/subagentes em background do Claude Code: uma linha por fase,
        // progresso consecutivo da mesma fase atualiza a linha em vez de repetir.
        const taskId = String(ev.task_id ?? '')
        const usage = (ev.usage ?? {}) as Record<string, unknown>
        const text =
          ev.subtype === 'task_started'
            ? `${ev.task_type === 'local_workflow' ? 'workflow' : 'tarefa'} ${String(ev.workflow_name ?? '')} iniciado — ${String(ev.description ?? '')}`
            : String(ev.description ?? ev.summary ?? 'progresso')
        const item = {
          k: 'task' as const,
          key: `k${i}`,
          taskId,
          text,
          kind: typeof ev.task_type === 'string' ? ev.task_type : undefined,
          tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
          tools: typeof usage.tool_uses === 'number' ? usage.tool_uses : undefined,
          durationMs: typeof usage.duration_ms === 'number' ? usage.duration_ms : undefined,
          done: ev.subtype === 'task_notification',
        }
        const last = out[out.length - 1]
        if (last && last.k === 'task' && last.taskId === taskId && last.text === text) out[out.length - 1] = { ...item, key: last.key }
        else out.push(item)
      } else out.push({ k: 'other', key: `s${i}`, label: `system · ${String(ev.subtype ?? '')}`, raw: ev })
      return
    }
    if (type === 'assistant' || type === 'user') {
      const msg = (ev.message ?? {}) as Block
      const content = msg.content
      if (typeof content === 'string') {
        if (content.trim()) out.push({ k: type === 'assistant' ? 'text' : 'user', key: `t${i}`, text: content })
        return
      }
      asArr(content).forEach((b, j) => {
        const key = `${i}.${j}`
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ k: type === 'assistant' ? 'text' : 'user', key, text: b.text })
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          out.push({ k: 'thinking', key, text: b.thinking })
        } else if (b.type === 'tool_use') {
          const it: Extract<Item, { k: 'tool' }> = {
            k: 'tool',
            key,
            id: typeof b.id === 'string' ? b.id : undefined,
            name: String(b.name ?? 'tool'),
            input: b.input,
          }
          if (it.id) toolById.set(it.id, it)
          out.push(it)
        } else if (b.type === 'tool_result') {
          const res = { text: resultText(b.content), isError: b.is_error === true }
          const target = typeof b.tool_use_id === 'string' ? toolById.get(b.tool_use_id) : undefined
          if (target) target.result = res
          else out.push({ k: 'tool', key, name: 'resultado', input: null, result: res })
        }
      })
      return
    }
    if (type === 'result') {
      out.push({
        k: 'result',
        key: `r${i}`,
        ok: ev.is_error !== true && (ev.subtype === undefined || ev.subtype === 'success'),
        subtype: typeof ev.subtype === 'string' ? ev.subtype : undefined,
        tokens: resultTokens(ev),
        turns: typeof ev.num_turns === 'number' ? ev.num_turns : undefined,
        durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : undefined,
        text: typeof ev.result === 'string' ? ev.result : undefined,
      })
      return
    }
    if (type === 'stream_event' || type === 'rate_limit_event') return // parciais/ruído
    out.push({ k: 'other', key: `x${i}`, label: type || 'evento', raw: ev })
  })
  return out
}

function ToolRow({ it, compact }: { it: Extract<Item, { k: 'tool' }>; compact: boolean }) {
  const [open, setOpen] = useState(false)
  const summary = summarizeInput(it.name, it.input)
  const pending = !it.result
  const err = it.result?.isError
  return (
    <div className="hc-rise group">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-baseline gap-2 text-left"
      >
        <span className={`shrink-0 ${err ? 'text-alert' : pending ? 'text-warn' : 'text-faint'}`}>
          {err ? '✕' : pending ? '→' : '✓'}
        </span>
        <span className="shrink-0 text-cyanic">{it.name}</span>
        <span className="min-w-0 truncate text-dim">{summary}</span>
        {it.result && (
          <span className="ml-auto shrink-0 text-[10px] text-faint opacity-0 transition-opacity group-hover:opacity-100">
            {open ? 'ocultar' : 'ver'}
          </span>
        )}
      </button>
      {open && (
        <div className="hc-fade-in mt-1 ml-4 space-y-1">
          {it.input != null && !compact && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-void px-2 py-1.5 text-[11px] text-dim">
              {prettyJson(it.input)}
            </pre>
          )}
          {it.result && (
            <pre
              className={`max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border bg-void px-2 py-1.5 text-[11px] ${
                err ? 'border-alert/40 text-alert/90' : 'border-edge text-ink/80'
              }`}
            >
              {it.result.text || '(vazio)'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="hc-rise">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-[11px] italic text-faint hover:text-dim">
        {open ? '▾' : '▸'} raciocínio
      </button>
      {open && <p className="mt-1 ml-4 whitespace-pre-wrap text-[11px] italic text-faint">{text}</p>}
    </div>
  )
}

const ItemView = memo(function ItemView({ it, compact }: { it: Item; compact: boolean }) {
  switch (it.k) {
    case 'init':
      return (
        <div className="hc-fade-in label flex flex-wrap gap-x-3 !tracking-[0.12em]">
          <span>sessão iniciada</span>
          {it.model && <span className="text-dim">{it.model}</span>}
          {it.tools != null && <span>{it.tools} ferramentas</span>}
        </div>
      )
    case 'text':
      return (
        <div className={`hc-rise text-ink ${compact ? 'text-[11.5px]' : 'text-[12.5px]'}`}>
          <Markdown text={it.text} />
        </div>
      )
    case 'thinking':
      return compact ? null : <ThinkingRow text={it.text} />
    case 'tool':
      return <ToolRow it={it} compact={compact} />
    case 'user':
      return (
        <div className="hc-rise ml-auto max-w-[85%] rounded-md border border-edge2 bg-panel2 px-3 py-1.5 text-[12px] text-ink">
          {it.text}
        </div>
      )
    case 'result':
      return (
        <div
          className={`hc-rise rounded-md border px-3 py-2 ${it.ok ? 'border-phos/30 bg-phos/[0.04]' : 'border-alert/40 bg-alert/[0.05]'}`}
        >
          <div className="flex flex-wrap items-baseline gap-x-3 text-[11px]">
            <span className={it.ok ? 'text-phos' : 'text-alert'}>{it.ok ? '● resultado' : `● ${it.subtype ?? 'erro'}`}</span>
            {it.tokens != null && <span className="text-dim">{fmtRunTokens(it.tokens)}</span>}
            {it.turns != null && <span className="text-faint">{it.turns} turnos</span>}
            {it.durationMs != null && <span className="text-faint">{fmtDuration(it.durationMs)}</span>}
          </div>
          {it.text && !compact && (
            <div className="mt-1.5 text-[12px] text-ink/90">
              <Markdown text={it.text} />
            </div>
          )}
        </div>
      )
    case 'task':
      return (
        <div className="hc-fade-in flex items-center gap-2 rounded border border-cyanic/30 bg-cyanic/5 px-2 py-1 text-[11px]">
          <span className={it.done ? 'text-phos' : 'hc-pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-cyanic'}>{it.done ? '✓' : ''}</span>
          <span className="min-w-0 flex-1 truncate text-cyanic">{it.text}</span>
          {it.tools != null && <span className="shrink-0 text-faint">{it.tools} tools</span>}
          {it.tokens != null && <span className="shrink-0 text-faint">{Math.round(it.tokens / 1000)}k tok</span>}
          {it.durationMs != null && <span className="shrink-0 tabular-nums text-faint">{fmtDuration(it.durationMs)}</span>}
        </div>
      )
    default:
      return (
        <div className="text-[10.5px] text-faint" title={prettyJson(it.raw).slice(0, 2000)}>
          · {it.label}
        </div>
      )
  }
})

/** Stream com auto-scroll que só "gruda" no fim se o usuário já estava lá. */
export function RunStream({
  lines,
  loading,
  error,
  compact = false,
  live = false,
}: {
  lines: SwarmEventLine[]
  loading: boolean
  error?: string
  compact?: boolean
  live?: boolean
}) {
  const items = useMemo(() => buildItems(lines), [lines])
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items.length, lines.length])

  useEffect(() => {
    stick.current = true
  }, [])

  const shown = compact ? items.slice(-40) : items

  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}
      className={`min-h-0 flex-1 overflow-y-auto ${compact ? 'space-y-1.5 px-3 py-2 text-[11px]' : 'space-y-2.5 px-5 py-4 text-[12px]'}`}
    >
      {loading && !lines.length ? (
        <SkeletonRows n={compact ? 2 : 4} />
      ) : !items.length ? (
        <div className="text-[11px] text-faint">{live ? 'aguardando o primeiro evento…' : 'sem eventos registrados'}</div>
      ) : (
        shown.map((it) => <ItemView key={it.key} it={it} compact={compact} />)
      )}
      {live && items.length > 0 && (
        <div className="flex items-center gap-2 pt-1 text-[10px] text-faint">
          <span className="hc-pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-phos" /> ao vivo
        </div>
      )}
      {error && <div className="text-[11px] text-alert">eventos: {error}</div>}
    </div>
  )
}
