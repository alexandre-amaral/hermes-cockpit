import { useEffect, useState } from 'react'
import { useQuota } from '../../lib/quota'
import {
  extraWindows,
  fmtResetParts,
  pctTone,
  TONE_VAR,
  windowOf,
  worstPct,
  type ProviderQuota,
  type QuotaWindow,
} from '../../lib/quota-model'
import { useNow } from '../../lib/swarm'
import { Icon } from '../ui/Icon'
import { SkeletonLines } from '../ui/Skeleton'
import { Tabs } from '../ui/Tabs'
import { cx } from '../ui/cx'
import { PanelFrame } from './PanelFrame'
import type { WidgetProps } from './widgets'

// Widget de cota: UMA ABA POR PROVEDOR (Claude · Codex · …). Em cada aba, a
// janela de 5 horas em cima e a semanal embaixo; janelas extras (semanal por
// modelo, créditos) ficam menores no rodapé. Erro de um provedor fica na aba
// dele — os outros continuam funcionando. Tons: --color-warn ≥80%,
// --color-alert ≥90%, accent (--color-space) no normal.
//
// A cota não é filtrada por espaço: provedor de IA não pertence a Houer/Pessoal
// (ao contrário de agenda/tarefas/inbox, que filtram por conta).

/** "reinicia em 2h 13m" (janela curta) / "reinicia em sex 09:00" (longa). */
function resetText(w: QuotaWindow, now: number): string {
  const r = fmtResetParts(w.resetsAt, now)
  if (!r) return 'sem reset informado'
  if (w.kind === '5h') return r.in === 'agora' ? 'reiniciando agora' : `reinicia em ${r.in}`
  return r.in === 'agora' ? 'reiniciando agora' : `reinicia em ${r.at}`
}

function resetTitle(w: QuotaWindow, now: number): string | undefined {
  const r = fmtResetParts(w.resetsAt, now)
  return r ? `${w.label} · ${Math.round(w.usedPct)}% · reinicia em ${r.in} (${r.at})` : undefined
}

/** Barra de uma janela. `size="lg"` para 5h/semanal; `"sm"` para as extras. */
function WindowBar({ w, size = 'lg', now }: { w: QuotaWindow; size?: 'lg' | 'sm'; now: number }) {
  const tone = pctTone(w.usedPct)
  const color = TONE_VAR[tone]
  const pct = Math.max(0, Math.min(100, w.usedPct))
  const lg = size === 'lg'
  return (
    <div
      role="group"
      aria-label={`${w.label}: ${Math.round(w.usedPct)}% usado, ${resetText(w, now)}`}
      title={resetTitle(w, now)}
      className="min-w-0"
    >
      <div className={cx('flex items-baseline justify-between gap-2', lg ? 'text-[11px]' : 'text-[9px]')}>
        <span className="flex min-w-0 items-center gap-1.5 truncate text-dim">
          <span className="truncate">{w.label}</span>
          {w.active && (
            <span aria-hidden className="shrink-0 rounded-sm border border-edge2 px-1 text-[8px] text-faint uppercase">
              ativa
            </span>
          )}
        </span>
        <span className="shrink-0 tabular-nums" style={{ color }}>
          {Math.round(w.usedPct)}%
        </span>
      </div>
      <div className={cx('mt-0.5 w-full overflow-hidden rounded-full bg-edge', lg ? 'h-1.5' : 'h-1')}>
        <div
          className="h-full rounded-full transition-[width,background-color] duration-[var(--hc-dur-4)] ease-[var(--hc-ease-out)]"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <div className={cx('mt-0.5 truncate text-faint', lg ? 'text-[9px]' : 'text-[8px]')}>{resetText(w, now)}</div>
    </div>
  )
}

/** Linha de erro/observação de um provedor — fica dentro da aba dele. */
function ProviderNote({ kind, text }: { kind: 'error' | 'note'; text: string }) {
  const bad = kind === 'error'
  return (
    <div
      className={cx(
        'flex items-start gap-1.5 rounded border px-2 py-1 text-[10px]',
        bad ? 'border-alert/40 bg-alert/5 text-alert' : 'border-edge bg-panel2/50 text-faint',
      )}
      role={bad ? 'alert' : undefined}
    >
      <Icon name={bad ? 'alert' : 'spark'} size={11} className="mt-[1px] shrink-0 opacity-80" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  )
}

/** Idade do snapshot ("desde 18:14") para fontes que não são ao vivo. */
function asOfText(p: ProviderQuota, now: number): string | null {
  if (!p.asOf) return null
  const t = Date.parse(p.asOf)
  if (Number.isNaN(t)) return null
  const mins = Math.floor((now - t) / 60_000)
  if (mins < 2) return null // ao vivo: não poluir
  const hhmm = new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return mins < 60 ? `medido ${mins} min atrás (${hhmm})` : `medido às ${hhmm}`
}

/** Conteúdo de uma aba: 5 horas em cima, semanal embaixo, extras menores. */
export function ProviderQuotaPanel({ p, now }: { p: ProviderQuota; now: number }) {
  const w5 = windowOf(p, '5h')
  const wk = windowOf(p, 'weekly')
  const extras = extraWindows(p)
  const age = asOfText(p, now)
  return (
    <div className="space-y-2">
      {p.error && <ProviderNote kind="error" text={p.error} />}
      {w5 && <WindowBar w={w5} now={now} />}
      {wk && <WindowBar w={wk} now={now} />}
      {!w5 && !wk && !p.error && (
        <div className="text-[10px] text-faint">{p.note ? 'sem janela de cota exposta pelo provedor' : 'sem janela de limite'}</div>
      )}
      {extras.length > 0 && (
        <ul className="space-y-1.5 border-t border-edge/70 pt-1.5">
          {extras.map((w, i) => (
            <li key={`${w.kind}-${w.label}-${i}`}>
              <WindowBar w={w} size="sm" now={now} />
            </li>
          ))}
        </ul>
      )}
      {(p.note || age) && (
        <div className="space-y-1">
          {age && <div className="text-[9px] text-faint">{age}</div>}
          {p.note && <ProviderNote kind="note" text={p.note} />}
        </div>
      )}
    </div>
  )
}

/** Chip de % ao lado do nome do provedor na aba. */
function TabPct({ p }: { p: ProviderQuota }) {
  const pct = worstPct(p)
  if (p.error) return <span className="text-[9px] text-alert">erro</span>
  if (pct == null) return null
  return (
    <span className="text-[9px] tabular-nums" style={{ color: TONE_VAR[pctTone(pct)] }}>
      {Math.round(pct)}%
    </span>
  )
}

/** Aba inicial/estável: a do provedor mais pressionado que ainda existir. */
function useActiveProvider(providers: ProviderQuota[]): [ProviderQuota | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(null)
  const exists = providers.some((p) => p.provider === id)
  useEffect(() => {
    if (exists || providers.length === 0) return
    const worst = providers.reduce<ProviderQuota | null>((a, b) => ((worstPct(b) ?? -1) > (worstPct(a) ?? -1) ? b : a), null)
    setId((worst ?? providers[0]).provider)
  }, [exists, providers])
  return [providers.find((p) => p.provider === id) ?? providers[0] ?? null, setId]
}

export function QuotaWidget({ refreshMs }: WidgetProps) {
  const q = useQuota(refreshMs || 60_000)
  const now = useNow(30_000)
  const [active, setActive] = useActiveProvider(q.providers)
  const spend =
    q.plugin && typeof q.plugin.gasto_brl === 'number'
      ? `R$ ${q.plugin.gasto_brl.toFixed(0)}${typeof q.plugin.budget_brl === 'number' ? ` / ${q.plugin.budget_brl.toFixed(0)}` : ''}`
      : null
  return (
    <PanelFrame
      titulo="Provedores · cota"
      icon="money"
      fonte={active?.source}
      error={q.error}
      loading={q.loading}
      empty={!q.loading && q.providers.length === 0}
      emptyText={q.error ? 'cota indisponível' : 'nenhum provedor de IA autenticado nesta máquina'}
      onRefresh={q.refresh}
      extra={
        spend && (
          <span className="shrink-0 rounded border border-edge px-1.5 text-[10px] text-dim" title="gasto do mês (plugin cockpit)">
            {spend}
          </span>
        )
      }
    >
      {q.providers.length > 0 && active && (
        <div className="space-y-2">
          {q.providers.length > 1 && (
            <Tabs
              items={q.providers.map((p) => ({
                id: p.provider,
                label: p.label,
                badge: <TabPct p={p} />,
                title: [p.label, p.plan, p.source].filter(Boolean).join(' · '),
              }))}
              value={active.provider}
              onChange={setActive}
              ariaLabel="Provedores com cota"
              controls={(id) => `quota-tab-${id}`}
            />
          )}
          <div id={`quota-tab-${active.provider}`} role="tabpanel" aria-label={active.label}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[10px]">
              <span className="truncate text-ink">
                {active.label}
                {active.plan && <span className="text-faint"> · {active.plan}</span>}
              </span>
            </div>
            <ProviderQuotaPanel p={active} now={now} />
          </div>
        </div>
      )}
    </PanelFrame>
  )
}

/** Cota compacta para o rodapé da rail: sem abas, 5h e semanal por provedor. */
export function RailQuotaWidget({ refreshMs }: WidgetProps) {
  const q = useQuota(refreshMs || 60_000)
  const now = useNow(30_000)
  return (
    <div className="h-full overflow-y-auto px-3 py-2.5">
      <div className="label mb-1.5 flex items-center gap-2">
        <span>Provedores · cota</span>
        {q.error && (
          <button
            type="button"
            onClick={q.refresh}
            className="truncate normal-case tracking-normal text-alert"
            title={`${q.error} — clique para tentar de novo`}
          >
            erro
          </button>
        )}
      </div>
      {q.loading && <SkeletonLines lines={4} />}
      {!q.loading && q.providers.length === 0 && (
        <div className="text-[10px] text-faint">{q.error ? 'cota indisponível' : 'nenhum provedor autenticado'}</div>
      )}
      <div className="space-y-2.5">
        {q.providers.map((p) => {
          const w5 = windowOf(p, '5h')
          const wk = windowOf(p, 'weekly')
          const pct = worstPct(p)
          return (
            <div key={p.provider} role="group" aria-label={`Cota ${p.label}`}>
              <div className="flex items-baseline justify-between gap-2 text-[10px]">
                <span className="truncate text-ink" title={[p.label, p.plan, p.source].filter(Boolean).join(' · ')}>
                  {p.label}
                  {p.plan && <span className="text-faint"> · {p.plan}</span>}
                </span>
                {p.error ? (
                  <span className="shrink-0 text-[9px] text-alert" title={p.error}>
                    erro
                  </span>
                ) : (
                  pct != null && (
                    <span className="shrink-0 text-[9px] tabular-nums" style={{ color: TONE_VAR[pctTone(pct)] }}>
                      {Math.round(pct)}%
                    </span>
                  )
                )}
              </div>
              {(w5 || wk) && (
                <div className="mt-1 space-y-1">
                  {w5 && <WindowBar w={w5} size="sm" now={now} />}
                  {wk && <WindowBar w={wk} size="sm" now={now} />}
                </div>
              )}
              {!w5 && !wk && !p.error && <div className="mt-0.5 text-[9px] text-faint">sem janela de cota</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
