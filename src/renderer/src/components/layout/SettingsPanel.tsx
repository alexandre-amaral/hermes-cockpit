import { useEffect, useState } from 'react'
import type { ViewId } from '../../lib/layout'
import {
  LAYOUT_PRESETS,
  PANELS,
  PANEL_BY_ID,
  REGION_LABELS,
  movePanel,
  togglePanel,
  type Region,
  type RegionLayout,
} from '../../lib/panels'
import {
  DEFAULT_THEME,
  FONTS,
  PRESETS,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_STEP,
  clampScale,
  type FontId,
  type ThemePreset,
  type ThemeSettings,
} from '../../lib/theme'
import { SPACES, type Space } from '../../lib/space'
import { Icon } from '../ui/Icon'
import { VIEW_BY_ID } from './views'

export type SettingsTab = 'aparencia' | 'views' | 'paineis'

interface Props {
  theme: ThemeSettings
  onTheme: (t: ThemeSettings) => void
  regions: RegionLayout
  onRegions: (r: RegionLayout) => void
  onResetRegions: () => void
  onResetSizes: () => void
  onClose: () => void
  initialTab?: SettingsTab
  /** espaço ativo (views, painéis e presets valem só para ele) */
  space: Space
  viewOrder: ViewId[]
  hiddenViews: ViewId[]
  onViews: (order: ViewId[], hidden: ViewId[]) => void
  onPreset: (id: string) => void
}

const PRESET_SWATCH: Record<ThemePreset, [string, string]> = {
  grafite: ['#101318', '#e8a33d'],
  fosforo: ['#0c120e', '#7ee787'],
  ambar: ['#140f09', '#ffb547'],
  claro: ['#ffffff', '#b86e00'],
}

// Painel de configurações (⚙ na topbar / ⌘,): tema, accent, fonte, escala
// (densidade) e layout dos painéis por região. Tudo aplica ao vivo.
export function SettingsPanel(p: Props) {
  const [tab, setTab] = useState<SettingsTab>(p.initialTab ?? 'aparencia')
  const spaceLabel = SPACES.find((x) => x.id === p.space)?.label ?? p.space
  const t = p.theme
  const set = (patch: Partial<ThemeSettings>) => p.onTheme({ ...t, ...patch })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])

  return (
    <div className="no-drag hc-scrim fixed inset-0 z-50 flex justify-end" onMouseDown={p.onClose}>
      <div
        role="dialog"
        aria-label="Configurações"
        className="hc-slide-right flex h-full w-[min(380px,100vw)] flex-col border-l border-edge2 bg-panel shadow-[var(--hc-shadow-3)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
          <Icon name="settings" size={13} className="text-space" />
          <span className="label">Configurações</span>
          <button
            type="button"
            onClick={p.onClose}
            className="hc-press ml-auto flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-ink"
            aria-label="fechar"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
        <div className="flex gap-1 border-b border-edge px-3 pt-2">
          {(
            [
              ['aparencia', 'Aparência'],
              ['views', 'Views'],
              ['paineis', 'Painéis'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`-mb-px rounded-t-md border px-3 py-1.5 text-[11px] ${
                tab === id ? 'border-edge2 border-b-panel2 bg-panel2 text-ink' : 'border-transparent text-faint hover:text-dim'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-[12px]">
          {tab === 'aparencia' ? (
            <>
              <Section titulo="Tema">
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(PRESETS) as ThemePreset[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => set({ preset: id })}
                      className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left ${
                        t.preset === id ? 'border-amber text-ink' : 'border-edge2 text-dim hover:text-ink'
                      }`}
                    >
                      <span
                        className="h-4 w-4 rounded-sm border border-edge2"
                        style={{
                          background: `linear-gradient(135deg, ${PRESET_SWATCH[id][0]} 55%, ${PRESET_SWATCH[id][1]} 55%)`,
                        }}
                      />
                      {PRESETS[id].label}
                    </button>
                  ))}
                </div>
              </Section>

              <Section titulo="Accent">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={t.accent ?? '#e8a33d'}
                    onChange={(e) => set({ accent: e.target.value })}
                    className="h-7 w-10 cursor-pointer rounded border border-edge2 bg-transparent"
                    aria-label="cor de acento"
                  />
                  <span className="text-dim">{t.accent ?? 'do tema'}</span>
                  {t.accent && (
                    <button type="button" onClick={() => set({ accent: null })} className="ml-auto text-[11px] text-faint hover:text-ink">
                      usar a do tema
                    </button>
                  )}
                </div>
              </Section>

              <Section titulo="Fonte">
                <select
                  value={t.font}
                  onChange={(e) => set({ font: e.target.value as FontId })}
                  className="w-full rounded border border-edge2 bg-void px-2 py-1.5 text-ink focus:border-amber focus:outline-none"
                >
                  {(Object.keys(FONTS) as FontId[]).map((id) => (
                    <option key={id} value={id}>
                      {FONTS[id].label}
                    </option>
                  ))}
                </select>
              </Section>

              <Section titulo={`Escala / densidade · ${t.scale}%`}>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => set({ scale: clampScale(t.scale - SCALE_STEP) })}
                    className="rounded border border-edge2 px-2 text-dim hover:text-ink"
                    aria-label="diminuir escala"
                  >
                    −
                  </button>
                  <input
                    type="range"
                    min={SCALE_MIN}
                    max={SCALE_MAX}
                    step={SCALE_STEP}
                    value={t.scale}
                    onChange={(e) => set({ scale: clampScale(Number(e.target.value)) })}
                    className="flex-1 accent-amber"
                    aria-label="escala da interface"
                  />
                  <button
                    type="button"
                    onClick={() => set({ scale: clampScale(t.scale + SCALE_STEP) })}
                    className="rounded border border-edge2 px-2 text-dim hover:text-ink"
                    aria-label="aumentar escala"
                  >
                    +
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-faint">atalhos: ⌘= aumenta · ⌘- diminui · ⌘0 volta a 100%</p>
              </Section>

              <button
                type="button"
                onClick={() => p.onTheme(DEFAULT_THEME)}
                className="rounded border border-edge2 px-3 py-1.5 text-[11px] text-dim hover:text-ink"
              >
                Restaurar aparência padrão
              </button>
            </>
          ) : tab === 'views' ? (
            <ViewsEditor space={spaceLabel} order={p.viewOrder} hidden={p.hiddenViews} onChange={p.onViews} />
          ) : (
            <>
              <Section titulo={`Presets · espaço ${spaceLabel}`}>
                <div className="hc-stagger grid gap-1.5">
                  {LAYOUT_PRESETS.map((pr) => (
                    <button
                      key={pr.id}
                      type="button"
                      onClick={() => p.onPreset(pr.id)}
                      className="hc-card hc-card-hover flex items-start gap-2.5 px-3 py-2 text-left"
                    >
                      <Icon name={pr.icon} size={14} className="mt-[1px] text-space" />
                      <span className="min-w-0">
                        <span className="block text-[12px] text-ink">{pr.label}</span>
                        <span className="block text-[10px] leading-snug text-faint">{pr.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[10px] text-faint">aplicar troca a view, os painéis abertos e os blocos das regiões só deste espaço.</p>
              </Section>
              {(Object.keys(REGION_LABELS) as Region[]).map((region) => (
                <RegionEditor
                  key={region}
                  region={region}
                  regions={p.regions}
                  onRegions={p.onRegions}
                />
              ))}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={p.onResetRegions}
                  className="rounded border border-edge2 px-3 py-1.5 text-[11px] text-dim hover:text-ink"
                  title={`volta os blocos das regiões ao padrão do espaço ${spaceLabel}`}
                >
                  Restaurar painéis padrão
                </button>
                <button
                  type="button"
                  onClick={p.onResetSizes}
                  className="rounded border border-edge2 px-3 py-1.5 text-[11px] text-dim hover:text-ink"
                >
                  Restaurar tamanhos
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ViewsEditor({
  space,
  order,
  hidden,
  onChange,
}: {
  space: string
  order: ViewId[]
  hidden: ViewId[]
  onChange: (order: ViewId[], hidden: ViewId[]) => void
}) {
  const visibleCount = order.filter((v) => !hidden.includes(v)).length
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next, hidden)
  }
  let n = 0
  return (
    <Section titulo={`Views da barra · espaço ${space}`}>
      <ul className="hc-stagger space-y-1">
        {order.map((id, i) => {
          const v = VIEW_BY_ID[id]
          const off = hidden.includes(id)
          const key = off ? null : ++n
          return (
            <li key={id} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${off ? 'border-edge/60 text-faint' : 'border-edge text-ink'}`}>
              <Icon name={v.icon} size={13} className={off ? 'text-faint' : 'text-space'} />
              <span className="min-w-0 flex-1 truncate">{v.label}</span>
              {key != null && key <= 9 && <span className="text-[10px] text-faint tabular-nums">⌘{key}</span>}
              <button
                type="button"
                onClick={() => onChange(order, off ? hidden.filter((x) => x !== id) : [...hidden, id])}
                disabled={!off && visibleCount <= 1}
                className="hc-press flex h-5 w-5 items-center justify-center rounded text-faint enabled:hover:text-ink disabled:opacity-30"
                aria-label={off ? `mostrar ${v.label}` : `esconder ${v.label}`}
                title={off ? 'mostrar na barra' : 'esconder da barra (continua no ⌘K)'}
              >
                <Icon name={off ? 'eyeOff' : 'eye'} size={12} />
              </button>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                className="px-1 text-faint enabled:hover:text-ink disabled:opacity-30"
                aria-label="mover para antes"
              >
                ↑
              </button>
              <button
                type="button"
                disabled={i === order.length - 1}
                onClick={() => move(i, 1)}
                className="px-1 text-faint enabled:hover:text-ink disabled:opacity-30"
                aria-label="mover para depois"
              >
                ↓
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-2 text-[10px] leading-relaxed text-faint">
        dica: arraste as abas na topbar para reordenar. ⌘1..⌘{Math.min(9, visibleCount)} seguem a ordem das visíveis.
      </p>
      <button
        type="button"
        onClick={() => onChange([...VIEW_ORDER_DEFAULT], [])}
        className="mt-2 rounded border border-edge2 px-3 py-1.5 text-[11px] text-dim hover:text-ink"
      >
        Restaurar views padrão
      </button>
    </Section>
  )
}

const VIEW_ORDER_DEFAULT = Object.keys(VIEW_BY_ID) as ViewId[]

function Section({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="label mb-2">{titulo}</div>
      {children}
    </section>
  )
}

function RegionEditor({
  region,
  regions,
  onRegions,
}: {
  region: Region
  regions: RegionLayout
  onRegions: (r: RegionLayout) => void
}) {
  const active = regions[region]
  const inactive = PANELS.filter((def) => !active.includes(def.id))
  return (
    <Section titulo={REGION_LABELS[region]}>
      <ul className="space-y-1">
        {active.map((id, i) => {
          const def = PANEL_BY_ID[id]
          if (!def) return null
          return (
            <li key={id} className="flex items-center gap-2 rounded border border-edge px-2 py-1">
              <input
                type="checkbox"
                checked
                onChange={() => onRegions(togglePanel(regions, region, id))}
                className="accent-amber"
                aria-label={`remover ${def.titulo}`}
              />
              {def.icon && <Icon name={def.icon} size={12} className="text-space" />}
              <span className="min-w-0 flex-1 truncate text-ink" title={def.descricao}>{def.titulo}</span>
              <span className="max-w-[90px] truncate text-[10px] text-faint">{def.fonte.join(' ') || 'sem fonte'}</span>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => onRegions(movePanel(regions, region, id, -1))}
                className="px-1 text-faint enabled:hover:text-ink disabled:opacity-30"
                aria-label="mover para antes"
              >
                ↑
              </button>
              <button
                type="button"
                disabled={i === active.length - 1}
                onClick={() => onRegions(movePanel(regions, region, id, 1))}
                className="px-1 text-faint enabled:hover:text-ink disabled:opacity-30"
                aria-label="mover para depois"
              >
                ↓
              </button>
            </li>
          )
        })}
        {inactive.map((def) => (
          <li key={def.id} className="flex items-center gap-2 px-2 py-1 text-dim">
            <input
              type="checkbox"
              checked={false}
              onChange={() => onRegions(togglePanel(regions, region, def.id))}
              className="accent-amber"
              aria-label={`adicionar ${def.titulo}`}
            />
            <span className="min-w-0 flex-1 truncate" title={def.descricao}>{def.titulo}</span>
            <span className="max-w-[90px] truncate text-[10px] text-faint">{def.fonte.join(' ') || 'sem fonte'}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}
