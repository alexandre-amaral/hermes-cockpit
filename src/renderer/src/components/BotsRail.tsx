import { GROUP_LABELS, GROUP_ORDER, botTitle, type BotProfile } from '../lib/bots'
import type { ReactNode } from 'react'
import { Group, Panel, useDefaultLayout } from 'react-resizable-panels'
import { safeStorage } from '../lib/layout'
import { SPACES, type Space } from '../lib/space'
import { ResizeHandle } from './layout/ResizeHandle'
import { EmptyState } from './ui/EmptyState'
import { Icon } from './ui/Icon'
import { Skeleton } from './ui/Skeleton'
import { cx } from './ui/cx'

interface Props {
  bots: BotProfile[]
  selected: string | null
  onSelect: (name: string) => void
  loading: boolean
  /** mensagem quando profiles.list e /bots falharam */
  error?: string | null
  /** rodapé editável (região "rail" do registry) */
  footer?: ReactNode
  /** espaço ativo (os bots já chegam filtrados) */
  space?: Space
  /** quantos bots ficaram fora por causa do espaço */
  hiddenCount?: number
}

// Rail de bots como no wireframe: seções por grupo, item ativo com borda e
// losango âmbar, "rodando" em verde, contador de sessões; rodapé com cota por
// provedor (/quota do plugin). SWARM CODERS fica fora até existir fonte real
// de subagents (P2-15) — sem chips inventados.
export function BotsRail({ bots, selected, onSelect, loading, error, footer, space = 'tudo', hiddenCount = 0 }: Props) {
  const layout = useDefaultLayout({ id: 'hc-rail', storage: safeStorage, onlySaveAfterUserInteractions: true })
  const byGroup = new Map<string, BotProfile[]>()
  for (const bot of bots) {
    const arr = byGroup.get(bot.group) ?? []
    arr.push(bot)
    byGroup.set(bot.group, arr)
  }

  let n = 0
  return (
    <aside className="flex h-full min-w-0 flex-col bg-sidebar">
      <Group
        id="hc-rail"
        orientation="vertical"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <Panel id="rail-bots" minSize={120}>
          <div className="h-full overflow-y-auto px-3 pt-3 pb-2">
            <div className="mb-3 flex items-center gap-2 px-1">
              <Icon name="bot" size={12} className="text-space" />
              <span className="label !text-dim">Bots</span>
              <span className="label ml-auto !tracking-[0.12em]" title={SPACES.find((x) => x.id === space)?.hint}>
                {SPACES.find((x) => x.id === space)?.label}
                {hiddenCount > 0 && <span className="text-faint"> · +{hiddenCount} fora</span>}
              </span>
            </div>
            {loading && bots.length === 0 && <RailSkeleton />}
            {!loading && bots.length === 0 && (
              <EmptyState
                compact
                tone={error ? 'error' : 'neutral'}
                icon={<Icon name={error ? 'alert' : 'bot'} size={14} />}
                title={error ? 'bots indisponíveis' : hiddenCount > 0 ? 'nenhum bot neste espaço' : 'nenhum bot'}
                detail={error ?? (hiddenCount > 0 ? `${hiddenCount} bot(s) em outros espaços — troque de espaço (⌘⇧1/2/3)` : 'profiles.list não retornou profiles')}
              />
            )}
            {GROUP_ORDER.map((group) => {
              const items = byGroup.get(group)
              if (!items?.length) return null
              return (
                <div key={group} className="mb-4">
                  <div className="label flex items-center gap-2 px-1 pb-1.5">
                    <span>{GROUP_LABELS[group] ?? group}</span>
                    <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-edge to-transparent" />
                  </div>
                  <div className="space-y-0.5">
                    {items.map((bot) => (
                      <BotItem key={bot.name} bot={bot} active={bot.name === selected} onSelect={onSelect} delay={(n++) * 22} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </Panel>
        <ResizeHandle orientation="vertical" title="arraste para redimensionar o rodapé" />
        <Panel id="rail-footer" defaultSize={190} minSize={36}>
          <div className="h-full border-t border-edge">{footer}</div>
        </Panel>
      </Group>
    </aside>
  )
}

function RailSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="carregando bots">
      {[3, 3, 2].map((count, g) => (
        <div key={g}>
          <Skeleton className="mb-2 ml-1 h-2 w-20" />
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="flex items-center gap-2.5 px-2.5 py-1.5">
              <Skeleton className="h-2 w-2 rounded-full" />
              <Skeleton className={i % 2 ? 'h-2.5 w-16' : 'h-2.5 w-24'} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function BotItem({
  bot,
  active,
  onSelect,
  delay,
}: {
  bot: BotProfile
  active: boolean
  onSelect: (n: string) => void
  delay: number
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(bot.name)}
      aria-current={active ? 'true' : undefined}
      data-active={active || undefined}
      title={[bot.descricao, bot.modelo && `modelo: ${bot.modelo}`, bot.rodando && 'rodando agora'].filter(Boolean).join('\n') || undefined}
      style={{ animationDelay: `${delay}ms` }}
      className={cx(
        'hc-rail-item hc-rise hc-press group flex w-full items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left text-[12px]',
        active
          ? 'hc-edge-active border-transparent bg-sel text-sel-ink shadow-[var(--hc-shadow-1)]'
          : 'border-transparent text-dim hover:translate-x-0.5 hover:bg-hover/60 hover:text-ink',
      )}
    >
      {active ? (
        <span className="h-2 w-2 shrink-0 rotate-45 bg-space shadow-[0_0_8px_var(--color-space)] transition-transform duration-[var(--hc-dur-3)] group-hover:rotate-[135deg]" aria-hidden />
      ) : bot.rodando ? (
        <span className="hc-pulse-dot h-2 w-2 shrink-0 rounded-full bg-phos" aria-hidden />
      ) : (
        <span className="h-2 w-2 shrink-0 rounded-full border border-faint transition-colors group-hover:border-dim" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{botTitle(bot.name)}</span>
      {bot.rodando && (
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-phos">
          {active && <span className="hc-pulse-dot h-1.5 w-1.5 rounded-full bg-phos" aria-hidden />}
          rodando
        </span>
      )}
      {bot.sessoes != null && (
        <span
          className={cx(
            'shrink-0 rounded px-1 text-[10px] tabular-nums transition-colors',
            active ? 'bg-void/50 text-dim' : 'text-faint group-hover:text-dim',
          )}
          title="sessões"
        >
          {bot.sessoes}
        </span>
      )}
    </button>
  )
}
