import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/ipc'
import { toast } from '../../lib/toast'
import {
  DIFF_FOCUS_EVENT,
  apiPath,
  basename,
  dirname,
  errMsg,
  openIn,
  setWorkspace,
  takeDiffFocus,
  tildify,
  useResource,
  useWorkspace,
  type Branch,
  type GitStatus,
  type ReviewFile,
  type Worktree,
} from '../../lib/devtools'
import { ConfirmButton, DiffView, EmptyState, ErrorState, Loading, StatusLetter, ToolButton } from './ui'

// Aba Diff · Git do workspace ativo. Fontes (hermes_cli/web_routers/git.py):
//   GET  /api/git/status?path              → branch/ahead/behind/contagens (null fora de repo)
//   GET  /api/git/review/list?path&scope   → arquivos com +/- e status
//   GET  /api/git/file-diff?path&file      → diff vs HEAD (staged+unstaged; untracked = all-add)
//   GET  /api/git/review/diff?...scope=branch → diff da branch vs base
//   GET  /api/git/worktrees, /api/git/branches
//   POST /api/git/review/{stage,unstage,revert,commit}
// Revert descarta mudanças → confirmação inline de 2 cliques.

type Scope = 'uncommitted' | 'branch'

export function GitTab({ active }: { active: boolean }) {
  const ws = useWorkspace()
  const root = ws.path
  const [scope, setScope] = useState<Scope>('uncommitted')
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [side, setSide] = useState<'files' | 'worktrees' | 'branches'>('files')

  const live = active && root ? root : null
  const status = useResource<GitStatus | null>(live && `st:${live}`, () => api<GitStatus | null>(apiPath('/api/git/status', { path: live! })), 15_000)
  const isRepo = status.data !== null && status.data !== undefined
  const list = useResource<{ files: ReviewFile[]; base: string | null }>(
    live && isRepo ? `rl:${live}:${scope}` : null,
    () => api(apiPath('/api/git/review/list', { path: live!, scope })),
    15_000,
  )
  const files = useMemo(() => list.data?.files ?? [], [list.data])

  // Mantém seleção válida; escolhe o primeiro arquivo por padrão.
  useEffect(() => {
    if (!files.length) {
      if (sel && list.data) setSel(null)
      return
    }
    if (!sel || !files.some((f) => f.path === sel)) setSel(files[0].path)
  }, [files, sel, list.data])

  // Pedidos externos (DiffCard → "Revisar").
  useEffect(() => {
    const focus = (f: string | null) => {
      if (!f) return
      setScope('uncommitted')
      setSide('files')
      setSel(f)
    }
    focus(takeDiffFocus())
    const on = () => focus(takeDiffFocus())
    window.addEventListener(DIFF_FOCUS_EVENT, on)
    return () => window.removeEventListener(DIFF_FOCUS_EVENT, on)
  }, [])

  const diffKey = live && sel ? `df:${live}:${scope}:${sel}:${list.data ? files.find((f) => f.path === sel)?.added ?? 0 : 0}` : null
  const diff = useResource<{ diff: string }>(diffKey, () =>
    scope === 'uncommitted'
      ? api(apiPath('/api/git/file-diff', { path: live!, file: sel! }))
      : api(apiPath('/api/git/review/diff', { path: live!, file: sel!, scope: 'branch', base: list.data?.base ?? undefined })),
  )

  const refreshAll = () => {
    status.refresh()
    list.refresh()
    diff.refresh()
  }

  const post = async (route: string, body: Record<string, unknown>, okTitle: string) => {
    if (!root) return
    setBusy(true)
    try {
      await api(route, { method: 'POST', body: { path: root, ...body } })
      toast({ title: okTitle, tone: 'ok' })
      return true
    } catch (e) {
      toast({ title: 'git falhou', detail: errMsg(e), tone: 'error' })
      return false
    } finally {
      setBusy(false)
      refreshAll()
    }
  }

  if (!root) {
    return ws.error ? <ErrorState title="sem workspace" detail={ws.error} /> : <Loading text="resolvendo workspace…" />
  }
  if (status.error && status.data === undefined) {
    return <ErrorState title="git status falhou" detail={status.error} onRetry={status.refresh} />
  }
  if (status.data === undefined) return <Loading text="lendo git status…" />
  if (status.data === null) {
    return (
      <EmptyState>
        {tildify(root)} não é um repositório git.
        <br />
        Escolha outro workspace no seletor acima.
      </EmptyState>
    )
  }

  const st = status.data
  const cur = files.find((f) => f.path === sel) ?? null
  const stagedCount = files.filter((f) => f.staged).length

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* cabeçalho: branch + contagens */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge px-3 py-1.5 text-[11px]">
        <span className="label text-faint">branch</span>
        <span className="text-amber">{st.detached ? '(detached)' : st.branch ?? '?'}</span>
        {(st.ahead > 0 || st.behind > 0) && (
          <span className="text-[10px] text-dim">
            {st.ahead > 0 && `↑${st.ahead} `}
            {st.behind > 0 && `↓${st.behind}`}
          </span>
        )}
        <span className="text-[10px] text-faint">
          {st.changed} arquivo(s) · <span className="text-phos">+{st.added}</span> <span className="text-alert">−{st.removed}</span>
          {st.conflicted > 0 && <span className="text-alert"> · {st.conflicted} conflito(s)</span>}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {status.error && <span className="text-[10px] text-alert" title={status.error}>erro ao atualizar</span>}
          <ToolButton onClick={refreshAll} disabled={busy} title="recarregar">
            ↻
          </ToolButton>
        </div>
      </div>

      {/* seletor de seção */}
      <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1">
        <ToolButton active={side === 'files'} onClick={() => setSide('files')}>
          alterações
        </ToolButton>
        <ToolButton active={side === 'worktrees'} onClick={() => setSide('worktrees')}>
          worktrees
        </ToolButton>
        <ToolButton active={side === 'branches'} onClick={() => setSide('branches')}>
          branches
        </ToolButton>
        {side === 'files' && (
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
            className="ml-auto rounded border border-edge bg-void px-1 py-0.5 text-[10px] text-dim outline-none"
            title="escopo do diff"
          >
            <option value="uncommitted">não commitado</option>
            <option value="branch">branch vs base</option>
          </select>
        )}
      </div>

      {side === 'worktrees' && <WorktreeList root={root} />}
      {side === 'branches' && <BranchList root={root} />}

      {side === 'files' && (
        <>
          <div className="max-h-[38%] shrink-0 overflow-y-auto border-b border-edge">
            {list.error && !list.data ? (
              <ErrorState title="lista de alterações falhou" detail={list.error} onRetry={list.refresh} />
            ) : !list.data ? (
              <Loading />
            ) : files.length === 0 ? (
              <EmptyState>{scope === 'branch' ? `nada na branch além da base${list.data.base ? ` (${list.data.base})` : ''}.` : 'árvore limpa — nada a revisar.'}</EmptyState>
            ) : (
              files.map((f) => (
                <div
                  key={f.path}
                  className={`group flex min-w-0 items-center gap-2 px-3 py-[3px] text-[11px] ${
                    f.path === sel ? 'bg-sel text-sel-ink' : 'text-dim hover:bg-hover/60'
                  }`}
                >
                  <button type="button" onClick={() => setSel(f.path)} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={f.path}>
                    <StatusLetter s={f.status} />
                    <span className="truncate">{basename(f.path)}</span>
                    <span className="truncate text-[10px] text-faint">{dirname(f.path) === '/' ? '' : dirname(f.path)}</span>
                    {f.staged && <span className="shrink-0 rounded border border-phos/30 px-1 text-[9px] uppercase text-phos">staged</span>}
                  </button>
                  <span className="shrink-0 text-[10px]">
                    <span className="text-phos">+{f.added}</span> <span className="text-alert">−{f.removed}</span>
                  </span>
                  {scope === 'uncommitted' && (
                    <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
                      {f.staged ? (
                        <ToolButton disabled={busy} onClick={() => void post('/api/git/review/unstage', { file: f.path }, `unstaged ${basename(f.path)}`)}>
                          unstage
                        </ToolButton>
                      ) : (
                        <ToolButton disabled={busy} onClick={() => void post('/api/git/review/stage', { file: f.path }, `staged ${basename(f.path)}`)}>
                          stage
                        </ToolButton>
                      )}
                      <ConfirmButton
                        disabled={busy}
                        title="descarta as mudanças locais deste arquivo"
                        confirmLabel="descartar?"
                        onConfirm={() => void post('/api/git/review/revert', { file: f.path }, `revertido ${basename(f.path)}`)}
                      >
                        revert
                      </ConfirmButton>
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          {/* diff do arquivo selecionado */}
          <div className="flex min-h-0 flex-1 flex-col">
            {cur && (
              <div className="flex shrink-0 items-center gap-2 px-3 py-1 text-[10px] text-faint">
                <span className="truncate text-dim" title={cur.path}>
                  {cur.path}
                </span>
                <button type="button" className="ml-auto shrink-0 hover:text-ink" onClick={() => void openIn({ kind: 'vscode', path: `${root}/${cur.path}` })}>
                  abrir no VS Code
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto bg-void/60">
              {!cur ? null : diff.error ? (
                <ErrorState title="diff falhou" detail={diff.error} onRetry={diff.refresh} />
              ) : !diff.data ? (
                <Loading text="carregando diff…" />
              ) : (
                <DiffView diff={diff.data.diff} />
              )}
            </div>
          </div>

          {/* commit (endpoint existe: /api/git/review/commit) */}
          {scope === 'uncommitted' && files.length > 0 && (
            <form
              className="flex shrink-0 items-center gap-1 border-t border-edge px-2 py-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                const m = msg.trim()
                if (!m) return
                void post('/api/git/review/commit', { message: m, push: false }, 'commit criado').then((ok) => ok && setMsg(''))
              }}
            >
              <input
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                placeholder={stagedCount ? `mensagem do commit (${stagedCount} staged)` : 'mensagem do commit (sem staged: commita tudo)'}
                className="min-w-0 flex-1 rounded border border-edge bg-void px-2 py-1 text-[11px] text-ink outline-none focus:border-amber/60"
              />
              <button
                type="submit"
                disabled={busy || !msg.trim()}
                className="shrink-0 rounded border border-amber/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber hover:bg-amber/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                commit
              </button>
            </form>
          )}
        </>
      )}
    </div>
  )
}

function WorktreeList({ root }: { root: string }) {
  const r = useResource<{ worktrees: Worktree[] }>(`wt:${root}`, () => api(apiPath('/api/git/worktrees', { path: root })), 30_000)
  if (r.error && !r.data) return <ErrorState title="worktrees falhou" detail={r.error} onRetry={r.refresh} />
  if (!r.data) return <Loading />
  const list = r.data.worktrees
  if (!list.length) return <EmptyState>nenhum worktree.</EmptyState>
  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1">
      {list.map((w) => {
        const swarm = /swarm|\.hermes\//i.test(w.path)
        const here = w.path === root
        return (
          <div key={w.path} className={`flex min-w-0 items-center gap-2 px-3 py-1 text-[11px] ${here ? 'bg-amber/5' : ''}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${here ? 'bg-amber' : 'bg-edge2'}`} />
            <span className="shrink-0 text-ink">{w.detached ? '(detached)' : w.branch ?? '?'}</span>
            {w.isMain && <span className="shrink-0 text-[9px] uppercase text-faint">principal</span>}
            {swarm && <span className="shrink-0 rounded border border-cyanic/30 px-1 text-[9px] uppercase text-cyanic">swarm</span>}
            {w.locked && <span className="shrink-0 text-[9px] uppercase text-alert">locked</span>}
            <span className="truncate text-[10px] text-faint" title={w.path}>
              {tildify(w.path)}
            </span>
            <span className="ml-auto flex shrink-0 gap-1">
              {!here && <ToolButton onClick={() => setWorkspace(w.path)}>usar</ToolButton>}
              <ToolButton onClick={() => void openIn({ kind: 'finder', path: w.path })}>finder</ToolButton>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function BranchList({ root }: { root: string }) {
  const r = useResource<{ branches: Branch[] }>(`br:${root}`, () => api(apiPath('/api/git/branches', { path: root })), 30_000)
  const [showRemote, setShowRemote] = useState(false)
  if (r.error && !r.data) return <ErrorState title="branches falhou" detail={r.error} onRetry={r.refresh} />
  if (!r.data) return <Loading />
  const list = r.data.branches.filter((b) => showRemote || !b.isRemote)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1">
      <label className="flex items-center gap-2 px-3 py-1 text-[10px] text-faint">
        <input type="checkbox" checked={showRemote} onChange={(e) => setShowRemote(e.target.checked)} />
        mostrar remotas
      </label>
      {list.length === 0 && <EmptyState>nenhuma branch.</EmptyState>}
      {list.map((b) => (
        <div key={`${b.isRemote ? 'r' : 'l'}:${b.name}`} className="flex min-w-0 items-center gap-2 px-3 py-[3px] text-[11px]">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${b.checkedOut ? 'bg-phos' : 'bg-edge2'}`} />
          <span className={`truncate ${b.isRemote ? 'text-faint' : 'text-ink'}`}>{b.name}</span>
          {b.isDefault && <span className="shrink-0 text-[9px] uppercase text-amber">default</span>}
          {b.worktreePath && (
            <span className="truncate text-[10px] text-faint" title={b.worktreePath}>
              {tildify(b.worktreePath)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
