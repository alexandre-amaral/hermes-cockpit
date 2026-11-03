import type { SVGProps } from 'react'
import { cx } from './cx'

// Ícones SVG inline do cockpit (traço 1.5, 16×16, herdam currentColor).
// Use <Icon name="chat"/> em vez de glifos soltos (◆ ⋮⋮ ⟳ …) para ter peso,
// alinhamento e tamanho consistentes em toda a UI.

const PATHS = {
  chat: 'M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5A1.5 1.5 0 0 1 3 9.5z',
  swarm: 'M8 2.5v3M8 10.5v3M3.2 5.2l2.6 1.5M10.2 9.3l2.6 1.5M3.2 10.8l2.6-1.5M10.2 6.7l2.6-1.5M8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  automations: 'M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5M11.6 2v2.5H9.1M4.4 14v-2.5h2.5',
  notion: 'M4 2.5h6.5L12.5 4.5v9H4zM6.2 11V6l3.6 5V6',
  ops: 'M2.5 8h2.2l1.6-4 3.2 8 1.6-4h2.4',
  transcribe: 'M8 2.5a2 2 0 0 1 2 2v3a2 2 0 0 1-4 0v-3a2 2 0 0 1 2-2zM4.5 7.5a3.5 3.5 0 0 0 7 0M8 11v2.5M2.5 6v3M13.5 6v3',
  mic: 'M8 2.5a2 2 0 0 1 2 2V8a2 2 0 0 1-4 0V4.5a2 2 0 0 1 2-2zM4.5 7.5a3.5 3.5 0 0 0 7 0M8 11v2.5M6 13.5h4',
  search: 'M7 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM10 10l3.5 3.5',
  rail: 'M2.5 3.5h11v9h-11zM6 3.5v9',
  dock: 'M2.5 3.5h11v9h-11zM10 3.5v9',
  focus: 'M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M8 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  settings: 'M8 5.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4zM8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1',
  window: 'M2.5 4.5h8v8h-8zM5.5 2.5h8v8',
  plus: 'M8 3v10M3 8h10',
  close: 'M4 4l8 8M12 4l-8 8',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5',
  grip: 'M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01',
  calendar: 'M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3',
  clock: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5v3l2 1.5',
  bot: 'M4 6h8a1.5 1.5 0 0 1 1.5 1.5V11A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V7.5A1.5 1.5 0 0 1 4 6zM8 3.5V6M6 9h.01M10 9h.01',
  alert: 'M8 2.5l6 10.5H2zM8 6.5v3M8 11.3h.01',
  check: 'M3.5 8.5l3 3 6-7',
  layout: 'M2.5 2.5h11v11h-11zM2.5 6.5h11M7 6.5v7',
  gauge: 'M2.8 11.5a5.5 5.5 0 1 1 10.4 0M8 8l2.5-2.5',
  activity: 'M2.5 9h2l1.5-4 2.5 7 1.5-4h3.5',
  inbox: 'M2.5 9l1.8-5.5h7.4L13.5 9v4.5h-11zM2.5 9h3l1 1.5h3l1-1.5h3',
  tasks: 'M3 4.5l1.2 1.2L6.5 3.5M3 10.5l1.2 1.2 2.3-2.2M8.5 4.5h4.5M8.5 10.5h4.5',
  cpu: 'M4.5 4.5h7v7h-7zM6.5 6.5h3v3h-3zM6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2',
  diff: 'M5 2.5v7M2.5 6h5M8.5 12.5h5M5 12.5a1 1 0 1 1 0 .01M11 3.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  chevronDown: 'M4.5 6.5L8 10l3.5-3.5',
  chevronRight: 'M6.5 4.5L10 8l-3.5 3.5',
  eye: 'M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8zM8 6.3a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4z',
  eyeOff: 'M2.5 2.5l11 11M6.6 4a5.6 5.6 0 0 1 1.4-.2c4 0 6.2 4.2 6.2 4.2a10 10 0 0 1-1.7 2.2M4.3 5.3C2.7 6.4 1.8 8 1.8 8s2.2 4.2 6.2 4.2c.8 0 1.5-.2 2.2-.4',
  spark: 'M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z',
  pulse: 'M8 3a5 5 0 1 1 0 10A5 5 0 0 1 8 3z',
  user: 'M8 3a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 13.5a5 5 0 0 1 10 0',
  briefcase: 'M2.5 5.5h11v7.5h-11zM6 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M2.5 9h11',
  layers: 'M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8.5l5.5 3 5.5-3M2.5 11l5.5 3 5.5-3',
  wifi: 'M2 6.2a9 9 0 0 1 12 0M4 8.6a6 6 0 0 1 8 0M6.1 11a3 3 0 0 1 3.8 0M8 13h.01',
  telegram: 'M13.5 3L2.5 7.3l3.6 1.3 1.4 4.4 2.1-2.5 3 2.2zM6.1 8.6l5.4-3.6',
  money: 'M2.5 4.5h11v7h-11zM8 6.3a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4zM4.5 8h.01M11.5 8h.01',
  auto: 'M8.7 2L4 9h3.5l-.7 5L11.5 7H8z',
  ram: 'M2 5h12v5.5H2zM4.5 7h1.5M7.25 7h1.5M10 7h1.5M4 10.5v2M6.5 10.5v2M9.5 10.5v2M12 10.5v2',
  disk: 'M2 5h12v6H2zM2 8h12M4 9.6h3.5M11.6 9.6h.01M4 6.4h3.5M11.6 6.4h.01',
  gpu: 'M1.8 4.5h12.4v6.5H1.8zM4.5 11v2M11.5 11v2M6 6.3a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8zM10 7h2.5M10 9.4h2.5',
} as const

export type IconName = keyof typeof PATHS
export const ICON_NAMES = Object.keys(PATHS) as IconName[]

export function Icon({
  name,
  size = 14,
  className,
  strokeWidth = 1.5,
  ...rest
}: { name: IconName; size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={cx('shrink-0', className)}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
