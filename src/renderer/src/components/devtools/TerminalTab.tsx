import { useEffect, useRef, useState } from 'react'
import type { HermesRpc } from '../../lib/rpc'
import { BOT_GROUPS, parseProfiles } from '../../lib/bots'
import { tildify, useWorkspace } from '../../lib/devtools'
import { XtermView, type PtyStatus } from './XtermView'
import { ConfirmButton, ToolButton } from './ui'

// Aba Terminal: várias sessões (+). Padrão: shell de verdade no workspace do
// dock (relay de PTY no main, ops:shell.*). Opcional: `hermes --tui` de um
// profile via /api/pty do serve. Ver XtermView para os dois transportes.

/** Sentinela interna do shell local (o nome real vem do main, no rodapé). */
const SHELL = 'zsh'
/** Rótulo do shell local: quem escolhe o executável é o main (zsh/git-bash/powershell). */
const SHELL_LABEL = window.hermes?.platform === 'win32' ? 'shell' : 'zsh'

interface Session {
  id: string
  /** SHELL (shell local) ou nome do profile (hermes --tui) */
  profile: string
  cwd?: string | null
  /** comando inicial (ex.: instância do swarm) e rótulo da aba */
  cmd?: string
  label?: string
  generation: number
  status: PtyStatus
  detail?: string
}

/** Pedidos de terminal com comando (ex.: árvore do swarm). Fila porque a aba
 *  Terminal pode ainda não estar montada quando o pedido chega. */
export interface TerminalRequest {
  cwd?: string
  cmd: string
  title?: string
}
const queue: TerminalRequest[] = []
export function requestTerminal(r: TerminalRequest): void {
  queue.push(r)
  window.dispatchEvent(new CustomEvent('hc:dock-tab', { detail: 'terminal' }))
  window.dispatchEvent(new Event('hc:terminal-open'))
}

let seq = 0
const newId = () => `pty-${Date.now().toString(36)}-${++seq}`

export function TerminalTab({ rpc, active }: { rpc?: HermesRpc | null; active: boolean }) {
  const [profiles, setProfiles] = useState<string[]>(() => Object.keys(BOT_GROUPS))
  const [nextProfile, setNextProfile] = useState(SHELL)
  const ws = useWorkspace()
  const [sessions, setSessions] = useState<Session[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const booted = useRef(false)

  // Profiles reais via RPC quando houver conexão; senão, mapa local de bots.
  useEffect(() => {
    if (!rpc) return
    let alive = true
    const load = () => {
      if (!rpc.isOpen()) return
      rpc
        .call('profiles.list')
        .then((r) => {
          const names = parseProfiles(r).map((p) => p.name)
          if (alive && names.length) setProfiles(names)
        })
        .catch(() => {
          /* mantém fallback local */
        })
    }
    load()
    const t = window.setInterval(() => {
      if (alive && rpc.isOpen()) {
        load()
        window.clearInterval(t)
      }
    }, 3000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [rpc])

  const add = (profile = nextProfile) => {
    const s: Session = { id: newId(), profile, cwd: ws.path, generation: 0, status: 'connecting' }
    setSessions((xs) => [...xs, s])
    setCurrent(s.id)
  }

  // Primeira sessão só quando a aba é aberta (não spawna TUI à toa).
  useEffect(() => {
    if (active && !booted.current) {
      booted.current = true
      add()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Instância do swarm aberta "aqui" (árvore → ▣ abrir aqui): nova aba de shell com o comando.
  useEffect(() => {
    const onOpen = () => {
      const reqs = queue.splice(0)
      if (!reqs.length) return
      booted.current = true
      const made = reqs.map(
        (d): Session => ({ id: newId(), profile: SHELL, cwd: d.cwd ?? null, cmd: d.cmd, label: d.title, generation: 0, status: 'connecting' }),
      )
      setSessions((xs) => [...xs, ...made])
      setCurrent(made[made.length - 1]!.id)
    }
    onOpen() // pedidos que chegaram antes de montar
    window.addEventListener('hc:terminal-open', onOpen)
    return () => window.removeEventListener('hc:terminal-open', onOpen)
  }, [])

  const patch = (id: string, p: Partial<Session>) =>
    setSessions((xs) => xs.map((s) => (s.id === id ? { ...s, ...p } : s)))

  const close = (id: string) => {
    const i = sessions.findIndex((s) => s.id === id)
    const rest = sessions.filter((s) => s.id !== id)
    setSessions(rest)
    if (current === id) setCurrent(rest[Math.max(0, i - 1)]?.id ?? null)
  }

  const cur = sessions.find((s) => s.id === current) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-edge px-2 py-1">
        {sessions.map((s, i) => {
          const on = s.id === current
          return (
            <div
              key={s.id}
              className={`group flex shrink-0 items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] ${
                on ? 'border-edge2 bg-sel text-sel-ink' : 'border-transparent text-faint hover:text-dim'
              }`}
            >
              <button type="button" onClick={() => setCurrent(s.id)} className="flex items-center gap-1.5">
                <Dot status={s.status} />
                <span className="max-w-[160px] truncate uppercase tracking-wider">{s.label ?? (s.profile === SHELL ? SHELL_LABEL : `${s.profile} tui`)}</span>
                <span className="text-faint">#{i + 1}</span>
              </button>
              {s.status === 'open' || s.status === 'connecting' ? (
                <CloseLive onClose={() => close(s.id)} />
              ) : (
                <button type="button" title="fechar" onClick={() => close(s.id)} className="text-faint hover:text-alert">
                  ×
                </button>
              )}
            </div>
          )
        })}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <select
            value={nextProfile}
            onChange={(e) => setNextProfile(e.target.value)}
            title="profile do próximo terminal"
            className="rounded border border-edge bg-void px-1 py-0.5 text-[10px] text-dim outline-none"
          >
            <option value={SHELL}>{SHELL_LABEL} (shell local)</option>
            <optgroup label="hermes --tui">
              {profiles.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </optgroup>
          </select>
          <ToolButton title="novo terminal" onClick={() => add()}>
            + novo
          </ToolButton>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {sessions.map((s) => (
          <div key={s.id} className={s.id === current ? 'absolute inset-0' : 'hidden'}>
            <XtermView
              id={s.id}
              kind={s.profile === SHELL ? 'shell' : 'hermes'}
              cwd={s.cwd}
              cmd={s.cmd}
              profile={s.profile === SHELL ? undefined : s.profile}
              generation={s.generation}
              active={active && s.id === current}
              onStatus={(status, detail) => patch(s.id, { status, detail })}
            />
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[11px] text-faint">
            nenhum terminal aberto
            <ToolButton onClick={() => add()}>+ abrir {nextProfile === SHELL ? SHELL_LABEL : `${nextProfile} tui`}</ToolButton>
          </div>
        )}
      </div>

      {cur && (
        <div className="flex shrink-0 items-center gap-2 border-t border-edge px-2 py-1 text-[10px] text-faint">
          <span className="label">pty</span>
          <span className="truncate">
            {cur.profile === SHELL ? `${SHELL_LABEL} · ${cur.cwd ? tildify(cur.cwd) : '~'}` : `hermes --tui · profile ${cur.profile}`} ·{' '}
            {statusLabel(cur.status)}
            {cur.detail ? ` · ${cur.detail}` : ''}
          </span>
          {(cur.status === 'closed' || cur.status === 'error') && (
            <ToolButton tone="amber" onClick={() => patch(cur.id, { generation: cur.generation + 1, status: 'connecting', detail: undefined })}>
              reabrir
            </ToolButton>
          )}
        </div>
      )}
    </div>
  )
}

/** Fechar terminal vivo encerra o processo do PTY → confirmação de 2 cliques. */
function CloseLive({ onClose }: { onClose: () => void }) {
  return (
    <span className="opacity-60 group-hover:opacity-100">
      <ConfirmButton title="fechar encerra o processo do terminal" confirmLabel="encerrar?" onConfirm={onClose}>
        ×
      </ConfirmButton>
    </span>
  )
}

function Dot({ status }: { status: PtyStatus }) {
  const c =
    status === 'open' ? 'bg-phos hc-pulse-dot' : status === 'connecting' ? 'bg-amber' : status === 'error' ? 'bg-alert' : 'bg-faint'
  return <span className={`h-1.5 w-1.5 rounded-full ${c}`} />
}

function statusLabel(s: PtyStatus): string {
  return s === 'open' ? 'conectado' : s === 'connecting' ? 'conectando…' : s === 'error' ? 'erro' : 'encerrado'
}
