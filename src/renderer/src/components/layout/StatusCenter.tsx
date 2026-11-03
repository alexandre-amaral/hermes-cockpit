import { useEffect, useRef, useState, type ReactNode } from 'react'
import { setAutoMode, useAutoMode } from '../../lib/automode'
import { useQuota } from '../../lib/quota'
import { fmtResetParts, pctTone, snapshotWorstPct, TONE_VAR } from '../../lib/quota-model'
import { fmtUptime, ops, type SystemInfo } from '../../lib/ops'
import { displayTone, type MeterTone } from '../../lib/radial'
import type { ConnState } from '../../lib/rpc'
import { HOST_LABEL } from '../../lib/platform'
import { useAsync } from '../ops/ui'
import { Bar } from '../panels/PanelFrame'
import { usePluginSource } from '../panels/source'
import { API, type Sistema } from '../panels/types'
import { Icon, type IconName } from '../ui/Icon'
import { cx } from '../ui/cx'

type Tone = 'ok' | 'warn' | 'off' | 'bad'

const RANK: Record<Tone, number> = { ok: 0, off: 1, warn: 2, bad: 3 }
/** tom de uso (lib/radial) → tom deste popover */
const TONE_OF: Record<MeterTone, Tone> = { phos: 'ok', warn: 'warn', alert: 'bad', amber: 'off', cyanic: 'ok' }
// Mesma regra de cor dos medidores (lib/radial.ts): verde = normal, laranja
// (--color-warn) = atenção ≥80%, vermelho = crítico ≥90%.
const DOT: Record<Tone, string> = {
  ok: 'bg-phos shadow-[0_0_6px_var(--color-phos)]',
  warn: 'bg-warn hc-pulse-dot',
  bad: 'bg-alert hc-pulse-dot',
  off: 'bg-faint',
}
const VALUE_INK: Record<Tone, string> = {
  ok: 'text-dim',
  warn: 'text-warn',
  bad: 'text-alert',
  off: 'text-dim',
}

interface Row {
  id: string
  icon: IconName
  label: string
  tone: Tone
  value: ReactNode
  detail: string
  windows?: Array<{ key: string; prov: string; label: string; pct: number; reset: string | null; kind: string }>
}

/**
 * "Status center" da topbar: um único botão com o pior estado agregado
 * (serve local, host executor, Telegram, cota) + gasto do mês; o popover
 * detalha cada fonte e traz o auto mode. Fonte que falha = linha de erro.
 */
export function StatusCenter({ connState }: { connState: ConnState }) {
  // Métricas do host: coleta local do main (multiplataforma). O plugin cockpit
  // (/sistema) é opcional e só acrescenta o estado do gateway — 404 dele não
  // vira erro nesta linha.
  const sys = useAsync<SystemInfo>(ops.system, [], 30_000)
  const plugin = usePluginSource<Sistema>(API.sistema, 60_000)
  const quota = useQuota(60_000)
  const auto = useAutoMode()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const ws: Row = {
    id: 'ws',
    icon: 'wifi',
    label: 'serve local',
    ...(connState === 'open'
      ? { tone: 'ok' as Tone, value: 'aberto', detail: 'WebSocket do hermes serve local (127.0.0.1) — não mede a VPS' }
      : connState === 'connecting' || connState === 'idle'
        ? { tone: 'warn' as Tone, value: 'conectando', detail: 'conectando ao hermes serve…' }
        : { tone: 'bad' as Tone, value: connState, detail: `WebSocket ${connState} — reconectando com backoff` }),
  }
  const s = sys.data
  const gw = plugin.error ? null : plugin.data?.gateway
  // Tom da linha segue o que ela MOSTRA (CPU/RAM). Volume quase cheio não é
  // carga do momento: entra no detalhe, não deixa o ponto vermelho para sempre.
  const worstUse = s ? Math.max(s.cpu.pct, s.mem.pct) : -1
  const fullVol = s ? [...s.volumes].sort((a, b) => b.pct - a.pct)[0] : undefined
  const mac: Row = {
    id: 'mac',
    icon: 'cpu',
    label: `${HOST_LABEL} executor`,
    ...(!s
      ? sys.error
        ? { tone: 'bad' as Tone, value: 'erro', detail: `ops:system: ${sys.error}` }
        : { tone: 'off' as Tone, value: '…', detail: 'coletando métricas do host' }
      : {
          // mesmos limiares dos donuts, sobre a % ARREDONDADA que a linha mostra
          tone: TONE_OF[displayTone(worstUse)],
          value: `CPU ${pct(s.cpu.pct)} · RAM ${pct(s.mem.pct)}`,
          detail: [
            `${s.hostname} · ${s.osVersion} · no ar há ${fmtUptime(s.uptimeSec)}`,
            fullVol && fullVol.pct >= 90 ? `${fullVol.id} em ${Math.round(fullVol.pct)}%` : null,
            gw ? `gateway ${gw.code_version ?? 'on'} pid ${gw.pid ?? '?'}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }),
  }
  const tg: Row = {
    id: 'tg',
    icon: 'telegram',
    label: 'Telegram',
    tone: 'off',
    value: 'sem fonte',
    detail: 'o plugin cockpit ainda não expõe o estado do Telegram (plataformas do gateway)',
  }
  const q = quota.plugin
  const spend =
    typeof q?.gasto_brl === 'number' && typeof q.budget_brl === 'number' && q.budget_brl > 0 ? (q.gasto_brl / q.budget_brl) * 100 : null
  // Pior janela entre TODOS os provedores (Claude/Codex do main + plugin).
  const worstProv = snapshotWorstPct(quota.providers) ?? -1
  const cota: Row = {
    id: 'quota',
    icon: 'money',
    label: 'Cota dos provedores',
    ...(quota.providers.length === 0
      ? quota.error
        ? { tone: 'bad' as Tone, value: 'erro', detail: `cota: ${quota.error}` }
        : quota.loading
          ? { tone: 'off' as Tone, value: '…', detail: 'coletando cota dos provedores' }
          : { tone: 'off' as Tone, value: 's/ fonte', detail: 'nenhum provedor de IA autenticado nesta máquina' }
      : {
          tone: ((spend ?? 0) >= 90 || worstProv >= 90 ? 'bad' : (spend ?? 0) >= 80 || worstProv >= 80 ? 'warn' : 'ok') as Tone,
          value: worstProv >= 0 ? `${Math.round(worstProv)}%` : '—',
          detail: [
            q?.gasto_brl != null ? `mês R$ ${q.gasto_brl.toFixed(0)}` : null,
            `${quota.providers.length} provedor(es): ${quota.providers.map((p) => p.label).join(', ')}`,
          ]
            .filter(Boolean)
            .join(' · '),
          windows: quota.providers.flatMap((p) =>
            p.windows.map((w, i) => ({ key: `${p.provider}-${w.kind}-${i}`, prov: p.label, label: w.label, pct: w.usedPct, reset: w.resetsAt, kind: w.kind })),
          ),
        }),
  }
  const rows = [ws, mac, tg, cota]
  const worst = rows.reduce<Tone>((w, r) => (RANK[r.tone] > RANK[w] ? r.tone : w), 'ok')

  return (
    <div ref={box} className="no-drag relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={rows.map((r) => `${r.label}: ${r.value}`).join('\n')}
        className={cx(
          'hc-press flex h-7 items-center gap-2 rounded-md border px-2 text-[11px] whitespace-nowrap',
          open ? 'border-edge2 bg-panel2 text-ink' : 'border-transparent text-dim hover:border-edge2 hover:bg-hover/60 hover:text-ink',
        )}
      >
        <span className="flex items-center gap-[3px]" aria-hidden>
          {rows.map((r) => (
            <span key={r.id} className={cx('h-1.5 w-1.5 rounded-full transition-colors duration-[var(--hc-dur-3)]', DOT[r.tone])} />
          ))}
        </span>
        <span className={cx('hc-pill-label tabular-nums', cota.tone === 'bad' ? 'text-alert' : cota.tone === 'warn' && 'text-warn')}>
          {quota.providers.length > 0 ? cota.value : 'status'}
        </span>
        {auto && (
          <span className="flex items-center gap-1 rounded-sm bg-phos/10 px-1 text-[9px] font-semibold tracking-[0.14em] text-phos uppercase">
            <Icon name="auto" size={10} />
            auto
          </span>
        )}
        <Icon name="chevronDown" size={11} className={cx('text-faint transition-transform duration-[var(--hc-dur-2)]', open && 'rotate-180')} />
        <span className="sr-only">status geral: {worst}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Status" className="hc-glass hc-pop absolute top-9 right-0 z-40 w-[300px] rounded-lg p-1.5">
          <div className="label px-2 pt-1 pb-1.5">status</div>
          <ul className="hc-stagger">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover/60" title={r.detail}>
                <Icon name={r.icon} size={13} className="mt-[1px] text-faint" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-ink">{r.label}</span>
                    <span className={cx('ml-auto h-1.5 w-1.5 shrink-0 rounded-full', DOT[r.tone])} />
                    <span className={cx('shrink-0 tabular-nums', VALUE_INK[r.tone])}>{r.value}</span>
                  </div>
                  <div className="truncate text-[10px] text-faint">{r.detail}</div>
                  {r.windows && r.windows.length > 0 && (
                    <ul className="mt-1 space-y-0.5" aria-label="janelas de uso por provedor">
                      {r.windows.map((w) => {
                        const rs = fmtResetParts(w.reset)
                        return (
                          <li key={w.key} className="flex items-baseline gap-1.5 text-[10px]" title={rs ? `reinicia em ${rs.in} (${rs.at})` : undefined}>
                            <span className="min-w-0 flex-1 truncate text-dim">
                              {w.prov} · {w.label}
                            </span>
                            {rs && <span className="shrink-0 text-[9px] text-faint">{w.kind === '5h' ? `em ${rs.in}` : rs.at}</span>}
                            <span className="w-8 shrink-0 text-right tabular-nums" style={{ color: TONE_VAR[pctTone(w.pct)] }}>
                              {Math.round(w.pct)}%
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  {r.id === 'quota' && spend != null && (
                    <div className="mt-1">
                      <Bar pct={spend} tone="amber" />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-1 border-t border-edge px-2 pt-2 pb-1">
            <button
              type="button"
              onClick={() => void setAutoMode(!auto)}
              className={cx(
                'hc-press flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[11px]',
                auto ? 'border-phos/50 bg-phos/10 text-phos' : 'border-edge2 text-dim hover:text-ink',
              )}
              title={
                auto
                  ? 'Auto mode LIGADO — Hermes aprova via guardian (smart) e o swarm usa --permission-mode auto.'
                  : 'Auto mode desligado — aprovações manuais no cockpit.'
              }
            >
              <Icon name="auto" size={13} />
              <span className="flex-1">Auto mode {auto ? 'ligado' : 'desligado'}</span>
              <span
                aria-hidden
                className={cx(
                  'relative h-3.5 w-6 rounded-full border transition-colors',
                  auto ? 'border-phos/60 bg-phos/30' : 'border-edge2 bg-void',
                )}
              >
                <span
                  className={cx(
                    'absolute top-[1px] h-2.5 w-2.5 rounded-full transition-[left,background-color] duration-[var(--hc-dur-2)] ease-[var(--hc-ease-spring)]',
                    auto ? 'left-[11px] bg-phos' : 'left-[1px] bg-faint',
                  )}
                />
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function pct(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : '—'
}
