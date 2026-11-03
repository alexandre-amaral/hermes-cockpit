import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/ipc'
import { agendaPath, inSpace, spaceOfAccount, spaceOfBot, spaceOfPath, useSpace, type ItemSpace } from '../../lib/space'
import { useQuota } from '../../lib/quota'
import { fmtResetParts, pctTone, TONE_VAR } from '../../lib/quota-model'
import { useNow, useSwarm, type RunMeta } from '../../lib/swarm'
import { cx } from '../ui/cx'
import { CountUp, Gauge, Sparkline } from '../ui/Viz'
import { PanelFrame } from './PanelFrame'
import { usePluginSource } from './source'
import { agendaFonte, agendaPartialError, type WidgetProps } from './widgets'
import { API, CALENDAR_COLORS, calendarColor, fmtTokens, type Agenda, type AgendaEvent, type CronJob } from './types'

// Widgets v3 do registry: agenda da semana multi-conta, próximos crons,
// atividade do swarm e gauges de cota. Todos filtram pelo espaço ativo e
// mostram erro/vazio honesto — nada de dado inventado.

// ─── Agenda da semana (multi-conta) ──────────────────────────────────────────

const WEEK_START_H = 7
const WEEK_END_H = 23
const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

/** Data local de um campo start/end (ISO com hora ou 'YYYY-MM-DD' de dia inteiro). */
function parseWhen(v?: string): { d: Date; allDay: boolean } | null {
  if (!v) return null
  if (!v.includes('T')) {
    const [y, m, d] = v.split('-').map(Number)
    if (!y || !m || !d) return null
    return { d: new Date(y, m - 1, d), allDay: true }
  }
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : { d, allDay: false }
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const hm = (d: Date) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

interface DayRow {
  day: Date
  timed: Array<{ ev: AgendaEvent; s: number; e: number }>
  allDay: AgendaEvent[]
}

export function AgendaWeekWidget({ refreshMs }: WidgetProps) {
  const space = useSpace()
  const agenda = usePluginSource<Agenda>(agendaPath(space, 7), refreshMs)
  const now = useNow(60_000)

  const rows = useMemo<DayRow[]>(() => {
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    const days: DayRow[] = Array.from({ length: 7 }, (_, i) => ({
      day: new Date(today.getFullYear(), today.getMonth(), today.getDate() + i),
      timed: [],
      allDay: [],
    }))
    for (const ev of agenda.data?.events ?? []) {
      if (!inSpace(spaceOfAccount(ev.conta), space)) continue
      const s = parseWhen(ev.start)
      const e = parseWhen(ev.end)
      if (!s) continue
      if (s.allDay) {
        // fim exclusivo no Google; evento de vários dias aparece em cada dia
        const end = e?.d ?? new Date(s.d.getTime() + 86_400_000)
        for (const r of days) if (r.day >= s.d && r.day < end) r.allDay.push(ev)
        continue
      }
      const row = days.find((r) => sameDay(r.day, s.d))
      if (!row) continue
      const sh = s.d.getHours() + s.d.getMinutes() / 60
      const eh = e && !e.allDay ? (sameDay(e.d, s.d) ? e.d.getHours() + e.d.getMinutes() / 60 : 24) : sh + 1
      row.timed.push({ ev, s: sh, e: Math.max(eh, sh + 0.25) })
    }
    return days
  }, [agenda.data, space, now])

  const total = rows.reduce((n, r) => n + r.timed.length + r.allDay.length, 0)
  const calendars = Object.keys(CALENDAR_COLORS).filter((c) =>
    space === 'houer' ? c === 'Houer' : space === 'pessoal' ? c !== 'Houer' : true,
  )
  const span = WEEK_END_H - WEEK_START_H
  const x = (h: number) => `${((Math.min(WEEK_END_H, Math.max(WEEK_START_H, h)) - WEEK_START_H) / span) * 100}%`
  const nowD = new Date(now)
  const nowH = nowD.getHours() + nowD.getMinutes() / 60
  const partial = agendaPartialError(agenda.data)

  return (
    <PanelFrame
      titulo="Agenda da semana"
      icon="calendar"
      fonte={`${agendaFonte(space)} · ${total} evento${total === 1 ? '' : 's'}`}
      error={agenda.error ?? partial}
      loading={agenda.loading && !agenda.data}
      empty={!agenda.loading && total === 0}
      emptyText={agenda.error ? 'sem dados da agenda' : 'semana livre'}
      onRefresh={agenda.refresh}
      extra={
        <span className="hidden shrink-0 items-center gap-2 text-[9px] text-faint xl:flex">
          {calendars.map((c) => (
            <span key={c} className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: calendarColor(c) }} />
              {c}
            </span>
          ))}
        </span>
      }
    >
      <div className="hc-stagger space-y-[3px]">
        <div className="relative ml-14 h-2.5 text-[8.5px] text-faint">
          {[8, 12, 16, 20].map((h) => (
            <span key={h} className="absolute -translate-x-1/2" style={{ left: x(h) }}>
              {h}h
            </span>
          ))}
        </div>
        {rows.map((r, i) => {
          const isToday = i === 0
          return (
            <div key={r.day.toISOString()} className="flex items-center gap-2">
              <div className={cx('w-12 shrink-0 text-right text-[9.5px] whitespace-nowrap uppercase tabular-nums tracking-wider', isToday ? 'text-space' : 'text-faint')}>
                {WD[r.day.getDay()]} {String(r.day.getDate()).padStart(2, '0')}
              </div>
              <div
                className={cx(
                  'relative h-[13px] min-w-0 flex-1 overflow-hidden rounded-[3px] border',
                  isToday ? 'border-edge2 bg-void/50' : 'border-edge/70 bg-void/30',
                )}
              >
                {[12, 18].map((h) => (
                  <span key={h} aria-hidden className="absolute inset-y-0 w-px bg-edge/60" style={{ left: x(h) }} />
                ))}
                {r.allDay.length > 0 && (
                  <span
                    className="absolute inset-y-0 left-0 z-[1] flex items-center gap-0.5 px-0.5"
                    title={`dia todo: ${r.allDay.map((e) => `${e.summary} (${e.calendario ?? '?'})`).join(', ')}`}
                  >
                    {r.allDay.slice(0, 3).map((e, k) => (
                      <span key={k} className="h-[7px] w-[7px] rotate-45 rounded-[1px]" style={{ background: calendarColor(e.calendario) }} />
                    ))}
                  </span>
                )}
                {r.timed.map(({ ev, s, e }, k) => {
                  const c = calendarColor(ev.calendario)
                  return (
                    <a
                      key={k}
                      href={ev.htmlLink || undefined}
                      target="_blank"
                      rel="noreferrer"
                      title={`${hm(new Date(ev.start!))}–${ev.end?.includes('T') ? hm(new Date(ev.end)) : ''} ${ev.summary ?? ''} · ${ev.calendario ?? ''}${ev.location ? ` · ${ev.location}` : ''}`}
                      className="absolute inset-y-[1px] overflow-hidden rounded-[2px] border-l-2 px-1 text-[8.5px] leading-[10px] whitespace-nowrap text-ink transition-[filter] hover:brightness-150"
                      style={{
                        left: x(s),
                        width: `max(3px, calc(${((Math.min(e, WEEK_END_H) - Math.max(s, WEEK_START_H)) / span) * 100}% - 1px))`,
                        borderColor: c,
                        background: `color-mix(in srgb, ${c} 22%, transparent)`,
                      }}
                    >
                      {ev.summary}
                    </a>
                  )
                })}
                {isToday && nowH >= WEEK_START_H && nowH <= WEEK_END_H && (
                  <span aria-hidden className="absolute inset-y-0 z-[2] w-px bg-alert shadow-[0_0_6px_var(--color-alert)]" style={{ left: x(nowH) }} />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </PanelFrame>
  )
}

// ─── Próximos crons ──────────────────────────────────────────────────────────

/** Polling simples de uma rota REST do serve (lib/ipc api). Fora do Electron: erro honesto. */
function useApiPoll<T>(path: string, refreshMs: number): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [st, setSt] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true })
  const load = useCallback(() => {
    api<T>(path)
      .then((data) => setSt({ data, error: null, loading: false }))
      .catch((e: unknown) =>
        setSt((s) => ({ data: s.data, error: (e instanceof Error ? e.message : String(e)).slice(0, 160), loading: false })),
      )
  }, [path])
  useEffect(() => {
    load()
    const t = setInterval(load, Math.max(10_000, refreshMs))
    return () => clearInterval(t)
  }, [load, refreshMs])
  return { ...st, refresh: load }
}

function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const m = Math.round((t - now) / 60_000)
  if (m < -1) return `atrasado ${Math.abs(m) < 60 ? `${Math.abs(m)} min` : `${Math.round(Math.abs(m) / 60)} h`}`
  if (m <= 0) return 'agora'
  if (m < 60) return `em ${m} min`
  const d = new Date(t)
  const today = new Date(now)
  if (sameDay(d, today)) return `hoje ${hm(d)}`
  const tomorrow = new Date(now + 86_400_000)
  if (sameDay(d, tomorrow)) return `amanhã ${hm(d)}`
  return `${WD[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${hm(d)}`
}

export function CronWidget({ refreshMs }: WidgetProps) {
  const space = useSpace()
  const jobs = useApiPoll<CronJob[]>('/api/cron/jobs', refreshMs)
  const now = useNow(30_000)
  const list = Array.isArray(jobs.data) ? jobs.data : []
  const rows = list
    .filter((j) => inSpace(spaceOfBot(j.profile ?? j.profile_name ?? ''), space))
    .sort((a, b) => {
      const ea = a.enabled !== false && a.next_run_at ? 0 : 1
      const eb = b.enabled !== false && b.next_run_at ? 0 : 1
      return ea - eb || String(a.next_run_at ?? '').localeCompare(String(b.next_run_at ?? ''))
    })
  const active = rows.filter((j) => j.enabled !== false).length
  return (
    <PanelFrame
      titulo="Próximos crons"
      icon="automations"
      fonte={jobs.data ? `${active} ativo${active === 1 ? '' : 's'} · ${rows.length} no espaço` : '/api/cron/jobs'}
      error={jobs.error}
      loading={jobs.loading}
      empty={!jobs.loading && rows.length === 0}
      emptyText={jobs.error ? 'sem dados de cron' : 'nenhum cron neste espaço'}
      onRefresh={jobs.refresh}
    >
      <ul className="hc-stagger space-y-1">
        {rows.slice(0, 8).map((j) => {
          const paused = j.enabled === false || j.state === 'paused'
          const err = j.state === 'error' || Boolean(j.last_error)
          return (
            <li
              key={`${j.profile}:${j.id}`}
              className={cx('flex items-center gap-2 text-[11px]', paused && 'opacity-50')}
              title={[j.name ?? j.id, j.schedule_display ?? j.schedule?.display, j.profile && `bot: ${j.profile}`, j.last_error].filter(Boolean).join(' · ')}
            >
              <span
                aria-hidden
                className={cx('h-1.5 w-1.5 shrink-0 rounded-full', err ? 'bg-alert' : paused ? 'bg-faint' : 'bg-phos')}
              />
              <span className="min-w-0 flex-1 truncate text-ink">{j.name || j.id}</span>
              <span className="shrink-0 text-[9px] text-faint">{j.profile}</span>
              <span className={cx('w-24 shrink-0 text-right text-[10px] tabular-nums', paused ? 'text-faint' : 'text-dim')}>
                {paused ? 'pausado' : relTime(j.next_run_at, now)}
              </span>
            </li>
          )
        })}
      </ul>
    </PanelFrame>
  )
}

// ─── Atividade do swarm ──────────────────────────────────────────────────────

const HOURS = 12

function spaceOfRun(r: RunMeta): ItemSpace {
  const byBot = r.requestedBy?.profile ? spaceOfBot(r.requestedBy.profile) : 'shared'
  return byBot !== 'shared' ? byBot : spaceOfPath(r.repo || r.cwd)
}

export function SwarmActivityWidget(props: WidgetProps) {
  void props.refreshMs // o store do swarm faz o próprio polling
  const s = useSwarm()
  const space = useSpace()
  const now = useNow(60_000)
  const runs = s.runs.filter((r) => inSpace(spaceOfRun(r), space))
  const { counts, toks, total, tokens, tokenRuns } = useMemo(() => {
    const counts = Array<number>(HOURS).fill(0)
    const toks = Array<number>(HOURS).fill(0)
    const t0 = now - HOURS * 3_600_000
    let total = 0
    let tokens = 0
    let tokenRuns = 0
    for (const r of runs) {
      const t = new Date(r.startedAt ?? r.createdAt).getTime()
      if (Number.isNaN(t) || t < t0) continue
      const i = Math.min(HOURS - 1, Math.floor((t - t0) / 3_600_000))
      counts[i] += 1
      total += 1
      // tokens reais do result; runs sem dado não somam (nada estimado)
      if (typeof r.tokensTotal === 'number') {
        toks[i] += r.tokensTotal
        tokens += r.tokensTotal
        tokenRuns += 1
      }
    }
    return { counts, toks, total, tokens: tokenRuns ? tokens : null, tokenRuns }
  }, [runs, now])
  const activeN = runs.filter((r) => r.status === 'running' || r.status === 'queued' || r.status === 'waiting_approval').length
  const unavailable = s.phase === 'unavailable'
  return (
    <PanelFrame
      titulo="Atividade do swarm"
      icon="activity"
      fonte={`últimas ${HOURS}h`}
      error={unavailable ? null : s.phase === 'error' ? (s.error ?? 'erro') : null}
      loading={s.phase === 'loading'}
      empty={unavailable}
      emptyText={`swarm indisponível — ${s.error ?? 'sem main process'}`}
      onRefresh={() => void s.refresh()}
    >
      <div className="grid h-full grid-cols-2 gap-3">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-baseline gap-1.5">
            <CountUp value={total} className="text-[18px] leading-none text-ink" />
            <span className="text-[10px] text-faint">runs</span>
            {activeN > 0 && (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-phos">
                <span className="hc-pulse-dot h-1.5 w-1.5 rounded-full bg-phos" />
                {activeN} ativa{activeN > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="mt-1.5 h-8 min-h-0 flex-1">
            <Sparkline values={total ? counts : []} color="var(--color-phos)" title={`runs por hora: ${counts.join(', ')}`} />
          </div>
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-baseline gap-1.5">
            <CountUp value={tokens} format={(n) => fmtTokens(Math.round(n))} className="text-[18px] leading-none text-ink" />
            <span className="text-[10px] text-faint" title={tokens == null ? 'sem dado de tokens nas runs da janela' : `${tokenRuns} run(s) com dado de tokens`}>
              tokens
            </span>
          </div>
          <div className="mt-1.5 h-8 min-h-0 flex-1">
            <Sparkline
              values={tokens ? toks : []}
              color="var(--color-amber)"
              title={`tokens por hora: ${toks.map((c) => fmtTokens(c)).join(', ')}`}
            />
          </div>
        </div>
      </div>
    </PanelFrame>
  )
}

// ─── Cota (gauges radiais) ───────────────────────────────────────────────────

/** Agrupa os gauges das janelas de um provedor sob o nome dele. */
function ProviderGauges({ nome, sub, children }: { nome?: string; sub?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={`Cota ${nome ?? 'provedor'}`} className="min-w-0 rounded-md border border-edge/70 px-2 py-1.5">
      <div className="mb-1 flex items-baseline gap-2 text-[10px]">
        <span className="truncate text-ink">{nome ?? '?'}</span>
        {sub && <span className="truncate text-[9px] text-faint">{sub}</span>}
      </div>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">{children}</div>
    </div>
  )
}

/** Gauges por provedor: 5 horas, semanal e as janelas extras. */
export function QuotaGaugesWidget({ refreshMs }: WidgetProps) {
  const q = useQuota(refreshMs || 60_000)
  const now = useNow(30_000)
  return (
    <PanelFrame
      titulo="Cota"
      icon="gauge"
      fonte={q.providers.length === 1 ? q.providers[0].source : 'provedores locais'}
      error={q.error}
      loading={q.loading}
      empty={!q.loading && q.providers.length === 0}
      emptyText={q.error ? 'cota indisponível' : 'nenhum provedor de IA autenticado nesta máquina'}
      onRefresh={q.refresh}
    >
      {q.providers.length > 0 && (
        <div className="hc-stagger flex flex-wrap items-start gap-x-3 gap-y-2">
          {q.providers.map((p) => {
            const sub = [p.plan, p.error ? 'erro' : null].filter(Boolean).join(' · ') || undefined
            if (p.error) {
              return (
                <ProviderGauges key={p.provider} nome={p.label} sub={p.plan ?? undefined}>
                  <Gauge pct={null} size={60} label="erro" sub={p.error.slice(0, 40)} tone="var(--color-alert)" />
                </ProviderGauges>
              )
            }
            if (p.windows.length === 0) {
              return (
                <ProviderGauges key={p.provider} nome={p.label} sub={sub}>
                  <Gauge pct={null} size={60} label="cota" sub={p.note ? 'sem janela' : 'sem dado'} />
                </ProviderGauges>
              )
            }
            return (
              <ProviderGauges key={p.provider} nome={p.label} sub={sub}>
                {p.windows.map((w, k) => {
                  const r = fmtResetParts(w.resetsAt, now)
                  return (
                    <Gauge
                      key={`${w.kind}-${w.label}-${k}`}
                      pct={w.usedPct}
                      size={60}
                      label={w.label}
                      sub={r ? (w.kind === '5h' ? `em ${r.in}` : r.at) : undefined}
                      tone={TONE_VAR[pctTone(w.usedPct)]}
                    />
                  )
                })}
              </ProviderGauges>
            )
          })}
        </div>
      )}
    </PanelFrame>
  )
}
