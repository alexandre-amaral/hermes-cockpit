import { useEffect, useRef, useState } from 'react'
import { Group, Panel, useDefaultLayout } from 'react-resizable-panels'
import { safeStorage } from '../../lib/layout'
import { PANELS, PANEL_BY_ID, type Region } from '../../lib/panels'
import { ErrorBoundary } from '../ErrorBoundary'
import { ResizeHandle } from '../layout/ResizeHandle'
import { Icon } from '../ui/Icon'

// Região editável de blocos do registry (strip, cards do dock, rodapé da rail).
// - cada bloco vira um Panel redimensionável, com alça entre vizinhos;
// - hover no bloco mostra a barrinha ◂ ▸ × (mover / esconder);
// - "+" no canto da região adiciona um bloco escondido de volta.
// Tamanhos ficam salvos por combinação de blocos: esconder e reexibir um bloco
// volta ao layout que aquela combinação tinha.

export const REGION_GROUP_PREFIX = 'hc-region-'

interface Props {
  region: Region
  ids: string[]
  orientation: 'horizontal' | 'vertical'
  /** tamanho mínimo de cada bloco (px) */
  minPx: number
  onChange: (ids: string[]) => void
  className?: string
  emptyText?: string
}

export function RegionView({ region, ids, orientation, minPx, onChange, className = '', emptyText }: Props) {
  const defs = ids.map((id) => PANEL_BY_ID[id]).filter(Boolean)
  const groupId = `${REGION_GROUP_PREFIX}${region}:${defs.map((d) => d.id).join('+')}`
  const layout = useDefaultLayout({ id: groupId, storage: safeStorage, onlySaveAfterUserInteractions: true })
  const horizontal = orientation === 'horizontal'

  const hide = (id: string) => onChange(ids.filter((x) => x !== id))
  const move = (id: string, d: -1 | 1) => {
    const list = [...ids]
    const i = list.indexOf(id)
    const j = i + d
    if (i < 0 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    onChange(list)
  }
  const hidden = PANELS.filter((p) => !ids.includes(p.id))

  return (
    <div className={`group/region relative h-full min-h-0 w-full min-w-0 ${className}`}>
      {defs.length === 0 ? (
        <div className="px-4 py-3 text-[11px] text-faint">{emptyText ?? 'região vazia — use + para adicionar um bloco.'}</div>
      ) : (
        // key: a combinação de blocos mudou → remonta e restaura o layout salvo dela
        <Group
          key={groupId}
          id={groupId}
          orientation={orientation}
          className="h-full w-full"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
        >
          {defs.map((def, i) => {
            const C = def.componente
            return [
              i > 0 && <ResizeHandle key={`sep-${def.id}`} orientation={orientation} title="arraste para redimensionar" />,
              <Panel key={def.id} id={def.id} minSize={minPx}>
                <div className="group/block relative h-full min-h-0 min-w-0">
                  <ErrorBoundary label={def.titulo}>
                    <C refreshMs={def.refreshMs} />
                  </ErrorBoundary>
                  <BlockToolbar
                    titulo={def.titulo}
                    horizontal={horizontal}
                    canBack={i > 0}
                    canFwd={i < defs.length - 1}
                    onMove={(d) => move(def.id, d)}
                    onHide={() => hide(def.id)}
                  />
                </div>
              </Panel>,
            ]
          })}
        </Group>
      )}
      <AddMenu hidden={hidden} onAdd={(id) => onChange([...ids, id])} alwaysVisible={defs.length === 0} />
    </div>
  )
}

function BlockToolbar({
  titulo,
  horizontal,
  canBack,
  canFwd,
  onMove,
  onHide,
}: {
  titulo: string
  horizontal: boolean
  canBack: boolean
  canFwd: boolean
  onMove: (d: -1 | 1) => void
  onHide: () => void
}) {
  const btn =
    'hc-press flex h-5 w-5 items-center justify-center rounded text-[11px] text-faint hover:bg-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent'
  return (
    <div className="hc-glass pointer-events-none absolute top-1.5 right-1.5 z-10 flex -translate-y-0.5 items-center gap-0.5 rounded-md px-0.5 opacity-0 transition-[opacity,translate] duration-[var(--hc-dur-2)] group-hover/block:pointer-events-auto group-hover/block:translate-y-0 group-hover/block:opacity-100 focus-within:pointer-events-auto focus-within:translate-y-0 focus-within:opacity-100">
      <button type="button" className={btn} disabled={!canBack} onClick={() => onMove(-1)} title="mover para trás">
        <Icon name="chevronRight" size={11} className={horizontal ? 'rotate-180' : '-rotate-90'} />
      </button>
      <button type="button" className={btn} disabled={!canFwd} onClick={() => onMove(1)} title="mover para frente">
        <Icon name="chevronRight" size={11} className={horizontal ? '' : 'rotate-90'} />
      </button>
      <button type="button" className={`${btn} hover:!text-alert`} onClick={onHide} title={`esconder "${titulo}" (volta pelo +)`}>
        <Icon name="close" size={10} />
      </button>
    </div>
  )
}

function AddMenu({
  hidden,
  onAdd,
  alwaysVisible,
}: {
  hidden: typeof PANELS
  onAdd: (id: string) => void
  alwaysVisible: boolean
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  if (!hidden.length) return null
  return (
    <div
      ref={box}
      className={`absolute bottom-1.5 right-1.5 z-20 transition-opacity ${
        alwaysVisible || open ? 'opacity-100' : 'opacity-0 group-hover/region:opacity-100'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="adicionar bloco"
        aria-expanded={open}
        className={`hc-press flex h-5 w-5 items-center justify-center rounded border bg-panel text-[12px] hover:border-space/60 hover:text-space ${
          open ? 'border-space/60 text-space' : 'border-edge2 text-dim'
        }`}
      >
        <Icon name="plus" size={11} className={`transition-transform duration-[var(--hc-dur-2)] ${open ? 'rotate-45' : ''}`} />
      </button>
      {open && (
        <div className="hc-glass hc-pop hc-stagger absolute right-0 bottom-6 max-h-[320px] min-w-[240px] overflow-y-auto rounded-md py-1" role="menu">
          <div className="label px-3 pb-1 pt-0.5">adicionar bloco</div>
          {hidden.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onAdd(p.id)
                setOpen(false)
              }}
              role="menuitem"
              className="group/add flex w-full items-start gap-2 px-3 py-1.5 text-left text-[11px] text-dim transition-colors hover:bg-hover hover:text-ink"
              title={p.descricao}
            >
              <Icon name={p.icon ?? 'plus'} size={12} className="mt-[1px] text-faint group-hover/add:text-space" />
              <span className="min-w-0">
                <span className="block truncate">{p.titulo}</span>
                {p.descricao && <span className="block truncate text-[9.5px] text-faint">{p.descricao}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
