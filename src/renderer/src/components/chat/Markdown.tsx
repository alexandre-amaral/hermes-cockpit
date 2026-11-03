import { Fragment, useState, type ReactNode } from 'react'

// Markdown mínimo para respostas do assistente — sem dependência e sem
// dangerouslySetInnerHTML (tudo vira nó React, então nada é interpretado como HTML).
// Cobre o que o Hermes emite na prática: títulos, listas, blocos de código (com
// cabeçalho de linguagem + copiar), tabelas GFM, citações, regra horizontal,
// **negrito**, *itálico*, ~~riscado~~, `código`, [links](url) e URLs soltas.
// Texto parcial em streaming degrada bem: marcador sem par fecha como texto
// literal; bloco de código sem fence de fechamento renderiza aberto.

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*|(?<![\w])_[^_\n]+_(?![\w]))|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(text.slice(last, idx))
    const k = `${key}-${i++}`
    const tok = m[0]
    if (m[1]) {
      out.push(
        <code key={k} className="rounded bg-panel2 px-1 py-px text-[0.92em] text-amber/90">
          {tok.slice(1, -1)}
        </code>,
      )
    } else if (m[2]) {
      out.push(
        <strong key={k} className="font-semibold text-ink">
          {inline(tok.slice(2, -2), k)}
        </strong>,
      )
    } else if (m[3]) {
      out.push(
        <del key={k} className="text-faint">
          {tok.slice(2, -2)}
        </del>,
      )
    } else if (m[4]) {
      out.push(<em key={k}>{tok.slice(1, -1)}</em>)
    } else if (m[5]) {
      const label = tok.slice(1, tok.indexOf(']('))
      out.push(
        <a key={k} href={m[6]} target="_blank" rel="noreferrer" className="text-cyanic underline-offset-2 hover:underline">
          {label}
        </a>,
      )
    } else if (m[7]) {
      out.push(
        <a key={k} href={tok} target="_blank" rel="noreferrer" className="break-all text-cyanic underline-offset-2 hover:underline">
          {tok}
        </a>,
      )
    }
    last = idx + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// ── bloco de código ──────────────────────────────────────────────────────────

const LANG_ALIAS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  md: 'markdown',
}

export function CodeBlock({ lang, code, open = false }: { lang: string; code: string; open?: boolean }) {
  const [copied, setCopied] = useState<'ok' | 'err' | null>(null)
  const label = (LANG_ALIAS[lang.toLowerCase()] ?? lang) || 'texto'
  const lines = code.split('\n').length
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied('ok')
    } catch {
      setCopied('err')
    }
    setTimeout(() => setCopied(null), 1400)
  }
  return (
    <div className="group/code my-2 overflow-hidden rounded-md border border-edge bg-void">
      <div className="flex items-center gap-2 border-b border-edge bg-panel px-2.5 py-1">
        <span className="label text-[9.5px] text-dim">{label}</span>
        <span className="text-[10px] text-faint">
          {lines} {lines === 1 ? 'linha' : 'linhas'}
          {open && ' · escrevendo…'}
        </span>
        <button
          onClick={() => void copy()}
          className={`ml-auto rounded px-1.5 py-px text-[10.5px] transition-colors ${
            copied === 'ok' ? 'text-phos' : copied === 'err' ? 'text-alert' : 'text-faint hover:bg-hover hover:text-ink'
          }`}
          title="copiar código"
        >
          {copied === 'ok' ? '✓ copiado' : copied === 'err' ? 'falhou' : 'copiar'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-[12px] leading-relaxed text-ink/90">
        <code>{code}</code>
      </pre>
    </div>
  )
}

// ── tabela GFM ───────────────────────────────────────────────────────────────

const SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  // pipes escapados \| ficam no texto
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function alignOf(cell: string): 'left' | 'center' | 'right' | undefined {
  const c = cell.trim()
  if (c.startsWith(':') && c.endsWith(':')) return 'center'
  if (c.endsWith(':')) return 'right'
  if (c.startsWith(':')) return 'left'
  return undefined
}

function Table({ head, align, rows, k }: { head: string[]; align: (string | undefined)[]; rows: string[][]; k: string }) {
  return (
    <div className="my-2 overflow-x-auto rounded-md border border-edge">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-panel">
          <tr>
            {head.map((h, j) => (
              <th
                key={j}
                style={{ textAlign: (align[j] as 'left' | 'center' | 'right' | undefined) ?? 'left' }}
                className="border-b border-edge px-2.5 py-1.5 font-semibold text-ink"
              >
                {inline(h, `${k}-h${j}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="odd:bg-transparent even:bg-panel/50">
              {head.map((_, j) => (
                <td
                  key={j}
                  style={{ textAlign: (align[j] as 'left' | 'center' | 'right' | undefined) ?? 'left' }}
                  className="border-t border-edge/60 px-2.5 py-1 align-top text-ink/90"
                >
                  {inline(r[j] ?? '', `${k}-${i}-${j}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── documento ────────────────────────────────────────────────────────────────

const HEADING_CLS = ['', 'text-[15px]', 'text-[14px]', 'text-[13px]', 'text-[12.5px]', 'text-[12px]', 'text-[12px]']

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let para: string[] = []
  let list: { ordered: boolean; start: number; items: string[] } | null = null
  let n = 0

  const flushPara = () => {
    if (!para.length) return
    const k = `p${n++}`
    blocks.push(
      <p key={k} className="my-1.5">
        {para.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(l, `${k}-${j}`)}
          </Fragment>
        ))}
      </p>,
    )
    para = []
  }
  const flushList = () => {
    if (!list) return
    const k = `l${n++}`
    const Tag = list.ordered ? 'ol' : 'ul'
    blocks.push(
      <Tag
        key={k}
        start={list.ordered && list.start !== 1 ? list.start : undefined}
        className={`my-1.5 pl-5 ${list.ordered ? 'list-decimal' : 'list-disc'} marker:text-faint`}
      >
        {list.items.map((it, j) => {
          const task = it.match(/^\[([ xX])\]\s+(.*)$/)
          return (
            <li key={j} className={`my-0.5 ${task ? 'list-none -ml-4' : ''}`}>
              {task ? (
                <>
                  <span className={task[1] === ' ' ? 'text-faint' : 'text-phos'}>{task[1] === ' ' ? '☐' : '☑'}</span>{' '}
                  {inline(task[2], `${k}-${j}`)}
                </>
              ) : (
                inline(it, `${k}-${j}`)
              )}
            </li>
          )
        })}
      </Tag>,
    )
    list = null
  }
  const flushAll = () => {
    flushPara()
    flushList()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/)
    if (fence) {
      flushAll()
      const marker = fence[1]
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++])
      const closed = i < lines.length
      blocks.push(<CodeBlock key={`c${n++}`} lang={fence[2] ?? ''} code={body.join('\n')} open={!closed} />)
      continue
    }
    // tabela: linha com pipe seguida de separador
    if (line.includes('|') && i + 1 < lines.length && SEP_RE.test(lines[i + 1])) {
      flushAll()
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]).map(alignOf)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]))
      i--
      const k = `t${n++}`
      blocks.push(<Table key={k} k={k} head={head} align={align} rows={rows} />)
      continue
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushAll()
      blocks.push(<hr key={`r${n++}`} className="my-3 border-edge" />)
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flushAll()
      const lvl = h[1].length
      blocks.push(
        <div key={`h${n++}`} className={`mb-1 mt-3 font-semibold text-ink ${HEADING_CLS[lvl]} ${lvl <= 2 ? 'border-b border-edge/70 pb-0.5' : ''}`}>
          {inline(h[2], `h${n}`)}
        </div>,
      )
      continue
    }
    const li = line.match(/^\s*(?:([-*+•])|(\d+)[.)])\s+(.*)$/)
    if (li) {
      flushPara()
      const ordered = Boolean(li[2])
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, start: ordered ? Number(li[2]) || 1 : 1, items: [] }
      list.items.push(li[3])
      continue
    }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      flushAll()
      const body: string[] = [quote[1]]
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) body.push(lines[++i].replace(/^>\s?/, ''))
      const k = `q${n++}`
      blocks.push(
        <blockquote key={k} className="my-1.5 border-l-2 border-amber/40 pl-3 text-dim">
          {body.map((b, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {inline(b, `${k}-${j}`)}
            </Fragment>
          ))}
        </blockquote>,
      )
      continue
    }
    if (!line.trim()) {
      flushAll()
      continue
    }
    // continuação de item de lista (linha indentada logo após o item)
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }
    flushList()
    para.push(line)
  }
  flushAll()
  return <>{blocks}</>
}
