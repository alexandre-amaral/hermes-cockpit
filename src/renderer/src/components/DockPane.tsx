import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Group, Panel, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { GROUP_IDS, SIZES, safeStorage } from '../lib/layout'
import type { HermesRpc } from '../lib/rpc'
import { DOCK_TAB_EVENT } from '../lib/devtools'
import { HOST_LABEL, HOST_THIS, IS_MAC, PLATFORM } from '../lib/platform'
import { RegionView } from './panels/RegionView'
import { ResizeHandle, useCollapseSync } from './layout/ResizeHandle'
import { SwarmDockTab } from './swarm/SwarmDockTab'
import { WorkspacePicker } from './devtools/WorkspacePicker'
import { TerminalTab } from './devtools/TerminalTab'
import { GitTab } from './devtools/GitTab'
import { FilesTab } from './devtools/FilesTab'
import { PreviewTab } from './devtools/PreviewTab'
import { ScreenTab } from './devtools/ScreenTab'

export const DOCK_TABS = [
  { id: 'terminal', label: 'Terminal', hint: `shell ${IS_MAC ? 'zsh' : 'do sistema'} no workspace ou hermes --tui (xterm.js)`, usesWorkspace: true },
  { id: 'diff', label: 'Diff · Git', hint: 'alterações, diff por arquivo, branches e worktrees', usesWorkspace: true },
  { id: 'arquivos', label: 'Arquivos', hint: 'navegador de arquivos do workspace', usesWorkspace: true },
  { id: 'preview', label: 'Preview', hint: 'app local em iframe', usesWorkspace: false },
  { id: 'swarm', label: 'Swarm', hint: 'execuções do swarm', usesWorkspace: false },
  { id: 'tela', label: PLATFORM ? `Tela ${HOST_LABEL}` : 'Tela', hint: `screenshot da tela ${HOST_THIS}`, usesWorkspace: false },
] as const

export type DockTabId = (typeof DOCK_TABS)[number]['id']

interface Props {
  tab: string
  onTabChange: (id: string) => void
  /** ids do registry de painéis para a área de cards (região "dock") */
  cards: string[]
  onCardsChange: (ids: string[]) => void
  cardsOpen: boolean
  onCardsOpenChange: (open: boolean) => void
  /** conexão RPC (Swarm, profiles do Terminal); opcional */
  rpc?: HermesRpc | null
}

// Dock lateral: seletor de workspace + abas (Terminal, Diff · Git, Arquivos,
// Preview, Swarm, Tela) em cima e cards do registry embaixo, com alça
// vertical redimensionável/colapsável. Abas montam na 1ª visita e ficam
// montadas (ocultas) ao trocar — terminal não perde a sessão.
export function DockPane({ tab, onTabChange, cards, onCardsChange, cardsOpen, onCardsOpenChange, rpc = null }: Props) {
  const current = DOCK_TABS.find((t) => t.id === tab) ?? DOCK_TABS[0]
  const cardsRef = usePanelRef()
  const layout = useDefaultLayout({
    id: GROUP_IDS.dock,
    storage: safeStorage,
    onlySaveAfterUserInteractions: true,
  })
  const wantOpen = useRef(cardsOpen)
  wantOpen.current = cardsOpen
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([current.id]))

  // Sincroniza preferência (botão/atalho) → painel.
  useCollapseSync(cardsRef, cardsOpen)

  useEffect(() => {
    if (!visited.has(current.id)) setVisited((v) => new Set(v).add(current.id))
  }, [current.id, visited])

  // Pedidos de troca de aba vindos de outros módulos (ex.: DiffCard → 'diff').
  const changeRef = useRef(onTabChange)
  changeRef.current = onTabChange
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<unknown>).detail
      if (typeof id === 'string' && DOCK_TABS.some((t) => t.id === id)) changeRef.current(id)
    }
    window.addEventListener(DOCK_TAB_EVENT, on)
    return () => window.removeEventListener(DOCK_TAB_EVENT, on)
  }, [])

  const body = (id: DockTabId, active: boolean): ReactNode => {
    switch (id) {
      case 'terminal':
        return <TerminalTab rpc={rpc} active={active} />
      case 'diff':
        return <GitTab active={active} />
      case 'arquivos':
        return <FilesTab active={active} />
      case 'preview':
        return <PreviewTab active={active} />
      case 'swarm':
        return <SwarmDockTab rpc={rpc} />
      case 'tela':
        return <ScreenTab active={active} />
    }
  }

  return (
    <aside className="flex h-full min-w-0 flex-col bg-panel">
      <div
        className="flex shrink-0 flex-wrap gap-1 border-b border-edge px-2 pt-2"
        role="tablist"
        aria-label="Abas do dock"
        onKeyDown={(e) => {
          // ←/→/Home/End movem a aba selecionada (padrão de ui/Tabs)
          const ids = DOCK_TABS.map((t) => t.id)
          const i = ids.indexOf(current.id)
          let n = -1
          if (e.key === 'ArrowRight') n = (i + 1) % ids.length
          else if (e.key === 'ArrowLeft') n = (i - 1 + ids.length) % ids.length
          else if (e.key === 'Home') n = 0
          else if (e.key === 'End') n = ids.length - 1
          if (n < 0) return
          e.preventDefault()
          onTabChange(ids[n])
          e.currentTarget.querySelector<HTMLElement>(`[data-tab-id="${ids[n]}"]`)?.focus()
        }}
      >
        {DOCK_TABS.map((t) => {
          const on = t.id === current.id
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-tab-id={t.id}
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onTabChange(t.id)}
              className={`-mb-px rounded-t-md border px-3 py-1.5 text-[11px] transition-colors ${
                on
                  ? 'border-edge2 border-b-panel bg-panel2 text-ink'
                  : 'border-transparent text-faint hover:text-dim'
              }`}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      <Group
        id={GROUP_IDS.dock}
        orientation="vertical"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={(l, meta) => {
          layout.onLayoutChanged(l, meta)
          // só arrasto/teclado do usuário muda a preferência (não o mount)
          if (meta.isUserInteraction && l['dock-cards'] !== undefined) {
            const open = l['dock-cards'] > 0.5
            if (open !== wantOpen.current) onCardsOpenChange(open)
          }
        }}
      >
        <Panel id="dock-tabs" minSize={SIZES.dockTabsMin}>
          <div className="flex h-full min-h-0 flex-col">
            {current.usesWorkspace && (
              <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1.5">
                <WorkspacePicker />
              </div>
            )}
            <div className="relative min-h-0 flex-1">
              {DOCK_TABS.filter((t) => visited.has(t.id) || t.id === current.id).map((t) => {
                const on = t.id === current.id
                return (
                  <div
                    key={t.id}
                    role="tabpanel"
                    aria-label={t.label}
                    hidden={!on}
                    className={on ? 'hc-fade-in absolute inset-0 flex min-h-0 flex-col' : 'hidden'}
                  >
                    {body(t.id, on)}
                  </div>
                )
              })}
            </div>
          </div>
        </Panel>
        <ResizeHandle
          orientation="vertical"
          title="arraste para redimensionar · duplo clique para recolher/expandir os cards"
          onToggle={() => onCardsOpenChange(!cardsOpen)}
        />
        <Panel
          id="dock-cards"
          panelRef={cardsRef}
          collapsible
          collapsedSize={0}
          defaultSize={SIZES.dockCards.default}
          minSize={SIZES.dockCards.min}
          groupResizeBehavior="preserve-pixel-size"
        >
          <div className="h-full border-t border-edge">
            <RegionView
              region="dock"
              ids={cards}
              orientation="vertical"
              minPx={72}
              onChange={onCardsChange}
              emptyText="nenhum card aqui — use + para adicionar um bloco."
            />
          </div>
        </Panel>
      </Group>
    </aside>
  )
}
