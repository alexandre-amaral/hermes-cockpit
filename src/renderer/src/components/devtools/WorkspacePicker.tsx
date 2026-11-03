import { useEffect, useRef, useState } from 'react'
import { inSpace, spaceOfPath, useSpace } from '../../lib/space'
import {
  basename,
  fetchRepos,
  loadDefaultWorkspace,
  setWorkspace,
  tildify,
  useResource,
  useWorkspace,
} from '../../lib/devtools'

// Seletor de workspace/repo no topo do dock, compartilhado por Terminal,
// Diff · Git e Arquivos. Fontes: /api/fs/default-cwd (padrão) e ops:repos
// (lista de repos do host, quando o domínio ops existir). Caminho livre também.

export function WorkspacePicker() {
  const ws = useWorkspace()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const repos = useResource(open ? 'repos' : null, fetchRepos)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (p: string | null) => {
    setWorkspace(p)
    setOpen(false)
  }

  const label = ws.path ? basename(ws.path) : ws.loading ? 'carregando…' : 'sem workspace'
  const space = useSpace()
  const list = (repos.data ?? []).filter((r) => inSpace(spaceOfPath(r.path), space))

  return (
    <div ref={box} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => {
          setDraft(ws.path ?? '')
          setOpen((o) => !o)
        }}
        title={ws.path ? `workspace: ${ws.path}` : ws.error ?? 'escolher workspace'}
        className="flex w-full min-w-0 items-center gap-2 rounded border border-edge bg-void/60 px-2 py-1 text-left text-[11px] hover:border-edge2"
      >
        <span className="label shrink-0 text-faint">ws</span>
        <span className={`truncate ${ws.path ? 'text-ink' : 'text-faint'}`}>{label}</span>
        {ws.path && <span className="hidden truncate text-[10px] text-faint sm:inline">{tildify(ws.path)}</span>}
        {ws.error && !ws.path && <span className="truncate text-[10px] text-alert">erro: {ws.error}</span>}
        <span className="ml-auto shrink-0 text-faint">▾</span>
      </button>

      {open && (
        <div className="hc-rise absolute left-0 right-0 top-full z-30 mt-1 max-h-[60vh] overflow-auto rounded border border-edge2 bg-panel2 p-1 shadow-xl shadow-black/40">
          <form
            className="flex gap-1 p-1"
            onSubmit={(e) => {
              e.preventDefault()
              if (draft.trim().startsWith('/')) pick(draft)
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="/caminho/absoluto"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-edge bg-void px-2 py-1 text-[11px] text-ink outline-none focus:border-amber/60"
            />
            <button type="submit" className="rounded border border-edge px-2 text-[10px] uppercase tracking-wider text-dim hover:text-ink">
              usar
            </button>
          </form>

          <div className="label px-2 pb-1 pt-2 text-faint">padrão do serve</div>
          {ws.defaultPath ? (
            <Row path={ws.defaultPath} sub="/api/fs/default-cwd" active={ws.path === ws.defaultPath} onPick={() => pick(null)} />
          ) : (
            <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-faint">
              {ws.error ? <span className="text-alert">erro: {ws.error}</span> : 'indisponível'}
              <button type="button" onClick={() => void loadDefaultWorkspace(true)} className="text-amber hover:underline">
                recarregar
              </button>
            </div>
          )}

          <div className="label px-2 pb-1 pt-2 text-faint">repositórios (ops:repos)</div>
          {repos.loading && list.length === 0 ? (
            <div className="hc-shimmer px-2 py-1 text-[11px] text-faint">procurando repos…</div>
          ) : repos.error ? (
            <div className="px-2 py-1 text-[11px] text-alert">erro: {repos.error}</div>
          ) : list.length === 0 ? (
            <div className="px-2 py-1 text-[11px] text-faint">nenhum repo listado (domínio ops indisponível ou vazio).</div>
          ) : (
            list.map((r) => (
              <Row
                key={r.path}
                path={r.path}
                name={r.name}
                sub={[r.branch, r.dirty ? `${r.dirty} alterado(s)` : 'limpo', r.ahead ? `↑${r.ahead}` : '', r.behind ? `↓${r.behind}` : '']
                  .filter(Boolean)
                  .join(' · ')}
                dirty={r.dirty > 0}
                active={ws.path === r.path}
                onPick={() => pick(r.path)}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function Row({
  path,
  name,
  sub,
  active,
  dirty,
  onPick,
}: {
  path: string
  name?: string
  sub?: string
  active: boolean
  dirty?: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={path}
      className={`flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-[11px] ${
        active ? 'bg-amber/10 text-amber' : 'text-dim hover:bg-void/60 hover:text-ink'
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dirty ? 'bg-amber' : 'bg-edge2'}`} />
      <span className="shrink-0 text-ink">{name ?? basename(path)}</span>
      <span className="truncate text-[10px] text-faint">{tildify(path)}</span>
      {sub && <span className="ml-auto shrink-0 text-[10px] text-faint">{sub}</span>}
    </button>
  )
}
