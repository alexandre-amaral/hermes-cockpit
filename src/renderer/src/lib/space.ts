import { useSyncExternalStore } from 'react'
import { BOT_GROUPS } from './bots'

// Espaço ativo do cockpit: Pessoal × Trabalho (Houer) × Tudo. CONTRATO (fixo)
// para todos os módulos: filtre o que mostra com `inSpace(spaceOf…(x), space)`.
// - bots: coordenação (chief, mercurio) e operações (argos) são compartilhados;
//   trabalho (atlas, hefesto, kairos) = houer; pessoal (lar, vesta) = pessoal.
// - paths: ~/Documents/Houer/** = houer; ~/Documents/Alexandre/** = pessoal;
//   ~/dev/** e demais = compartilhado.
// - agenda/inbox: campo `conta` do plugin ('houer' | 'pessoal'; inbox: work/personal).
// O <html> recebe data-space="<espaço>" — o tema pode variar accent por espaço.

export type Space = 'tudo' | 'houer' | 'pessoal'
/** espaço de um item; 'shared' aparece em qualquer espaço */
export type ItemSpace = 'houer' | 'pessoal' | 'shared'

export const SPACES: { id: Space; label: string; hint: string }[] = [
  { id: 'tudo', label: 'Tudo', hint: 'pessoal e Houer juntos' },
  { id: 'houer', label: 'Houer', hint: 'trabalho — bots, agenda, inbox, Notion e repos da Houer' },
  { id: 'pessoal', label: 'Pessoal', hint: 'vida pessoal, FIAP, projetos próprios' },
]

const KEY = 'hermes-cockpit.space'
let current: Space = (() => {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'houer' || v === 'pessoal' ? v : 'tudo'
  } catch {
    return 'tudo'
  }
})()
const subs = new Set<() => void>()
const applyAttr = () => {
  if (typeof document !== 'undefined') document.documentElement.dataset.space = current
}
applyAttr()

export function getSpace(): Space {
  return current
}

export function setSpace(s: Space): void {
  current = s
  try {
    localStorage.setItem(KEY, s)
    window.hermes?.flushStorage?.() // espaço ativo sobrevive a kill/crash
  } catch {
    /* sem storage */
  }
  applyAttr()
  subs.forEach((f) => f())
}

export function useSpace(): Space {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => current,
  )
}

export function inSpace(item: ItemSpace, space: Space = current): boolean {
  return space === 'tudo' || item === 'shared' || item === space
}

export function spaceOfBot(name: string): ItemSpace {
  const g = BOT_GROUPS[name]
  if (g === 'trabalho') return 'houer'
  if (g === 'pessoal') return 'pessoal'
  return 'shared'
}

/**
 * Espaço de um caminho de repo/pasta. Normaliza o separador antes de testar:
 * no Windows os caminhos chegam com `\\` (C:\\Users\\…\\Documents\\Houer\\repo) e os
 * regexes de `/` não casariam. Comparação sem distinguir maiúsculas (o Windows
 * também não distingue).
 */
export function spaceOfPath(path: string | null | undefined): ItemSpace {
  if (!path) return 'shared'
  const p = path.replace(/\\/g, '/')
  if (/\/Documents\/Houer(\/|$)/i.test(p) || /\/houer[^/]*$/i.test(p)) return 'houer'
  if (/\/Documents\/Alexandre(\/|$)/i.test(p)) return 'pessoal'
  return 'shared'
}

/** conta de agenda/inbox do plugin → espaço */
export function spaceOfAccount(conta: string | null | undefined): ItemSpace {
  const c = (conta ?? '').toLowerCase()
  if (c === 'houer' || c === 'work' || c === 'trabalho') return 'houer'
  if (c === 'pessoal' || c === 'personal') return 'pessoal'
  return 'shared'
}

// ─── adições do shell (compatíveis) ─────────────────────────────────────────

/** Ordem do seletor da topbar (⌘⇧1 Pessoal · ⌘⇧2 Houer · ⌘⇧3 Tudo). */
export const SPACE_ORDER: Space[] = ['pessoal', 'houer', 'tudo']

export const isSpace = (v: unknown): v is Space => v === 'tudo' || v === 'houer' || v === 'pessoal'

/** Chave de localStorage escopada por espaço (layout/prefs salvos POR ESPAÇO). */
export function spaceKey(base: string, space: Space = current): string {
  return `${base}:${space}`
}

/** Valor de `?conta=` das rotas /agenda e /inbox do plugin para um espaço. */
export function contaOfSpace(space: Space = current): 'work' | 'personal' | 'all' {
  return space === 'houer' ? 'work' : space === 'pessoal' ? 'personal' : 'all'
}

/** Rota da agenda do plugin para o espaço (Houer, pessoal alexandre.slamaral@gmail.com + FIAP, ou todas). */
export function agendaPath(space: Space = current, dias = 1): string {
  const d = Math.max(1, Math.min(14, Math.round(dias)))
  return `/api/plugins/cockpit/agenda?conta=${contaOfSpace(space)}&dias=${d}`
}
