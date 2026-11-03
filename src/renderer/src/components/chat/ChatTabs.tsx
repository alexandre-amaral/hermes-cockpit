import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'

/** Aba do ChatPane. O Bot Chat canônico é fixo (key "canonical", sem storedId — a
 *  identidade dele é o título, resolvida a cada abertura). Side-chats: key "side:<id>". */
export interface ChatTab {
  key: string
  kind: 'canonical' | 'side'
  storedId?: string
  title: string
  /** side-chat recém-criado, ainda sem linha no DB (lazy até o 1º prompt) */
  fresh?: boolean
}

export const CANONICAL_KEY = 'canonical'
export const sideKey = (storedId: string) => `side:${storedId}`

interface Props {
  tabs: ChatTab[]
  activeKey: string
  /** keys com turno em andamento (indicador na aba) */
  streaming: Set<string>
  disabled?: boolean
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onRename: (key: string, title: string) => Promise<void>
  onReorder: (from: string, to: string) => void
  onNew: () => void
  /** fecha várias abas de uma vez (side-chats) */
  onCloseMany?: (keys: string[]) => void
  /** reabre a última aba fechada */
  onReopen?: () => void
  canReopen?: boolean
  /** abre a aba numa janela própria */
  onPopout?: (key: string) => void
}

// Faixa de abas do chat: Bot Chat fixo + side-chats (fechar, renomear com duplo
// clique, arrastar para reordenar, ponto pulsante quando há turno rodando).
export function ChatTabs({
  tabs,
  activeKey,
  streaming,
  disabled,
  onSelect,
  onClose,
  onRename,
  onReorder,
  onNew,
  onCloseMany,
  onReopen,
  canReopen,
  onPopout,
}: Props) {
  const [menu, setMenu] = useState<{ key: string | null; x: number; y: number; list?: boolean } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])
  const sides = tabs.filter((t) => t.kind === 'side').map((t) => t.key)
  const menuItems = (key: string | null): Array<{ label: string; run: () => void; off?: boolean; tab?: ChatTab }> => {
    const idx = key ? tabs.findIndex((t) => t.key === key) : -1
    const isSide = key ? key !== tabs[0]?.key && tabs[idx]?.kind === 'side' : false
    return [
      { label: 'Novo side-chat  ⌘T', run: onNew },
      ...(key && onPopout ? [{ label: 'Abrir em nova janela', run: () => onPopout(key) }] : []),
      ...(key && isSide ? [{ label: 'Fechar  ⌘⇧W', run: () => onClose(key) }] : []),
      ...(onCloseMany
        ? [
            { label: 'Fechar outras', run: () => onCloseMany(sides.filter((k) => k !== key)), off: sides.filter((k) => k !== key).length === 0 },
            ...(key ? [{ label: 'Fechar à direita', run: () => onCloseMany(tabs.slice(idx + 1).filter((t) => t.kind === 'side').map((t) => t.key)), off: !tabs.slice(idx + 1).some((t) => t.kind === 'side') }] : []),
            { label: 'Fechar todas', run: () => onCloseMany(sides), off: sides.length === 0 },
          ]
        : []),
      ...(onReopen ? [{ label: 'Reabrir fechada  ⌘⇧T', run: onReopen, off: !canReopen }] : []),
      // lista de abas (overflow): só no menu do botão ⋯
      ...(menu?.list ? tabs.map((t) => ({ label: t.kind === 'side' ? t.title : 'Bot Chat', run: () => onSelect(t.key), tab: t, off: disabled })) : []),
    ]
  }
  const [editing, setEditing] = useState<string | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const strip = useRef<HTMLDivElement>(null)

  // overflow: setas laterais + fade nas bordas quando a faixa não cabe
  const [edges, setEdges] = useState({ left: false, right: false })
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const measure = () => {
      const left = el.scrollLeft > 2
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
      setEdges((p) => (p.left === left && p.right === right ? p : { left, right }))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [tabs.length])
  const nudge = (dir: -1 | 1) => strip.current?.scrollBy({ left: dir * Math.max(160, (strip.current.clientWidth ?? 300) * 0.6), behavior: 'smooth' })

  // aba ativa sempre visível na faixa
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(activeKey)}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeKey, tabs.length])

  const drop = (e: DragEvent, to: string) => {
    e.preventDefault()
    const from = e.dataTransfer.getData('text/x-hc-tab') || dragKey
    setDragKey(null)
    setOverKey(null)
    if (from && from !== to) onReorder(from, to)
  }

  return (
    <div className="relative flex min-w-0 items-stretch border-b border-edge bg-panel/40">
      {edges.left && (
        <button
          type="button"
          onClick={() => nudge(-1)}
          aria-label="rolar abas para a esquerda"
          className="hc-fade-in shrink-0 border-r border-edge px-1.5 text-[11px] text-faint hover:bg-hover hover:text-ink"
        >
          ‹
        </button>
      )}
      <div
        ref={strip}
        role="tablist"
        aria-label="Abas do chat"
        onKeyDown={(e) => {
          // Só quando o foco está na própria aba (não no input de renomear / botão ×).
          const el = e.target as HTMLElement
          const key = el.getAttribute('data-tab')
          if (!key || disabled) return
          const i = tabs.findIndex((t) => t.key === key)
          let next: (typeof tabs)[number] | undefined
          if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length]
          else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length]
          else if (e.key === 'Home') next = tabs[0]
          else if (e.key === 'End') next = tabs[tabs.length - 1]
          else if (e.key === 'Enter' || e.key === ' ') next = tabs[i]
          if (!next) return
          e.preventDefault()
          if (editing !== next.key) onSelect(next.key)
          strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.key)}"]`)?.focus()
        }}
        onWheel={(e) => {
          // roda vertical do mouse rola a faixa na horizontal
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
        }}
        style={{
          maskImage: edges.left || edges.right ? `linear-gradient(to right, ${edges.left ? 'transparent 0, #000 24px' : '#000 0'}, ${edges.right ? '#000 calc(100% - 24px), transparent 100%' : '#000 100%'})` : undefined,
        }}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((t) => {
          const active = t.key === activeKey
          const live = streaming.has(t.key)
          const side = t.kind === 'side'
          return (
            <div
              key={t.key}
              data-tab={t.key}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              draggable={side && editing !== t.key}
              onDragStart={(e) => {
                setDragKey(t.key)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/x-hc-tab', t.key)
              }}
              onDragEnd={() => {
                setDragKey(null)
                setOverKey(null)
              }}
              onDragOver={(e) => {
                if (!side || !dragKey) return
                e.preventDefault()
                if (overKey !== t.key) setOverKey(t.key)
              }}
              onDragLeave={() => overKey === t.key && setOverKey(null)}
              onDrop={(e) => side && drop(e, t.key)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ key: t.key, x: e.clientX, y: e.clientY })
              }}
              onMouseDown={(e) => {
                // botão do meio fecha side-chat (como em navegador)
                if (e.button === 1 && side) {
                  e.preventDefault()
                  onClose(t.key)
                }
              }}
              className={`group relative flex max-w-[220px] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-edge px-3 text-[11.5px] transition-colors ${
                active ? 'bg-void text-ink' : 'text-dim hover:bg-hover/60 hover:text-ink'
              } outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-amber)] ${dragKey === t.key ? 'opacity-40' : ''} ${overKey === t.key ? 'shadow-[inset_2px_0_0_var(--color-amber)]' : ''}`}
              onClick={() => !disabled && editing !== t.key && onSelect(t.key)}
              onDoubleClick={() => side && !disabled && setEditing(t.key)}
              title={side ? `${t.title} — duplo clique renomeia, arraste para reordenar` : 'Bot Chat — chat eterno do bot'}
            >
              {active && <span className="absolute inset-x-0 top-0 h-px bg-amber" />}
              {live ? (
                <span className="hc-pulse-dot inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber" title="turno em andamento" />
              ) : !side ? (
                <span className={`shrink-0 text-[10px] ${active ? 'text-amber' : 'text-faint'}`}>◆</span>
              ) : null}
              {editing === t.key ? (
                <RenameInput
                  initial={t.title}
                  onDone={async (title) => {
                    if (title === null || title === t.title) {
                      setEditing(null)
                      return
                    }
                    try {
                      await onRename(t.key, title)
                      setEditing(null)
                    } catch {
                      // erro já foi notificado (toast); mantém o campo aberto para corrigir
                    }
                  }}
                />
              ) : (
                <span className={`min-w-0 truncate py-1.5 ${side ? '' : 'label tracking-[0.12em]'} ${!side && active ? 'text-amber' : ''}`}>
                  {side ? t.title : 'Bot Chat'}
                </span>
              )}
              {side && editing !== t.key && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(t.key)
                  }}
                  aria-label={`fechar ${t.title}`}
                  className={`-mr-1 shrink-0 rounded px-1 text-[11px] leading-none text-faint hover:bg-edge hover:text-ink ${
                    active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                  }`}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
      </div>
      {edges.right && (
        <button
          type="button"
          onClick={() => nudge(1)}
          aria-label="rolar abas para a direita"
          className="hc-fade-in shrink-0 border-l border-edge px-1.5 text-[11px] text-faint hover:bg-hover hover:text-ink"
        >
          ›
        </button>
      )}
      <button
        onClick={onNew}
        disabled={disabled}
        title="novo side-chat"
        className="shrink-0 border-l border-edge px-2.5 text-[13px] text-faint hover:bg-hover hover:text-phos disabled:opacity-40"
      >
        +
      </button>
      <button
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setMenu(menu ? null : { key: activeKey, x: r.right - 220, y: r.bottom + 2, list: true })
        }}
        title={`gerenciar abas · ${tabs.length} aberta(s)`}
        className="shrink-0 border-l border-edge px-2 text-[13px] text-faint hover:bg-hover hover:text-ink"
      >
        ⋯{tabs.length > 1 && <span className="ml-0.5 align-top font-mono text-[9px] text-faint">{tabs.length}</span>}
      </button>
      {menu && (
        <div
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          style={{ left: Math.max(4, Math.min(menu.x, window.innerWidth - 210)), top: menu.y }}
          className="hc-glass hc-rise fixed z-50 max-h-[70vh] w-[220px] overflow-y-auto rounded-md border border-edge2 py-1 shadow-xl"
        >
          {menuItems(menu.key).map((it, i, all) => {
            const firstTab = it.tab && !all[i - 1]?.tab
            const active = it.tab?.key === activeKey
            return (
              <div key={it.tab ? `tab-${it.tab.key}` : `act-${it.label}`}>
                {firstTab && <div className="label mx-3 mb-0.5 mt-1.5 border-t border-edge pt-1.5 text-[9px]">abas abertas</div>}
                <button
                  role="menuitem"
                  disabled={it.off}
                  onClick={() => {
                    setMenu(null)
                    it.run()
                  }}
                  className={`flex w-full min-w-0 items-center gap-1.5 px-3 py-1 text-left text-[11.5px] hover:bg-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent ${
                    active ? 'text-amber' : 'text-dim'
                  }`}
                >
                  {it.tab && (
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${streaming.has(it.tab.key) ? 'hc-pulse-dot bg-amber' : active ? 'bg-amber' : 'bg-edge2'}`}
                    />
                  )}
                  <span className="min-w-0 truncate">{it.label}</span>
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (title: string | null) => void | Promise<void> }) {
  const [v, setV] = useState(initial)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const inflight = useRef(false)
  const commit = async (value: string | null) => {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    try {
      await onDone(value)
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.key === 'Enter') void commit(v.trim() || null)
    else if (e.key === 'Escape') void commit(null)
  }
  return (
    <input
      ref={ref}
      value={v}
      disabled={busy}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => void commit(v.trim() || null)}
      onClick={(e) => e.stopPropagation()}
      maxLength={100}
      className="my-1 w-36 min-w-0 rounded border border-amber/60 bg-void px-1.5 py-0.5 text-[11.5px] text-ink focus:outline-none"
    />
  )
}
