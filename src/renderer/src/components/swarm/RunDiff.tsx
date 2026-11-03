import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/ipc'
import { errMsg } from '../../lib/swarm'
import { Btn, SkeletonRows } from './ui'

// Diff do worktree da run via REST do serve (hermes_cli/web_routers/git.py):
//   GET /api/git/review/list?path=<cwd>&scope=branch|uncommitted → {files, base}
//   GET /api/git/review/diff?path=<cwd>&file=<f>&scope=...       → {diff}
// "branch" = commits do worktree vs base (merge-base); "uncommitted" = árvore de trabalho.

type Scope = 'branch' | 'uncommitted'

interface ReviewFile {
  path: string
  added: number
  removed: number
  status: string
  staged: boolean
}

interface ReviewList {
  files: ReviewFile[]
  base: string | null
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString()

export function RunDiff({ cwd }: { cwd: string }) {
  const [scope, setScope] = useState<Scope>('uncommitted')
  const [list, setList] = useState<ReviewList | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [file, setFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ text: string; loading: boolean; err?: string }>({ text: '', loading: false })

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await api<ReviewList>(`/api/git/review/list?${q({ path: cwd, scope })}`)
      setList({ files: Array.isArray(res?.files) ? res.files : [], base: res?.base ?? null })
    } catch (e) {
      setErr(errMsg(e))
      setList(null)
    } finally {
      setLoading(false)
    }
  }, [cwd, scope])

  useEffect(() => {
    setFile(null)
    void load()
  }, [load])

  useEffect(() => {
    if (!file) return
    let cancel = false
    setDiff({ text: '', loading: true })
    const f = list?.files.find((x) => x.path === file)
    api<{ diff: string }>(
      `/api/git/review/diff?${q({ path: cwd, file, scope, ...(f?.staged && scope === 'uncommitted' ? { staged: 'true' } : {}) })}`,
    ).then(
      (r) => !cancel && setDiff({ text: r?.diff ?? '', loading: false }),
      (e) => !cancel && setDiff({ text: '', loading: false, err: errMsg(e) }),
    )
    return () => {
      cancel = true
    }
  }, [file, cwd, scope, list])

  const files = list?.files ?? []
  const tot = files.reduce((a, f) => ({ add: a.add + (f.added || 0), rem: a.rem + (f.removed || 0) }), { add: 0, rem: 0 })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-edge px-5 py-2">
        <div className="flex rounded border border-edge2 p-0.5">
          {(['uncommitted', 'branch'] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded px-2 py-0.5 text-[10.5px] uppercase tracking-[0.12em] transition-colors ${
                scope === s ? 'bg-panel2 text-ink' : 'text-faint hover:text-dim'
              }`}
            >
              {s === 'branch' ? 'commits vs base' : 'não commitado'}
            </button>
          ))}
        </div>
        {list?.base && scope === 'branch' && <span className="text-[10.5px] text-faint">base {list.base.slice(0, 12)}</span>}
        <span className="ml-auto text-[10.5px]">
          <span className="text-phos">+{tot.add}</span> <span className="text-alert">−{tot.rem}</span>{' '}
          <span className="text-faint">· {files.length} arquivos</span>
        </span>
        <Btn tone="ghost" onClick={() => void load()} title="recarregar">
          ↻
        </Btn>
      </div>
      {loading ? (
        <SkeletonRows n={3} className="p-5" />
      ) : err ? (
        <div className="p-5 text-[11px] text-alert">diff indisponível: {err}</div>
      ) : !files.length ? (
        <div className="p-5 text-[11px] text-faint">
          {scope === 'branch' ? 'nenhum commit na branch da run (ou base não encontrada)' : 'árvore de trabalho limpa'}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul className="w-64 shrink-0 overflow-y-auto border-r border-edge py-1">
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => setFile(f.path)}
                  className={`flex w-full items-baseline gap-2 px-3 py-1 text-left text-[11px] transition-colors ${
                    file === f.path ? 'bg-panel2 text-ink' : 'text-dim hover:bg-hover/60 hover:text-ink'
                  }`}
                  title={f.path}
                >
                  <span className="w-3 shrink-0 text-faint">{f.status}</span>
                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                  <span className="shrink-0 text-[10px] text-phos">+{f.added}</span>
                  <span className="shrink-0 text-[10px] text-alert">−{f.removed}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0 flex-1 overflow-auto">
            {!file ? (
              <div className="p-5 text-[11px] text-faint">selecione um arquivo</div>
            ) : diff.loading ? (
              <SkeletonRows n={4} className="p-5" />
            ) : diff.err ? (
              <div className="p-5 text-[11px] text-alert">{diff.err}</div>
            ) : (
              <DiffText text={diff.text} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function DiffText({ text }: { text: string }) {
  if (!text.trim()) return <div className="p-5 text-[11px] text-faint">sem diferenças</div>
  return (
    <pre className="hc-fade-in min-w-max py-2 text-[11px] leading-[1.55]">
      {text.split('\n').map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---')
          ? 'text-faint'
          : l.startsWith('+')
            ? 'bg-phos/[0.07] text-phos'
            : l.startsWith('-')
              ? 'bg-alert/[0.08] text-alert'
              : l.startsWith('@@')
                ? 'text-cyanic'
                : l.startsWith('diff ') || l.startsWith('index ')
                  ? 'text-faint'
                  : 'text-ink/80'
        return (
          <div key={i} className={`px-4 ${cls}`}>
            {l || ' '}
          </div>
        )
      })}
    </pre>
  )
}
