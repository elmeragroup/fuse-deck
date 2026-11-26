import { createContext, use, useCallback, useEffect, useMemo, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";

/** Programmatic pointer coordinates in `<Bento>`'s local CSS pixel space. */
export type BentoCursor = {
  /** Horizontal position in pixels from `<Bento>`'s left edge. */
  readonly x: number;
  /** Vertical position in pixels from `<Bento>`'s top edge. */
  readonly y: number;
  /** Whether the cursor is pressing down, subtly intensifying the card light. */
  readonly pressed?: boolean;
};

/** The props a slide gives `<Bento>`. */
export type BentoProps = {
  /** Number of equal grid columns on the slide canvas. Defaults to `4`. */
  readonly columns?: 2 | 3 | 4;
  /** Optional explicit row count filling the container height evenly. */
  readonly rows?: 2 | 3;
  /** Space between tiles in canvas pixels. Defaults to `18`. */
  readonly gap?: number;
  /** Enables coordinated radial spotlight and border proximity glow across tiles. Defaults to `true`. */
  readonly spotlight?: boolean;
  /** Optional programmatic cursor position in `<Bento>`'s local pixels to drive card spotlights. */
  readonly cursor?: BentoCursor | null;
  readonly className?: string;
  readonly children?: ReactNode;
};

/** The props a slide gives `<SpotlightCard>`. */
export type SpotlightCardProps = {
  /** Number of grid columns this tile spans inside `<Bento>`. Defaults to `1`. */
  readonly colSpan?: 1 | 2 | 3 | 4;
  /** Number of grid rows this tile spans inside `<Bento>`. Defaults to `1`. */
  readonly rowSpan?: 1 | 2 | 3;
  /** Optional concise tile title rendered in the card footer. */
  readonly title?: string;
  /** Optional short supporting line rendered below `title`. */
  readonly description?: string;
  /** Enables radial spotlight and border glow on this card. Defaults to `true`. */
  readonly spotlight?: boolean;
  /** Marks the tile as currently highlighted, such as during a choreographed walkthrough. */
  readonly active?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
};

type CardEntry = {
  readonly element: HTMLDivElement;
  readonly enabled: boolean;
};

type BentoContextValue = {
  readonly spotlightEnabled: boolean;
  readonly registerCard: (entry: CardEntry) => () => void;
};

const BentoContext = createContext<BentoContextValue | null>(null);

const BORDER_PROXIMITY = 150;

function clearCardSpotlight(card: HTMLDivElement): void {
  card.style.setProperty("--deck-spot-alpha", "0");
  card.style.setProperty("--deck-spot-edge", "0");
  card.style.setProperty("--deck-spot-press", "0");
}

function paintCardSpotlight(
  card: HTMLDivElement,
  localX: number,
  localY: number,
  width: number,
  height: number,
  pressed: boolean
): void {
  const dx = Math.max(0, -localX, localX - width);
  const dy = Math.max(0, -localY, localY - height);
  const distance = Math.hypot(dx, dy);

  if (distance >= BORDER_PROXIMITY) {
    clearCardSpotlight(card);
    return;
  }

  const inside = distance === 0;
  const edge = inside ? 1 : Math.pow(1 - distance / BORDER_PROXIMITY, 2);
  const alpha = inside ? 1 : edge * 0.18;

  card.style.setProperty("--deck-spot-x", `${localX.toFixed(1)}px`);
  card.style.setProperty("--deck-spot-y", `${localY.toFixed(1)}px`);
  card.style.setProperty("--deck-spot-alpha", alpha.toFixed(3));
  card.style.setProperty("--deck-spot-edge", edge.toFixed(3));
  card.style.setProperty("--deck-spot-press", inside && pressed ? "1" : "0");
}

/**
 * Neutral asymmetric bento grid for composing `<SpotlightCard>` tiles on a slide. Tracks fine
 * pointer movement and optional programmatic cursor coordinates to coordinate surface spotlights
 * and border proximity glow across neighboring cards.
 */
export function Bento({
  columns = 4,
  rows,
  gap = 18,
  spotlight = true,
  cursor = null,
  className,
  children,
}: BentoProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<Set<CardEntry>>(new Set());
  const pointerActiveRef = useRef(false);

  const registerCard = useCallback((entry: CardEntry) => {
    cardsRef.current.add(entry);
    return () => {
      cardsRef.current.delete(entry);
    };
  }, []);

  const contextValue = useMemo<BentoContextValue>(
    () => ({
      spotlightEnabled: spotlight,
      registerCard,
    }),
    [spotlight, registerCard]
  );

  // Drive coordinated card spotlights from real fine-pointer movement.
  useEffect(() => {
    const grid = gridRef.current;
    if (grid === null || !spotlight) {
      for (const entry of cardsRef.current) {
        clearCardSpotlight(entry.element);
      }
      return;
    }

    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    let pressed = false;

    const paintFromClient = (clientX: number, clientY: number) => {
      if (reducedQuery.matches || !finePointer.matches) {
        return;
      }
      for (const entry of cardsRef.current) {
        if (!entry.enabled) {
          clearCardSpotlight(entry.element);
          continue;
        }
        const rect = entry.element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const scaleX = entry.element.offsetWidth / rect.width;
        const scaleY = entry.element.offsetHeight / rect.height;
        const localX = (clientX - rect.left) * scaleX;
        const localY = (clientY - rect.top) * scaleY;
        paintCardSpotlight(
          entry.element,
          localX,
          localY,
          entry.element.offsetWidth,
          entry.element.offsetHeight,
          pressed
        );
      }
    };

    const clearAll = () => {
      pointerActiveRef.current = false;
      pressed = false;
      for (const entry of cardsRef.current) {
        clearCardSpotlight(entry.element);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (reducedQuery.matches || !finePointer.matches) {
        return;
      }
      const gridRect = grid.getBoundingClientRect();
      const nearGrid =
        event.clientX >= gridRect.left - BORDER_PROXIMITY &&
        event.clientX <= gridRect.right + BORDER_PROXIMITY &&
        event.clientY >= gridRect.top - BORDER_PROXIMITY &&
        event.clientY <= gridRect.bottom + BORDER_PROXIMITY;
      if (!nearGrid) {
        if (pointerActiveRef.current) {
          clearAll();
        }
        return;
      }
      pointerActiveRef.current = true;
      paintFromClient(event.clientX, event.clientY);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!pointerActiveRef.current) {
        return;
      }
      pressed = true;
      paintFromClient(event.clientX, event.clientY);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!pressed) {
        return;
      }
      pressed = false;
      if (pointerActiveRef.current) {
        paintFromClient(event.clientX, event.clientY);
      }
    };

    const onPointerLeave = () => {
      if (pointerActiveRef.current) {
        clearAll();
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    reducedQuery.addEventListener("change", clearAll);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      reducedQuery.removeEventListener("change", clearAll);
    };
  }, [spotlight]);

  // Drive coordinated card spotlights from an optional programmatic cursor (e.g. a stageshow walkthrough).
  useEffect(() => {
    const grid = gridRef.current;
    if (grid === null || !spotlight || pointerActiveRef.current) {
      return;
    }
    if (cursor === null) {
      for (const entry of cardsRef.current) {
        clearCardSpotlight(entry.element);
      }
      return;
    }
    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reducedQuery.matches) {
      return;
    }

    const gridRect = grid.getBoundingClientRect();
    if (gridRect.width <= 0 || gridRect.height <= 0) {
      return;
    }
    const scaleX = grid.offsetWidth / gridRect.width;
    const scaleY = grid.offsetHeight / gridRect.height;

    for (const entry of cardsRef.current) {
      if (!entry.enabled) {
        clearCardSpotlight(entry.element);
        continue;
      }
      const cardRect = entry.element.getBoundingClientRect();
      const cardOffsetX = (cardRect.left - gridRect.left) * scaleX;
      const cardOffsetY = (cardRect.top - gridRect.top) * scaleY;
      paintCardSpotlight(
        entry.element,
        cursor.x - cardOffsetX,
        cursor.y - cardOffsetY,
        entry.element.offsetWidth,
        entry.element.offsetHeight,
        cursor.pressed === true
      );
    }
  }, [spotlight, cursor]);

  const gridStyle: CSSProperties = { gap: `${String(gap)}px` };

  return (
    <BentoContext value={contextValue}>
      <div
        ref={gridRef}
        className={className === undefined ? "deck-bento" : `deck-bento ${className}`}
        data-columns={String(columns)}
        data-rows={rows === undefined ? undefined : String(rows)}
        data-spotlight={spotlight ? "on" : "off"}
        style={gridStyle}>
        {children}
      </div>
    </BentoContext>
  );
}

/**
 * Neutral Fuse-token card surface with a subtle radial spotlight and border proximity glow.
 * Works standalone or coordinated inside `<Bento>`, with optional `colSpan`, `rowSpan`, `title`,
 * and `description`.
 */
export function SpotlightCard({
  colSpan = 1,
  rowSpan = 1,
  title,
  description,
  spotlight = true,
  active = false,
  className,
  children,
}: SpotlightCardProps) {
  const bento = use(BentoContext);
  const cardRef = useRef<HTMLDivElement>(null);
  const enabled = spotlight && (bento === null || bento.spotlightEnabled);

  useEffect(() => {
    const card = cardRef.current;
    if (card === null) {
      return;
    }
    if (bento !== null) {
      return bento.registerCard({ element: card, enabled });
    }
    if (!enabled) {
      clearCardSpotlight(card);
      return;
    }

    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    let pressed = false;

    const paintFromClient = (clientX: number, clientY: number) => {
      if (reducedQuery.matches || !finePointer.matches) {
        return;
      }
      const rect = card.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const localX = (clientX - rect.left) * (card.offsetWidth / rect.width);
      const localY = (clientY - rect.top) * (card.offsetHeight / rect.height);
      paintCardSpotlight(card, localX, localY, card.offsetWidth, card.offsetHeight, pressed);
    };

    const onPointerMove = (event: PointerEvent) => {
      paintFromClient(event.clientX, event.clientY);
    };
    const onPointerDown = (event: PointerEvent) => {
      pressed = true;
      paintFromClient(event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent) => {
      pressed = false;
      paintFromClient(event.clientX, event.clientY);
    };
    const onClear = () => {
      pressed = false;
      clearCardSpotlight(card);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    card.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    document.documentElement.addEventListener("pointerleave", onClear);
    reducedQuery.addEventListener("change", onClear);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      card.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      document.documentElement.removeEventListener("pointerleave", onClear);
      reducedQuery.removeEventListener("change", onClear);
    };
  }, [bento, enabled]);

  const hasFooter =
    (title !== undefined && title !== "") || (description !== undefined && description !== "");

  return (
    <div
      ref={cardRef}
      className={className === undefined ? "deck-spotlight-card" : `deck-spotlight-card ${className}`}
      data-col-span={colSpan > 1 ? String(colSpan) : undefined}
      data-row-span={rowSpan > 1 ? String(rowSpan) : undefined}
      data-active={active ? "" : undefined}
      data-spotlight={enabled ? "on" : "off"}>
      <span className="deck-spotlight-light" aria-hidden="true" />
      <span className="deck-spotlight-border" aria-hidden="true" />
      <div className="deck-spotlight-content">{children}</div>
      {hasFooter && (
        <div className="deck-spotlight-footer">
          {title !== undefined && title !== "" && <div className="deck-spotlight-title">{title}</div>}
          {description !== undefined && description !== "" && (
            <p className="deck-spotlight-description">{description}</p>
          )}
        </div>
      )}
    </div>
  );
}
