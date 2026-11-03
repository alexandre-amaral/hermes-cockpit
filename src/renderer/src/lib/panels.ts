import type { ComponentType } from 'react'
import {
  AgendaWidget,
  InboxWidget,
  SistemaWidget,
  TimeboxWidget,
  type WidgetProps,
} from '../components/panels/widgets'
import { QuotaWidget, RailQuotaWidget } from '../components/panels/quota'
import { AgendaWeekWidget, CronWidget, QuotaGaugesWidget, SwarmActivityWidget } from '../components/panels/insights'
import { NotionTasksWidget } from '../components/notion/NotionTasksWidget'
import type { IconName } from '../components/ui/Icon'
import { DiffCard } from '../components/devtools/DiffCard'
import { SwarmCard } from '../components/swarm/SwarmCard'
import { flushLayoutStorage, type UiPrefs, type ViewId } from './layout'
import { HOST_LABEL } from './platform'
import { getSpace, spaceKey, type Space } from './space'

// Registry de painéis (P1-8). A strip inferior, a área de cards do dock e o
// rodapé da rail leem daqui; quais painéis aparecem em cada região (e em que
// ordem) é um layout serializado em JSON no localStorage — POR ESPAÇO
// (`hermes-cockpit.regions.v1:<espaço>`), com reset para o padrão do espaço.

export type Region = 'strip' | 'dock' | 'rail'

export interface PanelDef {
  id: string
  titulo: string
  componente: ComponentType<WidgetProps>
  /** rota(s) lidas pelo painel; vazio = sem fonte ainda */
  fonte: string[]
  refreshMs: number
  icon?: IconName
  /** uma linha para o menu "+" e as configurações */
  descricao?: string
}

export const PANELS: PanelDef[] = [
  {
    id: 'timebox',
    titulo: 'Hoje · time-boxing',
    componente: TimeboxWidget,
    fonte: ['/foco', '/agenda'],
    refreshMs: 60_000,
    icon: 'clock',
    descricao: 'linha do dia com eventos, foco do Notion e blocos livres',
  },
  {
    id: 'agenda-semana',
    titulo: 'Agenda da semana',
    componente: AgendaWeekWidget,
    fonte: ['/agenda?conta=all&dias=7'],
    refreshMs: 120_000,
    icon: 'calendar',
    descricao: 'timeline de 7 dias · Houer, pessoal (alexandre.slamaral@gmail.com) e FIAP',
  },
  {
    id: 'tarefas',
    titulo: 'Tarefas',
    componente: NotionTasksWidget,
    fonte: ['notion:*'],
    refreshMs: 60_000,
    icon: 'tasks',
    descricao: 'tarefas do Notion do espaço, com concluir',
  },
  { id: 'inbox', titulo: 'Inbox triada', componente: InboxWidget, fonte: ['/inbox'], refreshMs: 60_000, icon: 'inbox', descricao: 'Gmail não lido dos últimos 3 dias' },
  {
    id: 'agenda',
    titulo: 'Agenda de hoje',
    componente: AgendaWidget,
    fonte: ['/agenda'],
    refreshMs: 60_000,
    icon: 'calendar',
    descricao: 'lista de eventos de hoje das contas do espaço',
  },
  { id: 'crons', titulo: 'Próximos crons', componente: CronWidget, fonte: ['/api/cron/jobs'], refreshMs: 30_000, icon: 'automations', descricao: 'próximas execuções agendadas dos bots do espaço' },
  {
    id: 'swarm-atividade',
    titulo: 'Atividade do swarm',
    componente: SwarmActivityWidget,
    fonte: ['swarm:list'],
    refreshMs: 15_000,
    icon: 'activity',
    descricao: 'runs e custo por hora (12h)',
  },
  { id: 'cota-gauges', titulo: 'Cota · gauges', componente: QuotaGaugesWidget, fonte: ['quota:get', '/quota'], refreshMs: 60_000, icon: 'gauge', descricao: 'gauges das janelas de cada provedor' },
  {
    id: 'quota',
    titulo: 'Provedores · cota',
    componente: QuotaWidget,
    fonte: ['quota:get', '/quota'],
    refreshMs: 60_000,
    icon: 'money',
    descricao: 'uma aba por provedor, com a janela de 5h e a semanal',
  },
  {
    id: 'sistema',
    titulo: `Sistema · ${HOST_LABEL}`,
    componente: SistemaWidget,
    // ops:system é a fonte real (coleta local do main, multiplataforma);
    // /sistema é extra e opcional (gateway/ollama do plugin cockpit).
    fonte: ['ops:system', '/sistema'],
    refreshMs: 15_000,
    icon: 'cpu',
    descricao: 'CPU, RAM, volumes, GPU e uptime desta máquina (coleta local)',
  },
  {
    id: 'cota-rail',
    titulo: 'Provedores · cota (compacto)',
    componente: RailQuotaWidget,
    fonte: ['quota:get', '/quota'],
    refreshMs: 60_000,
    icon: 'money',
    descricao: 'versão compacta para o rodapé da rail',
  },
  { id: 'diff', titulo: 'Diff pendente', componente: DiffCard, fonte: ['/api/git/status'], refreshMs: 15_000, icon: 'diff', descricao: 'arquivos alterados do workspace' },
  { id: 'swarm', titulo: 'Execuções do swarm', componente: SwarmCard, fonte: ['swarm:list'], refreshMs: 5_000, icon: 'swarm', descricao: 'runs ativas e recentes do Claude Code' },
]

export const PANEL_BY_ID: Record<string, PanelDef> = Object.fromEntries(PANELS.map((p) => [p.id, p]))

export type RegionLayout = Record<Region, string[]>

/** Padrão do espaço Tudo (e legado). */
export const DEFAULT_REGIONS: RegionLayout = {
  strip: ['timebox', 'tarefas', 'inbox'],
  dock: ['diff', 'swarm'],
  rail: ['cota-rail'],
}

const SPACE_DEFAULTS: Record<Space, RegionLayout> = {
  tudo: { strip: ['agenda-semana', 'tarefas', 'inbox'], dock: ['diff', 'swarm'], rail: ['cota-rail'] },
  houer: { strip: ['timebox', 'tarefas', 'inbox'], dock: ['diff', 'swarm'], rail: ['cota-rail'] },
  pessoal: { strip: ['agenda-semana', 'tarefas', 'inbox'], dock: ['crons', 'swarm-atividade'], rail: ['cota-rail'] },
}

export function defaultRegionsFor(space: Space = getSpace()): RegionLayout {
  return SPACE_DEFAULTS[space] ?? DEFAULT_REGIONS
}

export const REGION_LABELS: Record<Region, string> = {
  strip: 'Strip inferior',
  dock: 'Cards do dock',
  rail: 'Rodapé da rail',
}

const KEY = 'hermes-cockpit.regions.v1'

const clean = (v: unknown, fb: string[]) =>
  Array.isArray(v) ? Array.from(new Set(v.filter((id): id is string => typeof id === 'string' && id in PANEL_BY_ID))) : fb

export function loadRegions(space: Space = getSpace()): RegionLayout {
  const fb = defaultRegionsFor(space)
  try {
    // primeira visita a um espaço herda o layout legado sem sufixo, se houver
    const raw = localStorage.getItem(spaceKey(KEY, space)) ?? localStorage.getItem(KEY)
    if (!raw) return fb
    const p = JSON.parse(raw) as Partial<Record<Region, unknown>>
    return { strip: clean(p.strip, fb.strip), dock: clean(p.dock, fb.dock), rail: clean(p.rail, fb.rail) }
  } catch {
    return fb
  }
}

export function saveRegions(r: RegionLayout, space: Space = getSpace()): void {
  try {
    localStorage.setItem(spaceKey(KEY, space), JSON.stringify(r))
    flushLayoutStorage()
  } catch {
    /* sem storage: vale só nesta sessão */
  }
}

export function resetRegions(space: Space = getSpace()): RegionLayout {
  try {
    localStorage.removeItem(spaceKey(KEY, space))
    flushLayoutStorage()
  } catch {
    /* ignore */
  }
  // o legado sem sufixo não é apagado: outros espaços ainda podem herdá-lo
  return defaultRegionsFor(space)
}

/** Liga/desliga um painel numa região (um painel pode estar em várias). */
export function togglePanel(r: RegionLayout, region: Region, id: string): RegionLayout {
  const list = r[region]
  return { ...r, [region]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] }
}

export function movePanel(r: RegionLayout, region: Region, id: string, delta: -1 | 1): RegionLayout {
  const list = [...r[region]]
  const i = list.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return r
  ;[list[i], list[j]] = [list[j], list[i]]
  return { ...r, [region]: list }
}

// ─── Presets de layout (1 clique; aplicados ao espaço ativo) ────────────────

export interface LayoutPreset {
  id: 'foco' | 'operacao' | 'planejamento'
  label: string
  hint: string
  icon: IconName
  view: ViewId
  prefs: Partial<Pick<UiPrefs, 'railOpen' | 'dockOpen' | 'stripOpen' | 'dockCardsOpen' | 'focus' | 'dockTab'>>
  regions: RegionLayout
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'foco',
    label: 'Foco',
    hint: 'só o chat e o dia: rail e dock fechados, strip com hoje + tarefas',
    icon: 'focus',
    view: 'chat',
    prefs: { railOpen: false, dockOpen: false, stripOpen: true, focus: false },
    regions: { strip: ['timebox', 'tarefas'], dock: ['diff'], rail: ['cota-rail'] },
  },
  {
    id: 'operacao',
    label: 'Operação',
    hint: 'swarm, crons, sistema e cota à vista; dock com terminal e runs',
    icon: 'activity',
    view: 'swarm',
    prefs: { railOpen: true, dockOpen: true, stripOpen: true, dockCardsOpen: true, focus: false, dockTab: 'terminal' },
    regions: { strip: ['swarm-atividade', 'crons', 'sistema', 'cota-gauges'], dock: ['swarm', 'diff'], rail: ['cota-rail'] },
  },
  {
    id: 'planejamento',
    label: 'Planejamento',
    hint: 'agenda da semana, tarefas e inbox; Notion no centro',
    icon: 'calendar',
    view: 'notion',
    prefs: { railOpen: true, dockOpen: true, stripOpen: true, dockCardsOpen: true, focus: false },
    regions: { strip: ['agenda-semana', 'tarefas', 'inbox'], dock: ['agenda', 'crons'], rail: ['cota-rail'] },
  },
]
