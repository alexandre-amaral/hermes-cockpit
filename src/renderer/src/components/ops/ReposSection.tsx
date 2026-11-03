import { useEffect, useMemo, useState } from 'react'
import { invoke } from '../../lib/ipc'
import { errMsg, ops, type RepoDetail, type RepoRow } from '../../lib/ops'
import { toast } from '../../lib/toast'
import { inSpace, spaceOfPath, useSpace } from '../../lib/space'
import { Btn, EmptyState, ErrorState, SectionHeader, SkeletonRows, Tag, useAsync } from './ui'

// Projetos & repos: varredura de ~/dev e ~/Documents (prof. 3, cache 60s no
// main). Card por repo; detalhe com branches/remotes/worktrees/commits;
// "delegar ao Claude Code" → swarm:spawn {task, cwd}.

const HOME_RE = /^\/Users\/[^/]+/

const short = (p: string) => p.replace(HOME_RE, '~')

type Filter = 'todos' | 'sujos' | 'fora'

export function ReposSection({ onCount }: { onCount?: (n: number) => void }) {
  const s = useAsync(() => ops.repos(), [])
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('todos')
  const [sel, setSel] = useState<string | null>(null)
  const [delegate, setDelegate] = useState<RepoRow | null>(null)

  useEffect(() => {
    if (s.data) onCount?.(s.data.length)
  }, [s.data, onCount])

  const f = q.trim().toLowerCase()
  const space = useSpace()
  const shown = useMemo(
    () =>
      (s.data ?? []).filter((r) => {
        if (!inSpace(spaceOfPath(r.path), space)) return false
        if (filter === 'sujos' && !r.dirty) return false
        if (filter === 'fora' && !(r.ahead || r.behind)) return false
        return !f || r.name.toLowerCase().includes(f) || r.path.toLowerCase().includes(f) || (r.branch ?? '').toLowerCase().includes(f)
      }),
    [s.data, filter, f, space],
  )
  const dirtyN = (s.data ?? []).filter((r) => r.dirty).length
  const outN = (s.data ?? []).filter((r) => r.ahead || r.behind).length
  const selected = s.data?.find((r) => r.path === sel) ?? null

  const open = (kind: 'finder' | 'vscode' | 'terminal', path: string) =>
    void ops.open({ kind, path }).catch((e) => toast({ title: 'abrir falhou', detail: errMsg(e), tone: 'error' }))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        title="Projetos & repos"
        subtitle={s.data ? `${s.data.length} repos · ${dirtyN} com mudanças · ${outN} fora de sincronia` : '~/dev e ~/Documents'}
        query={q}
        onQuery={setQ}
        placeholder="nome, caminho, branch…"
        loading={s.loading}
        at={s.at}
        onRefresh={() => void s.reload()}
      >
        <div className="flex overflow-hidden rounded border border-edge2">
          {(
            [
              ['todos', 'todos'],
              ['sujos', `sujos ${dirtyN}`],
              ['fora', `↑↓ ${outN}`],
            ] as [Filter, string][]
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={`px-2 py-1 text-[10.5px] ${filter === k ? 'bg-amber/10 text-amber' : 'text-dim hover:text-ink'}`}
            >
              {l}
            </button>
          ))}
        </div>
        <Btn onClick={() => void ops.repos(true).then(() => s.reload())} title="ignora o cache de 60s">
          revarrer
        </Btn>
      </SectionHeader>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {s.initial ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2 p-4">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="hc-shimmer h-[92px] rounded-lg border border-edge bg-panel2" />
              ))}
            </div>
          ) : s.error && !s.data ? (
            <ErrorState error={s.error} onRetry={() => void s.reload()} />
          ) : !shown.length ? (
            <EmptyState>{f || filter !== 'todos' ? 'nada com esse filtro' : 'nenhum repositório em ~/dev ou ~/Documents'}</EmptyState>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2 p-4">
              {shown.map((r) => (
                <RepoCard
                  key={r.path}
                  r={r}
                  active={r.path === sel}
                  onSelect={() => setSel(r.path === sel ? null : r.path)}
                  onOpen={(k) => open(k, r.path)}
                  onDelegate={() => setDelegate(r)}
                />
              ))}
            </div>
          )}
        </div>
        {selected && <RepoDrawer r={selected} onClose={() => setSel(null)} onOpen={(k, p) => open(k, p)} />}
      </div>
      {delegate && <DelegateDialog repo={delegate} onClose={() => setDelegate(null)} />}
    </div>
  )
}

function RepoCard({
  r,
  active,
  onSelect,
  onOpen,
  onDelegate,
}: {
  r: RepoRow
  active: boolean
  onSelect: () => void
  onOpen: (k: 'finder' | 'vscode' | 'terminal') => void
  onDelegate: () => void
}) {
  return (
    <div
      className={`hc-fade-in group flex flex-col rounded-lg border px-3 py-2 transition-colors ${
        active ? 'border-amber/60 bg-amber/5' : 'border-edge bg-panel hover:border-edge2'
      }`}
    >
      <button type="button" onClick={onSelect} className="min-w-0 text-left">
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.dirty ? 'bg-amber' : 'bg-phos'}`} />
          <span className="truncate text-[12.5px] text-ink">{r.name}</span>
          {r.branch && (
            <span className="ml-auto max-w-[45%] shrink-0 truncate text-[10.5px] text-cyanic" title={r.branch}>
              ⎇ {r.branch}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[10.5px] text-faint" title={r.path}>
          {short(r.path)}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {r.dirty > 0 ? <Tag tone="warn">{r.dirty} alterações</Tag> : <Tag tone="phos">limpo</Tag>}
          {r.ahead ? <Tag tone="cyanic">↑{r.ahead}</Tag> : null}
          {r.behind ? <Tag tone="alert">↓{r.behind}</Tag> : null}
          {r.ahead === undefined && <Tag title="sem upstream">local</Tag>}
        </div>
        {r.lastCommit && (
          <div className="mt-1 truncate text-[10.5px] text-dim" title={r.lastCommit}>
            {r.lastCommit}
          </div>
        )}
      </button>
      <div className="mt-1.5 flex flex-wrap gap-1 opacity-70 transition-opacity group-hover:opacity-100">
        <Btn onClick={() => onOpen('finder')}>Finder</Btn>
        <Btn onClick={() => onOpen('vscode')}>VS Code</Btn>
        <Btn onClick={() => onOpen('terminal')}>terminal</Btn>
        <Btn tone="amber" onClick={onDelegate} className="ml-auto" title="abrir uma run do Claude Code neste repo">
          ✦ delegar
        </Btn>
      </div>
    </div>
  )
}

function RepoDrawer({ r, onClose, onOpen }: { r: RepoRow; onClose: () => void; onOpen: (k: 'finder' | 'vscode' | 'terminal', p: string) => void }) {
  const d = useAsync<RepoDetail>(() => ops.repo(r.path), [r.path])
  return (
    <aside className="hc-rise flex w-[340px] min-w-0 shrink-0 flex-col border-l border-edge bg-panel">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="truncate text-[12.5px] text-ink">{r.name}</span>
        <button type="button" onClick={onClose} className="ml-auto text-faint hover:text-ink" aria-label="fechar">
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[11.5px]">
        {d.initial ? (
          <SkeletonRows rows={8} cols={2} />
        ) : d.error ? (
          <ErrorState error={d.error} onRetry={() => void d.reload()} />
        ) : d.data ? (
          <>
            <DrawerBlock title={`Alterações · ${d.data.status.length}`}>
              {d.data.status.length ? (
                <div className="max-h-40 overflow-y-auto">
                  {d.data.status.map((l) => (
                    <div key={l} className="truncate whitespace-pre text-dim">
                      <span className={l.startsWith('??') ? 'text-faint' : 'text-amber'}>{l.slice(0, 2)}</span>
                      {l.slice(2)}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-faint">árvore limpa</div>
              )}
            </DrawerBlock>
            <DrawerBlock title={`Branches · ${d.data.branches.length}`}>
              {d.data.branches.slice(0, 15).map((b) => (
                <div key={b.name} className="flex items-center gap-1.5">
                  <span className="w-2 text-amber">{b.current ? '●' : ''}</span>
                  <span className={`truncate ${b.current ? 'text-ink' : 'text-dim'}`}>{b.name}</span>
                  {b.upstream && <span className="truncate text-[10px] text-faint">{b.upstream}</span>}
                  <span className="ml-auto shrink-0 text-[10px] text-faint">{b.when}</span>
                </div>
              ))}
            </DrawerBlock>
            {d.data.worktrees.length > 1 && (
              <DrawerBlock title={`Worktrees · ${d.data.worktrees.length}`}>
                {d.data.worktrees.map((w) => (
                  <div key={w.path} className="flex items-center gap-1.5">
                    <button type="button" onClick={() => onOpen('finder', w.path)} className="truncate text-left text-dim hover:text-ink" title={w.path}>
                      {short(w.path)}
                    </button>
                    <span className="ml-auto shrink-0 text-[10px] text-cyanic">{w.branch ?? w.head}</span>
                  </div>
                ))}
              </DrawerBlock>
            )}
            <DrawerBlock title="Remotes">
              {d.data.remotes.length ? (
                d.data.remotes.map((x) => {
                  const web = x.url.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '')
                  return (
                    <div key={x.name} className="flex items-center gap-1.5">
                      <span className="text-dim">{x.name}</span>
                      {/^https?:\/\//.test(web) ? (
                        <button
                          type="button"
                          onClick={() => void ops.open({ kind: 'url', url: web }).catch(() => {})}
                          className="truncate text-left text-cyanic hover:underline"
                          title={x.url}
                        >
                          {web.replace(/^https?:\/\//, '')}
                        </button>
                      ) : (
                        <span className="truncate text-faint">{x.url}</span>
                      )}
                    </div>
                  )
                })
              ) : (
                <div className="text-faint">sem remote</div>
              )}
            </DrawerBlock>
            <DrawerBlock title="Commits recentes">
              {d.data.commits.map((c) => (
                <div key={c.hash} className="flex gap-1.5">
                  <span className="shrink-0 text-amber">{c.hash}</span>
                  <span className="truncate text-dim" title={`${c.subject} — ${c.author}`}>
                    {c.subject}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-faint">{c.when}</span>
                </div>
              ))}
            </DrawerBlock>
          </>
        ) : null}
      </div>
    </aside>
  )
}

function DrawerBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="label mb-1">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function DelegateDialog({ repo, onClose }: { repo: RepoRow; onClose: () => void }) {
  const [task, setTask] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const t = task.trim()
    if (!t) return
    setBusy(true)
    try {
      await invoke('swarm:spawn', { task: t, cwd: repo.path, ...(title.trim() ? { title: title.trim() } : {}) })
      toast({ title: 'run do Claude Code criada', detail: `${repo.name} · acompanhe no Swarm`, tone: 'ok' })
      onClose()
    } catch (e) {
      toast({ title: 'delegar falhou', detail: errMsg(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="hc-fade-in absolute inset-0 z-40 flex items-start justify-center bg-void/60 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="hc-glass hc-rise w-[560px] max-w-[92%] rounded-lg border border-edge2 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <span className="label">Delegar ao Claude Code</span>
          <span className="truncate text-[11px] text-dim">{short(repo.path)}</span>
          <button type="button" onClick={onClose} className="ml-auto text-faint hover:text-ink" aria-label="fechar">
            ✕
          </button>
        </div>
        <div className="space-y-2 px-3 py-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="título (opcional)"
            className="h-7 w-full rounded border border-edge2 bg-void px-2 text-[12px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
          />
          <textarea
            autoFocus
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
              if (e.key === 'Escape') onClose()
            }}
            rows={7}
            placeholder={`O que o Claude Code deve fazer em ${repo.name}?\nEx.: "rode os testes, corrija as falhas e resuma o que mudou".\nA run abre num git worktree próprio; nada vai para a branch atual sem você revisar.`}
            className="w-full resize-y rounded border border-edge2 bg-void px-2 py-1.5 text-[12px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-amber/60"
          />
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] text-faint">
              {repo.branch ? `base: ${repo.branch}` : ''}
              {repo.dirty ? ` · ${repo.dirty} alterações não commitadas ficam fora do worktree` : ''}
            </span>
            <Btn onClick={onClose} className="ml-auto">
              cancelar
            </Btn>
            <Btn tone="amber" disabled={busy || !task.trim()} onClick={() => void submit()}>
              {busy ? 'criando…' : 'delegar ⌘↵'}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
