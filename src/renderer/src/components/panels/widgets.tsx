import { fmtUptime, ops, type SystemInfo } from '../../lib/ops'
import { HOST_LABEL } from '../../lib/platform'
import { agendaPath, inSpace, spaceOfAccount, useSpace, type Space } from '../../lib/space'
import { mainGpu, systemCards } from '../../lib/system-cards'
import { useAsync } from '../ops/ui'
import { RadialStat } from '../ui/RadialMeter'
import { PanelFrame } from './PanelFrame'
import { usePluginSource } from './source'
import {
  API,
  calendarColor,
  type Agenda,
  type AgendaEvent,
  type Foco,
  type Inbox,
  type InboxItem,
  type Notion,
  type NotionTask,
  type Sistema,
} from './types'

// Widgets dos painéis. A maioria lê uma rota do plugin cockpit (polling
// compartilhado em source.tsx); o de Sistema lê a coleta local do main
// (ops:system). Cada um mostra erro/vazio honesto — nada de dado inventado.

export interface WidgetProps {
  refreshMs: number
}

const DAY_START = 9
const DAY_END = 18

function hourFrac(iso: string | null | undefined): number | null {
  if (!iso || !iso.includes('T')) return null // evento de dia inteiro / data sem hora
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.getHours() + d.getMinutes() / 60
}

function hhmm(iso: string | null | undefined): string {
  if (!iso || !iso.includes('T')) return '' // data sem hora (dia inteiro)
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

/** Rótulo das contas da agenda por espaço (para a linha de fonte). */
export function agendaFonte(space: Space): string {
  return space === 'houer' ? 'Google Calendar · Houer' : space === 'pessoal' ? 'Google · pessoal + FIAP' : 'Google · Houer + pessoal + FIAP'
}

/** Primeiro erro parcial de /agenda (ex.: token de uma conta expirado), mesmo com eventos das outras. */
export function agendaPartialError(a: Agenda | null): string | null {
  const e = a?.erros ? Object.entries(a.erros)[0] : null
  return e ? `${e[0]}: ${e[1]}` : null
}

interface Block {
  key: string
  color?: string
  label: string
  start: number
  end: number
  kind: 'evento' | 'livre' | 'tarefa'
  title: string
}

function clampBlock(b: Block): Block | null {
  const s = Math.max(DAY_START, b.start)
  const e = Math.min(DAY_END, b.end)
  return e > s ? { ...b, start: s, end: e } : null
}

// ─── Hoje · time-boxing ──────────────────────────────────────────────────────
export function TimeboxWidget({ refreshMs }: WidgetProps) {
  const space = useSpace()
  const agenda = usePluginSource<Agenda>(agendaPath(space, 1), refreshMs)
  const foco = usePluginSource<Foco>(API.foco, refreshMs)

  const blocks: Block[] = []
  const allDay: AgendaEvent[] = []
  const evs = (agenda.data?.events ?? []).filter((e) => inSpace(spaceOfAccount(e.conta), space))
  for (const [i, ev] of evs.entries()) {
    const s = hourFrac(ev.start)
    const e = hourFrac(ev.end)
    if (s == null || e == null) {
      allDay.push(ev)
      continue
    }
    const b = clampBlock({
      key: `ev${i}`,
      label: ev.summary ?? '(sem título)',
      start: s,
      end: e,
      kind: 'evento',
      color: calendarColor(ev.calendario),
      title: `${hhmm(ev.start)}–${hhmm(ev.end)} ${ev.summary ?? ''}${ev.calendario ? ` · ${ev.calendario}` : ''}`,
    })
    if (b) blocks.push(b)
  }
  for (const [i, t] of (foco.data?.top3_hoje ?? []).entries()) {
    const s = hourFrac(t.date)
    const e = hourFrac(t.end) ?? (s != null ? s + 1 : null)
    if (s == null || e == null) continue
    const b = clampBlock({
      key: `tk${i}`,
      label: `Foco · ${t.task ?? ''}`,
      start: s,
      end: e,
      kind: 'tarefa',
      title: `Notion: ${t.task ?? ''}`,
    })
    if (b) blocks.push(b)
  }
  for (const [i, g] of (foco.data?.blocos_livres ?? []).entries()) {
    const s = hourFrac(g.inicio)
    const e = hourFrac(g.fim)
    if (s == null || e == null) continue
    const b = clampBlock({
      key: `lv${i}`,
      label: 'livre',
      start: s,
      end: e,
      kind: 'livre',
      title: `livre ${hhmm(g.inicio)}–${hhmm(g.fim)} (${g.minutos ?? '?'} min)`,
    })
    if (b) blocks.push(b)
  }

  const now = new Date()
  const nowH = now.getHours() + now.getMinutes() / 60
  const span = DAY_END - DAY_START
  const pos = (h: number) => `${((h - DAY_START) / span) * 100}%`
  const err =
    agenda.error ?? agendaPartialError(agenda.data) ?? foco.error ?? (foco.data?.erros ? Object.values(foco.data.erros)[0] : null) ?? null
  const loading = agenda.loading && foco.loading
  const hours = Array.from({ length: span }, (_, i) => DAY_START + i)

  return (
    <PanelFrame
      titulo="Hoje · time-boxing"
      icon="clock"
      fonte={`${agendaFonte(space)} + Notion`}
      error={err}
      loading={loading}
      onRefresh={() => {
        agenda.refresh()
        foco.refresh()
      }}
    >
      <div className="relative">
        <div className="relative mb-1 h-3 text-[9px] text-faint">
          {hours.map((h) => (
            <span key={h} className="absolute -translate-x-0" style={{ left: pos(h) }}>
              {h}h
            </span>
          ))}
        </div>
        <div className="relative h-9 rounded border border-edge bg-void/40">
          {blocks.map((b) => (
            <div
              key={b.key}
              title={b.title}
              className={`absolute top-1 bottom-1 overflow-hidden rounded-sm px-1.5 text-[10px] leading-[1.6rem] whitespace-nowrap ${
                b.kind === 'livre'
                  ? 'border border-dashed border-edge2 text-faint'
                  : b.kind === 'tarefa'
                    ? 'border-l-2 border-amber bg-amber/15 text-ink'
                    : 'border-l-2 text-ink'
              }`}
              style={{
                left: pos(b.start),
                width: `calc(${((b.end - b.start) / span) * 100}% - 2px)`,
                ...(b.kind === 'evento' && b.color
                  ? { borderColor: b.color, background: `color-mix(in srgb, ${b.color} 16%, transparent)` }
                  : {}),
              }}
            >
              {b.label}
            </div>
          ))}
          {nowH >= DAY_START && nowH <= DAY_END && (
            <div className="absolute top-0 bottom-0 w-px bg-alert" style={{ left: pos(nowH) }} title="agora" />
          )}
          {!loading && blocks.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-faint">
              {err ? 'sem dados da agenda' : 'nenhum bloco hoje'}
            </div>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 text-[10px] text-dim">
          {foco.data?.janela && (
            <span>
              janela <span className="text-amber">{foco.data.janela}</span>
            </span>
          )}
          {foco.data?.proximo_evento?.summary && (
            <span className="truncate">
              próximo: {hhmm(foco.data.proximo_evento.start)} {foco.data.proximo_evento.summary}
            </span>
          )}
          {allDay.length > 0 && <span className="truncate">dia todo: {allDay.map((e) => e.summary).join(', ')}</span>}
        </div>
      </div>
    </PanelFrame>
  )
}

// ─── Tarefas (Notion) ────────────────────────────────────────────────────────
export function TarefasWidget({ refreshMs }: WidgetProps) {
  const notion = usePluginSource<Notion>(API.notion, refreshMs)
  const hoje = notion.data?.hoje ?? []
  const doing = notion.data?.in_progress ?? []
  const items: Array<NotionTask & { grupo: string }> = [
    ...hoje.map((t) => ({ ...t, grupo: 'hoje' })),
    ...doing.map((t) => ({ ...t, grupo: 'em curso' })),
  ]
  const counts = notion.data?.counts
  return (
    <PanelFrame
      titulo="Tarefas"
      fonte={counts?.abertas != null ? `Notion · ${counts.abertas} abertas` : 'Notion'}
      error={notion.error}
      loading={notion.loading}
      empty={!notion.loading && items.length === 0}
      emptyText={notion.error ? 'sem dados do Notion' : 'nada para hoje nem em curso'}
      onRefresh={notion.refresh}
    >
      <ul className="space-y-1">
        {items.map((t, i) => (
          <li key={t.id ?? i} className="flex items-center gap-2 text-[11px]">
            {/* somente leitura: o plugin não expõe escrita no Notion */}
            <input type="checkbox" disabled className="accent-amber" title="somente leitura" />
            <a
              href={t.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate text-ink hover:text-amber"
              title={t.task}
            >
              {t.task}
            </a>
            {t.prioridade?.[0] === 'HIGH' && <span className="text-[9px] text-alert">HIGH</span>}
            <span className="shrink-0 text-[9px] text-faint">{t.grupo}</span>
          </li>
        ))}
      </ul>
    </PanelFrame>
  )
}

// ─── Inbox triada ────────────────────────────────────────────────────────────
export function InboxWidget({ refreshMs }: WidgetProps) {
  const space = useSpace()
  const inbox = usePluginSource<Inbox>(API.inbox, refreshMs)
  const rows: Array<{ tag: 'responder' | 'ler'; m: InboxItem }> = [
    ...(inbox.data?.responder ?? []).map((m) => ({ tag: 'responder' as const, m })),
    ...(inbox.data?.ler ?? []).map((m) => ({ tag: 'ler' as const, m })),
  ].filter((r) => inSpace(spaceOfAccount(r.m.conta), space))
  return (
    <PanelFrame
      titulo="Inbox triada"
      icon="inbox"
      fonte={space === 'houer' ? 'Gmail Houer' : space === 'pessoal' ? 'Gmail pessoal' : 'Gmail Houer · pessoal'}
      error={inbox.error}
      loading={inbox.loading}
      empty={!inbox.loading && rows.length === 0}
      emptyText={inbox.error ? 'sem dados do Gmail' : 'inbox limpa (3 dias)'}
      onRefresh={inbox.refresh}
    >
      <ul className="space-y-1">
        {rows.map(({ tag, m }, i) => (
          <li key={i} className="flex items-center gap-2 text-[11px]" title={m.snippet}>
            <span
              className={`shrink-0 rounded border px-1.5 text-[9px] ${
                tag === 'responder' ? 'border-amber/60 text-amber' : 'border-edge2 text-faint'
              }`}
            >
              {tag}
            </span>
            <span className="min-w-0 flex-1 truncate">
              <span className="text-dim">{m.from}</span> <span className="text-ink">{m.subject}</span>
            </span>
            <span className="shrink-0 text-[9px] text-faint">{m.conta === 'work' ? 'Houer' : m.conta === 'personal' ? 'pessoal' : m.conta}</span>
          </li>
        ))}
      </ul>
    </PanelFrame>
  )
}

// ─── Agenda (lista) ──────────────────────────────────────────────────────────
export function AgendaWidget({ refreshMs }: WidgetProps) {
  const space = useSpace()
  const agenda = usePluginSource<Agenda>(agendaPath(space, 1), refreshMs)
  const evs = (agenda.data?.events ?? []).filter((e) => inSpace(spaceOfAccount(e.conta), space))
  return (
    <PanelFrame
      titulo="Agenda de hoje"
      icon="calendar"
      fonte={agendaFonte(space)}
      error={agenda.error ?? agendaPartialError(agenda.data)}
      loading={agenda.loading}
      empty={!agenda.loading && evs.length === 0}
      emptyText={agenda.error ? 'sem dados da agenda' : 'agenda livre hoje'}
      onRefresh={agenda.refresh}
    >
      <ul className="space-y-1">
        {evs.map((e, i) => (
          <li key={i} className="flex items-center gap-2 text-[11px]" title={[e.summary, e.location, e.calendario].filter(Boolean).join(' · ')}>
            <span aria-hidden className="h-2.5 w-0.5 shrink-0 rounded-full" style={{ background: calendarColor(e.calendario) }} />
            <span className="w-20 shrink-0 text-faint tabular-nums">
              {hourFrac(e.start) == null ? 'dia todo' : `${hhmm(e.start)}–${hhmm(e.end)}`}
            </span>
            {e.htmlLink ? (
              <a href={e.htmlLink} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-ink hover:text-space">
                {e.summary}
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate text-ink">{e.summary}</span>
            )}
            {e.calendario && <span className="shrink-0 text-[9px] text-faint">{e.calendario}</span>}
          </li>
        ))}
      </ul>
    </PanelFrame>
  )
}

// ─── Sistema (host do cockpit) ──────────────────────────────────────────────
// Métricas vêm de ops:system (src/main/metrics.ts) — a MESMA coleta local
// multiplataforma da Ops > Sistema, que funciona no Windows/Linux/macOS.
// O plugin cockpit (/sistema) é EXTRA e opcional: quando responde, acrescenta
// gateway/ollama/processos do Hermes; quando não existe (404 no Windows), é
// omitido em silêncio — nunca vira erro no card.
//
// Layout: linha de cartões com donut (RadialStat) que quebra em várias linhas
// — grid auto-fill de ~120px, então num painel estreito cabem 2 por linha sem
// cortar texto (rótulos longos truncam e ficam no title).
export function SistemaWidget({ refreshMs }: WidgetProps) {
  const sys = useAsync<SystemInfo>(ops.system, [], refreshMs)
  const plugin = usePluginSource<Sistema>(API.sistema, Math.max(refreshMs, 60_000))
  const d = sys.data
  const p = plugin.error ? null : plugin.data
  const cards = d ? systemCards(d) : []
  const gpu = d ? mainGpu(d) : null
  return (
    <PanelFrame
      titulo={`Sistema · ${HOST_LABEL}`}
      fonte="local"
      error={sys.error}
      loading={sys.initial}
      empty={!d && !sys.loading}
      emptyText={sys.error ? 'sem métricas do host' : 'sem dados'}
      onRefresh={() => void sys.reload()}
    >
      {d && (
        <div className="space-y-2">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1.5">
            {cards.map((c) => (
              <RadialStat
                key={c.key}
                icon={c.icon}
                label={c.label}
                value={c.pct}
                tone={c.tone}
                detail={c.detail}
                sub={c.sub}
                title={c.title}
                size={52}
                strokeWidth={5}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 text-[10px] text-dim">
            <span title={[d.hostname, d.osVersion, d.osDetail].filter(Boolean).join(' · ')}>
              {d.osVersion} · no ar há {fmtUptime(d.uptimeSec)}
            </span>
            {d.load && <span>load {d.load[0].toFixed(2)}</span>}
            {!gpu && <span className="text-faint">{d.gpuError ?? 'sem GPU'}</span>}
            {/* extras só do plugin cockpit: ausentes (e silenciosos) sem ele */}
            {p && (
              <>
                <span className={p.ollama ? 'text-phos' : 'text-faint'}>ollama {p.ollama ? 'on' : 'off'}</span>
                {p.hermes_processes != null && <span>{p.hermes_processes} proc hermes</span>}
                <span className={p.gateway ? 'text-phos' : 'text-faint'}>
                  gateway {p.gateway ? (p.gateway.code_version ?? 'on') : 'sem estado'}
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </PanelFrame>
  )
}

// ─── Cards do dock sem fonte ainda (P2) ──────────────────────────────────────
export function DiffWidget() {
  return (
    <PanelFrame titulo="Diff pendente" fonte="git_probe · P2" empty emptyText="nenhuma fonte de diff conectada ainda (P2-13: git_probe do backend)." />
  )
}

export function SwarmWidget() {
  return (
    <PanelFrame
      titulo="Execuções do swarm"
      fonte="subagents · P2"
      empty
      emptyText="sem dados de execuções do swarm — o plugin ainda não expõe subagents (P2-15)."
    />
  )
}
