import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/ipc'
import { BOT_GROUPS, botTitle, GROUP_LABELS } from '../../lib/bots'
import type { ModelOptionProvider, ModelOptions } from '../../lib/gateway'
import { errMsg, fmtBytes, ops, type OllamaModel, type PullProgress } from '../../lib/ops'
import type { HermesRpc } from '../../lib/rpc'
import { toast } from '../../lib/toast'
import { Btn, ConfirmBtn, EmptyState, ErrorState, Meter, SectionHeader, SkeletonRows, Tag, Th, useAsync } from './ui'

/** O usuário não usa mais Codex — fora da UI (mesma regra do ModelPicker do chat). */
const HIDDEN_PROVIDER = /codex/i

// Modelos: Ollama local (tamanho, quantização, VRAM, pull/remover/descarregar),
// qual bot usa cada modelo, providers cloud do Hermes e troca do modelo
// padrão de cada bot (PUT /api/profiles/{name}/model — validado pelo serve).

interface ProfileRow {
  name: string
  model: string | null
  provider: string | null
}

const LOCAL_PROVIDERS = new Set(['ollama', 'custom', 'local'])
const isLocal = (p: string | null | undefined) => Boolean(p && LOCAL_PROVIDERS.has(p))

async function loadProfiles(rpc: HermesRpc | null): Promise<ProfileRow[]> {
  type Raw = { name?: string; model?: string | null; provider?: string | null }
  let rows: Raw[] | undefined
  if (rpc) {
    try {
      rows = (await rpc.call<{ profiles?: Raw[] }>('profiles.list', {}))?.profiles
    } catch {
      /* cai para REST */
    }
  }
  if (!rows) rows = (await api<{ profiles?: Raw[] }>('/api/profiles'))?.profiles
  return (rows ?? [])
    .filter((r): r is Raw & { name: string } => typeof r.name === 'string')
    .map((r) => ({ name: r.name, model: r.model ?? null, provider: r.provider ?? null }))
    .sort((a, b) => {
      const ga = BOT_GROUPS[a.name] ? 0 : 1
      const gb = BOT_GROUPS[b.name] ? 0 : 1
      return ga - gb || a.name.localeCompare(b.name)
    })
}

interface PickOption {
  provider: string
  providerName: string
  local: boolean
  models: { id: string; meta?: string }[]
}

export function ModelsSection({ rpc, onCount }: { rpc: HermesRpc | null; onCount?: (n: number) => void }) {
  const ollama = useAsync(ops.models, [], 15_000)
  const profiles = useAsync(() => loadProfiles(rpc), [rpc])
  const firstProfile = profiles.data?.find((p) => p.name === 'chief')?.name ?? profiles.data?.[0]?.name ?? null
  const cloud = useAsync<ModelOptions | null>(
    async () => (rpc && firstProfile ? rpc.call<ModelOptions>('model.options', { profile: firstProfile }) : null),
    [rpc, firstProfile],
  )
  const [pulls, setPulls] = useState<Record<string, PullProgress>>({})
  const [pullName, setPullName] = useState('')
  const [q, setQ] = useState('')

  const localModels = ollama.data?.running ? ollama.data.models : []
  useEffect(() => {
    if (ollama.data) onCount?.(localModels.length)
  }, [ollama.data, localModels.length, onCount])

  const reloadOllama = ollama.reload
  useEffect(
    () =>
      ops.onPullProgress((p) => {
        setPulls((prev) => ({ ...prev, [p.name]: p }))
        if (p.done) {
          if (p.error) toast({ title: `pull ${p.name}`, detail: p.error, tone: p.error === 'cancelado' ? 'warn' : 'error' })
          else toast({ title: `${p.name} baixado`, tone: 'ok' })
          void reloadOllama()
          setTimeout(() => setPulls((prev) => {
            const n = { ...prev }
            delete n[p.name]
            return n
          }), 2500)
        }
      }),
    [reloadOllama],
  )

  // quem usa o quê
  const usersOf = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of profiles.data ?? []) {
      if (!p.model) continue
      const key = isLocal(p.provider) ? `local:${p.model}` : `${p.provider ?? '?'}:${p.model}`
      m.set(key, [...(m.get(key) ?? []), p.name])
    }
    return m
  }, [profiles.data])
  const providerUsers = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of profiles.data ?? []) if (p.provider) m.set(p.provider, [...(m.get(p.provider) ?? []), p.name])
    return m
  }, [profiles.data])

  const pickOptions: PickOption[] = useMemo(() => {
    const out: PickOption[] = []
    if (localModels.length) {
      out.push({
        provider: 'ollama',
        providerName: 'Local · Ollama',
        local: true,
        models: localModels.map((m) => ({ id: m.name, meta: [m.parameterSize, m.quantization, fmtBytes(m.size)].filter(Boolean).join(' · ') })),
      })
    }
    for (const p of cloud.data?.providers ?? []) {
      if (p.authenticated === false || isLocal(p.slug) || HIDDEN_PROVIDER.test(p.slug)) continue
      out.push({ provider: p.slug, providerName: p.name || p.slug, local: false, models: p.models.map((id) => ({ id })) })
    }
    return out
  }, [localModels, cloud.data])

  const startPull = async () => {
    const name = pullName.trim()
    if (!name) return
    try {
      await ops.modelPull(name)
      setPullName('')
    } catch (e) {
      toast({ title: 'pull falhou', detail: errMsg(e), tone: 'error' })
    }
  }

  const f = q.trim().toLowerCase()
  const shown = f ? localModels.filter((m) => m.name.toLowerCase().includes(f) || (m.family ?? '').includes(f)) : localModels
  const totalDisk = localModels.reduce((s, m) => s + m.size, 0)
  const vram = localModels.reduce((s, m) => s + (m.vram ?? 0), 0)
  const pullList = Object.values(pulls)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        title="Modelos"
        subtitle={
          ollama.data?.running
            ? `Ollama ${ollama.data.version ?? ''} · ${localModels.length} locais · ${fmtBytes(totalDisk)} em disco · ${fmtBytes(vram)} carregado`
            : 'Ollama local + providers do Hermes'
        }
        query={q}
        onQuery={setQ}
        placeholder="filtrar modelos…"
        loading={ollama.loading || profiles.loading}
        at={ollama.at}
        onRefresh={() => {
          void ollama.reload()
          void profiles.reload()
          void cloud.reload()
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ── Bots × modelos ───────────────────────────────────────────── */}
        <Block title="Bots × modelo padrão" right={<span className="text-[10px] text-faint">troca grava no config.yaml do profile</span>}>
          {profiles.initial ? (
            <SkeletonRows rows={5} cols={3} />
          ) : profiles.error && !profiles.data ? (
            <ErrorState error={profiles.error} onRetry={() => void profiles.reload()} />
          ) : !profiles.data?.length ? (
            <EmptyState>nenhum profile no Hermes</EmptyState>
          ) : (
            <div className="divide-y divide-edge/70">
              {profiles.data.map((p) => (
                <BotModelRow
                  key={p.name}
                  profile={p}
                  options={pickOptions}
                  optionsError={cloud.error}
                  optionsLoading={cloud.loading || ollama.loading}
                  onChanged={() => void profiles.reload()}
                />
              ))}
            </div>
          )}
        </Block>

        {/* ── Ollama ───────────────────────────────────────────────────── */}
        <Block
          title="Locais · Ollama"
          right={
            ollama.data?.running ? (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault()
                  void startPull()
                }}
              >
                <input
                  value={pullName}
                  onChange={(e) => setPullName(e.target.value)}
                  placeholder="baixar: qwen3.5:9b"
                  spellCheck={false}
                  className="h-6 w-44 rounded border border-edge2 bg-void px-2 text-[11px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
                />
                <Btn tone="amber" disabled={!pullName.trim()} onClick={() => void startPull()}>
                  ↓ pull
                </Btn>
              </form>
            ) : null
          }
        >
          {pullList.length > 0 && (
            <div className="space-y-2 border-b border-edge px-3 py-2">
              {pullList.map((p) => {
                const pct = p.total ? ((p.completed ?? 0) / p.total) * 100 : 0
                return (
                  <div key={p.name} className="hc-rise">
                    <div className="mb-1 flex items-center gap-2 text-[11px]">
                      <span className="text-ink">{p.name}</span>
                      <span className="truncate text-faint">{p.error ?? p.status}</span>
                      <span className="ml-auto tabular-nums text-dim">
                        {p.total ? `${fmtBytes(p.completed ?? 0)} / ${fmtBytes(p.total)} · ${pct.toFixed(0)}%` : ''}
                      </span>
                      {!p.done && (
                        <Btn tone="alert" onClick={() => void ops.modelPullCancel(p.name).catch(() => {})}>
                          cancelar
                        </Btn>
                      )}
                    </div>
                    <Meter pct={p.done && !p.error ? 100 : pct} tone={p.error ? 'alert' : p.done ? 'phos' : 'amber'} />
                  </div>
                )
              })}
            </div>
          )}
          {ollama.initial ? (
            <SkeletonRows rows={4} cols={6} />
          ) : ollama.error ? (
            <ErrorState error={ollama.error} onRetry={() => void ollama.reload()} />
          ) : ollama.data && !ollama.data.running ? (
            <ErrorState
              error={ollama.data.error}
              onRetry={() => void ollama.reload()}
              hint={ollama.data.installed ? 'inicie com `ollama serve` ou abra o app Ollama' : 'instale em ollama.com'}
            />
          ) : !shown.length ? (
            <EmptyState>{f ? 'nenhum modelo com esse filtro' : 'nenhum modelo baixado'}</EmptyState>
          ) : (
            <table className="w-full border-collapse text-[11.5px]">
              <thead>
                <tr>
                  <Th>modelo</Th>
                  <Th>params</Th>
                  <Th>quant</Th>
                  <Th className="text-right">disco</Th>
                  <Th className="text-right">ctx</Th>
                  <Th>memória</Th>
                  <Th>usado por</Th>
                  <Th className="text-right">ações</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <LocalModelRow key={m.name} m={m} users={usersOf.get(`local:${m.name}`) ?? []} onChanged={() => void ollama.reload()} />
                ))}
              </tbody>
            </table>
          )}
        </Block>

        {/* ── Cloud ────────────────────────────────────────────────────── */}
        <Block title="Providers cloud · Hermes" right={firstProfile ? <span className="text-[10px] text-faint">via model.options ({firstProfile})</span> : null}>
          {!rpc ? (
            <EmptyState>sem conexão RPC com o Hermes — providers indisponíveis</EmptyState>
          ) : cloud.initial ? (
            <SkeletonRows rows={3} cols={4} />
          ) : cloud.error ? (
            <ErrorState error={cloud.error} onRetry={() => void cloud.reload()} />
          ) : (
            <CloudProviders providers={(cloud.data?.providers ?? []).filter((p) => !isLocal(p.slug) && !HIDDEN_PROVIDER.test(p.slug))} users={providerUsers} />
          )}
        </Block>
      </div>
    </div>
  )
}

function Block({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="hc-fade-in mx-4 my-3 overflow-hidden rounded-lg border border-edge bg-panel">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
        <span className="label">{title}</span>
        <div className="ml-auto">{right}</div>
      </div>
      {children}
    </section>
  )
}

function LocalModelRow({ m, users, onChanged }: { m: OllamaModel; users: string[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      toast({ title: ok, tone: 'ok' })
      onChanged()
    } catch (e) {
      toast({ title: 'falhou', detail: errMsg(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <tr className="border-b border-edge/60 hover:bg-hover/60">
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          {m.loaded && <span className="hc-pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-phos" title="carregado" />}
          <span className="text-ink">{m.name}</span>
          {m.capabilities?.filter((c) => c !== 'completion').map((c) => (
            <Tag key={c}>{c}</Tag>
          ))}
        </div>
      </td>
      <td className="px-2 py-1.5 text-dim">{m.parameterSize ?? '—'}</td>
      <td className="px-2 py-1.5 text-dim">{m.quantization ?? '—'}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-dim">{fmtBytes(m.size)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-dim">{m.contextLength ? `${Math.round(m.contextLength / 1024)}k` : '—'}</td>
      <td className="px-2 py-1.5">
        {m.loaded ? (
          <Tag tone="phos" title={m.expiresAt ? `descarrega em ${new Date(m.expiresAt).toLocaleTimeString('pt-BR')}` : undefined}>
            {m.vram != null ? `${fmtBytes(m.vram)} VRAM` : 'carregado'}
          </Tag>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="px-2 py-1.5">
        <div className="flex flex-wrap gap-1">
          {users.length ? users.map((u) => <Tag key={u} tone="amber">{botTitle(u)}</Tag>) : <span className="text-faint">—</span>}
        </div>
      </td>
      <td className="px-2 py-1.5">
        <div className="flex justify-end gap-1">
          {m.loaded && (
            <Btn disabled={busy} onClick={() => void act(() => ops.modelUnload(m.name), `${m.name} descarregado`)} title="liberar memória (keep_alive 0)">
              descarregar
            </Btn>
          )}
          <ConfirmBtn
            label="remover"
            confirmLabel={users.length ? `em uso por ${users.length} — remover?` : 'remover?'}
            disabled={busy}
            title="apaga o modelo do disco"
            onConfirm={() => act(() => ops.modelRm(m.name), `${m.name} removido`)}
          />
        </div>
      </td>
    </tr>
  )
}

function CloudProviders({ providers, users }: { providers: ModelOptionProvider[]; users: Map<string, string[]> }) {
  if (!providers.length) return <EmptyState>nenhum provider cloud configurado</EmptyState>
  const sorted = [...providers].sort((a, b) => Number(b.authenticated !== false) - Number(a.authenticated !== false) || a.slug.localeCompare(b.slug))
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 p-3">
      {sorted.map((p) => {
        const ok = p.authenticated !== false
        const u = users.get(p.slug) ?? []
        return (
          <div key={p.slug} className={`rounded-md border px-2.5 py-2 ${ok ? 'border-edge2 bg-panel2/50' : 'border-edge opacity-60'}`}>
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-phos' : 'bg-faint'}`} />
              <span className="truncate text-[12px] text-ink">{p.name || p.slug}</span>
              <span className="ml-auto text-[10px] tabular-nums text-faint">{p.models.length} modelos</span>
            </div>
            <div className="mt-1 text-[10.5px] text-faint">{ok ? p.slug : `${p.slug} · sem credencial`}</div>
            {p.warning && <div className="mt-1 text-[10.5px] text-amber">{p.warning}</div>}
            {u.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {u.map((n) => (
                  <Tag key={n} tone="amber">
                    {botTitle(n)}
                  </Tag>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── troca de modelo por bot ────────────────────────────────────────────────

function BotModelRow({
  profile,
  options,
  optionsError,
  optionsLoading,
  onChanged,
}: {
  profile: ProfileRow
  options: PickOption[]
  optionsError: string | null
  optionsLoading: boolean
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<{ provider: string; model: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const group = BOT_GROUPS[profile.name]

  const apply = async () => {
    if (!pending) return
    if (!/^[\w.-]+$/.test(profile.name)) return
    setBusy(true)
    try {
      await api(`/api/profiles/${encodeURIComponent(profile.name)}/model`, { method: 'PUT', body: pending })
      toast({ title: `${botTitle(profile.name)} → ${pending.model}`, detail: `${pending.provider} · vale nas próximas sessões`, tone: 'ok' })
      setPending(null)
      onChanged()
    } catch (e) {
      toast({ title: 'troca de modelo falhou', detail: errMsg(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex flex-wrap items-center gap-2 px-3 py-1.5 text-[11.5px] hover:bg-hover/40">
      <div className="w-36 min-w-0">
        <div className="truncate text-ink">{botTitle(profile.name)}</div>
        <div className="truncate text-[10px] text-faint">{group ? GROUP_LABELS[group] ?? group : profile.name}</div>
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 max-w-[50%] items-center gap-1.5 rounded border border-edge2 bg-void px-2 py-1 text-left hover:border-amber/50"
        title="escolher modelo"
      >
        <Tag tone={isLocal(profile.provider) ? 'phos' : 'cyanic'}>{isLocal(profile.provider) ? 'local' : profile.provider ?? '?'}</Tag>
        <span className="truncate text-ink">{profile.model ?? 'sem modelo'}</span>
        <span className="text-faint">▾</span>
      </button>
      {pending && (
        <div className="hc-rise flex items-center gap-1.5">
          <span className="text-faint">→</span>
          <Tag tone={isLocal(pending.provider) ? 'phos' : 'cyanic'}>{isLocal(pending.provider) ? 'local' : pending.provider}</Tag>
          <span className="text-amber">{pending.model}</span>
          <Btn tone="amber" disabled={busy} onClick={() => void apply()}>
            {busy ? '…' : 'aplicar'}
          </Btn>
          <Btn disabled={busy} onClick={() => setPending(null)}>
            cancelar
          </Btn>
        </div>
      )}
      {open && (
        <ModelCombo
          options={options}
          error={optionsError}
          loading={optionsLoading}
          current={profile.model ? { provider: profile.provider ?? '', model: profile.model } : null}
          onClose={() => setOpen(false)}
          onPick={(provider, model) => {
            setOpen(false)
            if (provider === profile.provider && model === profile.model) setPending(null)
            else setPending({ provider, model })
          }}
        />
      )}
    </div>
  )
}

/** Combobox de modelos agrupado por provider; busca + navegação por teclado. */
function ModelCombo({
  options,
  error,
  loading,
  current,
  onPick,
  onClose,
}: {
  options: PickOption[]
  error: string | null
  loading: boolean
  current: { provider: string; model: string } | null
  onPick: (provider: string, model: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const [onlyLocal, setOnlyLocal] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [onClose])

  const groups = useMemo(() => {
    const f = q.trim().toLowerCase()
    return options
      .filter((g) => !onlyLocal || g.local)
      .map((g) => ({
        ...g,
        models: f ? g.models.filter((m) => m.id.toLowerCase().includes(f) || g.provider.includes(f) || g.providerName.toLowerCase().includes(f)) : g.models,
      }))
      .filter((g) => g.models.length)
  }, [options, q, onlyLocal])
  const flat = useMemo(() => groups.flatMap((g) => g.models.map((m) => ({ provider: g.provider, id: m.id }))), [groups])

  useEffect(() => setIdx(0), [q, onlyLocal])
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(flat.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && flat[idx]) {
      e.preventDefault()
      onPick(flat[idx].provider, flat[idx].id)
    }
  }

  let i = -1
  return (
    <div ref={box} className="hc-glass hc-rise absolute left-[9.5rem] top-full z-30 mt-1 w-[440px] max-w-[85vw] rounded-lg border border-edge2 bg-panel shadow-2xl">
      <div className="flex items-center gap-2 border-b border-edge px-2 py-1.5">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="buscar modelo ou provider…"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded border border-edge2 bg-void px-2 text-[11.5px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
        />
        <label className="flex cursor-pointer items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-faint">
          <input type="checkbox" checked={onlyLocal} onChange={(e) => setOnlyLocal(e.target.checked)} className="accent-amber" />
          só local
        </label>
      </div>
      <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
        {loading && !options.length ? (
          <SkeletonRows rows={4} cols={2} />
        ) : !groups.length ? (
          <EmptyState>{error ? `providers: ${error}` : 'nada encontrado'}</EmptyState>
        ) : (
          groups.map((g) => (
            <div key={g.provider}>
              <div className="sticky top-0 flex items-center gap-1.5 bg-panel px-3 pb-0.5 pt-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${g.local ? 'bg-phos' : 'bg-cyanic'}`} />
                <span className="label">{g.providerName}</span>
                <span className="text-[10px] text-faint">{g.models.length}</span>
              </div>
              {g.models.map((m) => {
                i++
                const my = i
                const isCur = current?.model === m.id && (current.provider === g.provider || (g.local && isLocal(current.provider)))
                return (
                  <button
                    key={m.id}
                    type="button"
                    data-i={my}
                    onMouseEnter={() => setIdx(my)}
                    onClick={() => onPick(g.provider, m.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[11.5px] ${my === idx ? 'bg-amber/10 text-ink' : 'text-dim'}`}
                  >
                    <span className="w-3 text-amber">{isCur ? '●' : ''}</span>
                    <span className="truncate">{m.id}</span>
                    {m.meta && <span className="ml-auto shrink-0 text-[10px] text-faint">{m.meta}</span>}
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-edge px-3 py-1 text-[10px] text-faint">
        <span>↑↓ navegar</span>
        <span>↵ escolher</span>
        <span>esc fechar</span>
        {error && <span className="ml-auto truncate text-alert" title={error}>cloud: erro</span>}
      </div>
    </div>
  )
}
