import { createContext, use, useMemo } from "react";
import type { ReactNode } from "react";

/** Display scale for `<Metric>` values and supporting copy. */
export type MetricSize = "compact" | "default" | "hero";

/** Text alignment inside `<Metric>`. */
export type MetricAlign = "start" | "center";

/** Equal-column grid counts `<Metrics>` supports in row layout. */
export type MetricsColumns = 2 | 3 | 4;

/** Axis along which `<Metrics>` arranges its `<Metric>` items. */
export type MetricsDirection = "row" | "column";

/** The props a slide gives `<Metrics>`. */
export type MetricsProps = {
  /** Equal grid columns when `direction` is `"row"`. Omit to flow horizontally at natural width. */
  readonly columns?: MetricsColumns;
  /** Arrangement axis. Defaults to `"row"`. */
  readonly direction?: MetricsDirection;
  /** Draws 1px structural hairlines framing and separating items. Defaults to `false`. */
  readonly dividers?: boolean;
  /** Default display size inherited by child `<Metric>` items unless overridden. */
  readonly size?: MetricSize;
  /** Default text alignment inherited by child `<Metric>` items unless overridden. */
  readonly align?: MetricAlign;
  readonly className?: string;
  readonly children?: ReactNode;
};

/** The props a slide gives `<Metric>`. */
export type MetricProps = {
  /** The headline number or short figure, such as `"94"`, `"6,7×"` or `"12 uker"`. */
  readonly value: ReactNode;
  /** Optional short noun naming what `value` measures, such as `"Komponenter"`. */
  readonly label?: ReactNode;
  /** Optional supporting line rendered below `label` in muted text. */
  readonly detail?: ReactNode;
  /** Display scale. Inherits from `<Metrics>`, otherwise defaults to `"default"`. */
  readonly size?: MetricSize;
  /** Text alignment. Inherits from `<Metrics>`, otherwise defaults to `"start"`. */
  readonly align?: MetricAlign;
  readonly className?: string;
};

type MetricsContextValue = {
  readonly size: MetricSize | undefined;
  readonly align: MetricAlign | undefined;
};

const MetricsContext = createContext<MetricsContextValue | null>(null);

/**
 * Arranges `<Metric>` items in a horizontal band, equal-column grid or vertical stack, with
 * optional 1px structural hairlines and shared `size` and `align` defaults.
 */
export function Metrics({
  columns,
  direction = "row",
  dividers = false,
  size,
  align,
  className,
  children,
}: MetricsProps) {
  const contextValue = useMemo<MetricsContextValue>(() => ({ size, align }), [size, align]);

  return (
    <MetricsContext value={contextValue}>
      <div
        className={className === undefined ? "deck-metrics" : `deck-metrics ${className}`}
        data-direction={direction}
        data-columns={direction === "row" && columns !== undefined ? String(columns) : undefined}
        data-dividers={dividers ? "" : undefined}>
        {children}
      </div>
    </MetricsContext>
  );
}

/**
 * Displays one headline figure with optional `label` and muted `detail`, tuned with optical
 * display tracking and tabular numerals for 1920x1080 slides. Composes inside `<Metrics>`,
 * `<SpotlightCard>`, `<Split>` or standalone.
 */
export function Metric({ value, label, detail, size, align, className }: MetricProps) {
  const group = use(MetricsContext);
  const resolvedSize = size ?? group?.size ?? "default";
  const resolvedAlign = align ?? group?.align ?? "start";
  const hasLabel = label !== undefined && label !== "";
  const hasDetail = detail !== undefined && detail !== "";

  return (
    <div
      className={className === undefined ? "deck-metric" : `deck-metric ${className}`}
      data-size={resolvedSize}
      data-align={resolvedAlign}>
      <div className="deck-metric-value">{value}</div>
      {(hasLabel || hasDetail) && (
        <div className="deck-metric-copy">
          {hasLabel && <div className="deck-metric-label">{label}</div>}
          {hasDetail && <p className="deck-metric-detail">{detail}</p>}
        </div>
      )}
    </div>
  );
}
