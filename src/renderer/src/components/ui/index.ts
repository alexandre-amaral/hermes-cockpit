// Kit de primitivas do cockpit (components/ui). Leves, sem deps, só Tailwind +
// utilitárias de index.css. Use nas próximas rodadas em vez de recriar botões.
//
//   Button        variant primary|secondary|outline|ghost|danger · size xs|sm|md · loading · icon
//   IconButton    botão só-ícone; `label` obrigatório (aria); `active` = realce âmbar
//   Tabs          role=tablist com setas; variant "pill" (segmentado) | "line"; badge por aba
//   Badge / Dot   rótulo/contador (count → 99+); Dot com `pulse` (hc-pulse-dot)
//   Kbd           atalho: <Kbd keys="⌘K"/> ou keys={['⌘','1']}
//   Skeleton      bloco hc-shimmer; SkeletonLines para listas
//   Spinner       giro leve, herda cor do texto
//   EmptyState    vazio/erro/indisponível honesto (tone neutral|warn|error, action, art = ilustração SVG)
//   Icon          ícones SVG inline consistentes: <Icon name="chat" size={14}/> (lista em ICON_NAMES)
//   CountUp       número animado (hc-count) · Gauge radial · Sparkline SVG (ui/Viz)
//   RadialMeter   donut de progresso (0% = só trilho, 100% = anel fechado) · RadialStat = cartão ícone+donut+detalhe
//   Tooltip       hover/foco com atraso; para o trivial use `title`
//   ConfirmButton 2 cliques com contagem regressiva (destrutivos; nunca window.confirm)
//   Toaster       montado pelo App; dispare com toast() de lib/toast.ts
//   cx            junta classes
//
// Utilitárias CSS (index.css, aceitam variantes Tailwind): hc-fade-in, hc-rise,
// hc-sink, hc-pop, hc-view-in, hc-shimmer, hc-pulse-dot, hc-glass, hc-glow-amber,
// hc-edge-active (borda gradiente de card ativo), hc-surface, hc-press, hc-scrim,
// hc-spin, hc-slide-left/right, hc-card, hc-card-hover, hc-aurora, hc-scan, hc-count,
// hc-stagger, hc-glow-phos, hc-glow-cyan, hc-lift, hc-float, hc-draw. Cor do espaço:
// bg-space/text-space/border-space (âmbar Houer · ciano Pessoal · neutro Tudo). Tokens: --hc-dur-1..4, --hc-ease-out|in|std|spring,
// --hc-shadow-1..3. prefers-reduced-motion desliga tudo.
//
// Shell: views centrais recebem useViewActive() (components/layout/views.tsx)
// para pausar polling quando escondidas.
export { Badge, Dot, type BadgeTone } from './Badge'
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button'
export { ConfirmButton } from './ConfirmButton'
export { cx } from './cx'
export { EmptyArtSvg, EmptyState, type EmptyArt } from './EmptyState'
export { ICON_NAMES, Icon, type IconName } from './Icon'
export { CountUp, Gauge, Sparkline } from './Viz'
export { RadialMeter, RadialStat, type RadialMeterProps } from './RadialMeter'
export { IconButton, type IconButtonProps } from './IconButton'
export { Kbd } from './Kbd'
export { Skeleton, SkeletonLines } from './Skeleton'
export { Spinner } from './Spinner'
export { Tabs, type TabItem } from './Tabs'
export { Toaster } from './Toaster'
export { Tooltip } from './Tooltip'
