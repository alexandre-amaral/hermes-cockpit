import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/ipc'
import {
  apiPath,
  basename,
  dirname,
  fmtBytes,
  openIn,
  tildify,
  useResource,
  useWorkspace,
  type FsList,
  type FsText,
} from '../../lib/devtools'
import { EmptyState, ErrorState, Loading, ToolButton } from './ui'

// Aba Arquivos: árvore navegável do workspace ativo. Fontes
// (hermes_cli/web_routers/files.py): /api/fs/list, /api/fs/read-text,
// /api/fs/read-data-url (imagens), /api/fs/git-root. Somente leitura.

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i
const MAX_PREVIEW_LINES = 5000

export function FilesTab({ active }: { active: boolean }) {
  const ws = useWorkspace()
  const root = ws.path
  const [dir, setDir] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [q, setQ] = useState('')

  // Workspace mudou → volta para a raiz dele.
  useEffect(() => {
    setDir(root)
    setFile(null)
    setQ('')
  }, [root])

  const cwd = dir ?? root
  const listing = useResource<FsList>(active && cwd ? `ls:${cwd}` : null, () => api(apiPath('/api/fs/list', { path: cwd! })))
  const gitRoot = useResource<{ root: string | null }>(active && cwd ? `gr:${cwd}` : null, () =>
    api(apiPath('/api/fs/git-root', { path: cwd! })),
  )

  const entries = useMemo(() => {
    const all = listing.data?.entries ?? []
    const needle = q.trim().toLowerCase()
    return needle ? all.filter((e) => e.name.toLowerCase().includes(needle)) : all
  }, [listing.data, q])

  if (!root || !cwd) {
    return ws.error ? <ErrorState title="sem workspace" detail={ws.error} /> : <Loading text="resolvendo workspace…" />
  }

  const go = (p: string) => {
    setDir(p)
    setQ('')
  }

  // Breadcrumbs: raiz do workspace como âncora; acima dela, caminho absoluto.
  const crumbs: { label: string; path: string }[] = []
  if (cwd === root || cwd.startsWith(root + '/')) {
    crumbs.push({ label: basename(root), path: root })
    const rel = cwd.slice(root.length).split('/').filter(Boolean)
    let acc = root
    for (const part of rel) {
      acc = `${acc}/${part}`
      crumbs.push({ label: part, path: acc })
    }
  } else {
    let acc = ''
    for (const part of cwd.split('/').filter(Boolean)) {
      acc = `${acc}/${part}`
      crumbs.push({ label: part, path: acc })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1">
        <ToolButton title="subir um nível" disabled={cwd === '/'} onClick={() => go(dirname(cwd))}>
          ↑
        </ToolButton>
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap text-[11px]">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex shrink-0 items-center gap-0.5">
              {i > 0 && <span className="text-faint">/</span>}
              <button
                type="button"
                onClick={() => go(c.path)}
                className={i === crumbs.length - 1 ? 'text-ink' : 'text-dim hover:text-amber'}
                title={c.path}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        {gitRoot.data?.root && (
          <span className="shrink-0 rounded border border-edge px-1 text-[9px] uppercase text-faint" title={`repo git: ${gitRoot.data.root}`}>
            git
          </span>
        )}
        <ToolButton title="abrir pasta no Finder" onClick={() => void openIn({ kind: 'finder', path: cwd })}>
          finder
        </ToolButton>
        <ToolButton title="abrir pasta no VS Code" onClick={() => void openIn({ kind: 'vscode', path: cwd })}>
          code
        </ToolButton>
      </div>

      <div className="shrink-0 border-b border-edge px-2 py-1">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filtrar por nome neste diretório…"
          spellCheck={false}
          className="w-full rounded border border-edge bg-void px-2 py-1 text-[11px] text-ink outline-none focus:border-amber/60"
        />
      </div>

      <div className={`${file ? 'max-h-[40%] shrink-0' : 'min-h-0 flex-1'} overflow-y-auto border-b border-edge`}>
        {listing.error && !listing.data ? (
          <ErrorState title="listagem falhou" detail={listing.error} onRetry={listing.refresh} />
        ) : !listing.data ? (
          <Loading />
        ) : listing.data.error ? (
          <ErrorState title={`não foi possível ler ${tildify(cwd)}`} detail={fsErr(listing.data.error)} onRetry={listing.refresh} />
        ) : entries.length === 0 ? (
          <EmptyState>{q ? `nada com “${q}” aqui.` : 'diretório vazio.'}</EmptyState>
        ) : (
          entries.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => (e.isDirectory ? go(e.path) : setFile(e.path))}
              onDoubleClick={() => !e.isDirectory && void openIn({ kind: 'vscode', path: e.path })}
              title={e.path}
              className={`flex w-full min-w-0 items-center gap-2 px-3 py-[3px] text-left text-[11px] ${
                file === e.path ? 'bg-panel2 text-ink' : 'text-dim hover:bg-hover/60 hover:text-ink'
              }`}
            >
              <span className={`w-3 shrink-0 text-center ${e.isDirectory ? 'text-amber' : 'text-faint'}`}>{e.isDirectory ? '▸' : '·'}</span>
              <span className={`truncate ${e.isDirectory ? 'text-ink' : ''}`}>{e.name}</span>
            </button>
          ))
        )}
      </div>

      {file && <FilePreview path={file} onClose={() => setFile(null)} />}
    </div>
  )
}

function fsErr(code: string): string {
  if (code === 'EACCES') return 'sem permissão de leitura'
  if (code === 'ENOENT') return 'diretório não existe'
  if (code === 'ENOTDIR') return 'não é um diretório'
  return code
}

function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const isImage = IMAGE_RE.test(path)
  const text = useResource<FsText>(isImage ? null : `rt:${path}`, () => api(apiPath('/api/fs/read-text', { path })))
  const img = useResource<{ dataUrl: string }>(isImage ? `img:${path}` : null, () => api(apiPath('/api/fs/read-data-url', { path })))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-1 text-[10px] text-faint">
        <span className="truncate text-dim" title={path}>
          {basename(path)}
        </span>
        {text.data && (
          <span className="shrink-0">
            {text.data.language} · {fmtBytes(text.data.byteSize)}
            {text.data.truncated && ' · truncado'}
          </span>
        )}
        <span className="ml-auto flex shrink-0 gap-1">
          <ToolButton onClick={() => void openIn({ kind: 'vscode', path })}>code</ToolButton>
          <ToolButton onClick={() => void openIn({ kind: 'finder', path })}>finder</ToolButton>
          <ToolButton onClick={onClose} title="fechar preview">
            ×
          </ToolButton>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-void/60">
        {isImage ? (
          img.error ? (
            <ErrorState title="imagem não carregou" detail={img.error} onRetry={img.refresh} />
          ) : !img.data ? (
            <Loading />
          ) : (
            <div className="flex min-h-full items-center justify-center p-3">
              <img src={img.data.dataUrl} alt={basename(path)} className="max-h-full max-w-full rounded border border-edge object-contain" />
            </div>
          )
        ) : text.error ? (
          <ErrorState
            title="arquivo não pôde ser lido"
            detail={/413/.test(text.error) ? 'arquivo grande demais para preview' : text.error}
            onRetry={text.refresh}
          />
        ) : !text.data ? (
          <Loading />
        ) : text.data.binary ? (
          <EmptyState>arquivo binário ({text.data.mimeType}) — sem preview de texto.</EmptyState>
        ) : (
          <NumberedText text={text.data.text} />
        )}
      </div>
    </div>
  )
}

function NumberedText({ text }: { text: string }) {
  const lines = text.split('\n')
  const shown = lines.slice(0, MAX_PREVIEW_LINES)
  const w = String(shown.length).length
  return (
    <pre className="m-0 min-w-max py-1 font-mono text-[11px] leading-[1.55] text-ink">
      {shown.map((l, i) => (
        <div key={i} className="flex">
          <span className="shrink-0 select-none pl-2 pr-3 text-right text-faint/70" style={{ width: `${w + 2}ch` }}>
            {i + 1}
          </span>
          <span className="whitespace-pre pr-4">{l || ' '}</span>
        </div>
      ))}
      {lines.length > MAX_PREVIEW_LINES && <div className="px-2 text-faint">… {lines.length - MAX_PREVIEW_LINES} linhas omitidas</div>}
    </pre>
  )
}
