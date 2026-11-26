/**
 * Public browser runtime components that deck-local `.tsx` modules can import via
 * `@elmeragroup/fuse-deck/components`. Built alongside `main.tsx` so both entries share the same
 * React contexts (`RevealedSteps`, `SlideBackdrop`, `Bento`).
 */
export { Bento, SpotlightCard } from "./bento.tsx";
export type { BentoCursor, BentoProps, SpotlightCardProps } from "./bento.tsx";
export { ElmeraCover } from "./elmera-cover.tsx";
export type { ElmeraCoverBackground, ElmeraCoverProps } from "./elmera-cover.tsx";
export { Metric, Metrics } from "./metrics.tsx";
export type {
  MetricAlign,
  MetricProps,
  MetricsColumns,
  MetricsDirection,
  MetricSize,
  MetricsProps,
} from "./metrics.tsx";
export { Morph } from "./morph.tsx";
export type { MorphProps } from "./morph.tsx";
export { Split } from "./split.tsx";
export type { SplitAlign, SplitProps, SplitRatio } from "./split.tsx";
export { Step } from "./step.tsx";
export type { StepProps } from "./step.tsx";
export { Video } from "./video.tsx";
export type { VideoProps } from "./video.tsx";
