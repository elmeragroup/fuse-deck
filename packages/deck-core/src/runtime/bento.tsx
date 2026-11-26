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
  /** The grid's declared column count, which caps a tile's column span. */
  readonly columns: NonNullable<BentoProps["columns"]>;
  /** The grid's declared row count, which caps a tile's row span when it is set. */
  readonly rows: BentoProps["rows"];
  readonly registerCard: (entry: CardEntry) => () => void;
};

const BentoContext = createContext<BentoContextValue | null>(null);

const BORDER_PROXIMITY = 150;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const FINE_POINTER = "(hover: hover) and (pointer: fine)";

/** Whether `event` comes from a touch contact, which never drives the real-pointer light. */
function isTouch(event: PointerEvent): boolean {
  return event.pointerType === "touch";
}

/** A tile's own transitions change no layout, so only the ones outside every tile reflow it. */
function isOutsideCards(event: Event): boolean {
  return event.target instanceof Element && event.target.closest(".deck-spotlight-card") === null;
}

/** A point in viewport coordinates, as pointer events and `getBoundingClientRect` give them. */
type ClientPoint = {
  readonly clientX: number;
  readonly clientY: number;
};

/** What lights a grid's cards: a viewport point and whether it presses. */
type SpotlightInput = ClientPoint & {
  readonly pressed: boolean;
};

function clearCardSpotlight(card: HTMLDivElement): void {
  card.style.setProperty("--deck-spot-alpha", "0");
  card.style.setProperty("--deck-spot-edge", "0");
  card.style.setProperty("--deck-spot-press", "0");
}

function clearCards(cards: Iterable<CardEntry>): void {
  for (const entry of cards) {
    clearCardSpotlight(entry.element);
  }
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
 * Paints `card` from viewport coordinates, mapped into the card's own CSS pixels so the scaled
 * deck canvas does not shift the light.
 */
function paintCardAtClient(card: HTMLDivElement, clientX: number, clientY: number, pressed: boolean): void {
  const rect = card.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  paintCardSpotlight(
    card,
    (clientX - rect.left) * (width / rect.width),
    (clientY - rect.top) * (height / rect.height),
    width,
    height,
    pressed
  );
}

/** The viewport point of `x`, `y` in `element`'s own CSS pixels, or null while it has no size. */
function clientPointIn(element: HTMLElement, x: number, y: number): ClientPoint | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || element.offsetWidth <= 0 || element.offsetHeight <= 0) {
    return null;
  }
  return {
    clientX: rect.left + x * (rect.width / element.offsetWidth),
    clientY: rect.top + y * (rect.height / element.offsetHeight),
  };
}

/** Whether a viewport point lies within `BORDER_PROXIMITY` of `element`'s CSS pixels on each axis. */
function isNear(element: HTMLElement, point: ClientPoint): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || element.offsetWidth <= 0 || element.offsetHeight <= 0) {
    return false;
  }
  const marginX = BORDER_PROXIMITY * (rect.width / element.offsetWidth);
  const marginY = BORDER_PROXIMITY * (rect.height / element.offsetHeight);
  return (
    point.clientX >= rect.left - marginX &&
    point.clientX <= rect.right + marginX &&
    point.clientY >= rect.top - marginY &&
    point.clientY <= rect.bottom + marginY
  );
}

/**
 * The input that lights `grid`'s cards: the real pointer while it is a fine pointer near the grid,
 * otherwise the scripted cursor, which works without a fine pointer. Null when neither is active.
 */
function currentInput(
  grid: HTMLElement,
  pointer: ClientPoint | null,
  pressed: boolean,
  cursor: BentoCursor | null
): SpotlightInput | null {
  if (pointer !== null && window.matchMedia(FINE_POINTER).matches && isNear(grid, pointer)) {
    return { ...pointer, pressed };
  }
  if (cursor === null) {
    return null;
  }
  const point = clientPointIn(grid, cursor.x, cursor.y);
  return point === null ? null : { ...point, pressed: cursor.pressed === true };
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
  // The latest inputs, read by `repaint` whichever event runs it.
  const spotlightRef = useRef(spotlight);
  const cursorRef = useRef(cursor);
  const pointerRef = useRef<ClientPoint | null>(null);
  const pressedRef = useRef(false);
  // Whether a card may still hold light, so an idle pointer elsewhere on the page writes nothing.
  const litRef = useRef(false);

  /**
   * Paints every card from the current input: the real pointer while it is a fine pointer near the
   * grid, otherwise the scripted cursor. Clears every card when the spotlight is off, motion is
   * reduced or neither input is active.
   */
  const repaint = useCallback(() => {
    const grid = gridRef.current;
    const cards = cardsRef.current;
    const input =
      grid === null || !spotlightRef.current || window.matchMedia(REDUCED_MOTION).matches
        ? null
        : currentInput(grid, pointerRef.current, pressedRef.current, cursorRef.current);
    if (input === null) {
      if (litRef.current) {
        clearCards(cards);
        litRef.current = false;
      }
      return;
    }
    litRef.current = true;
    for (const entry of cards) {
      if (entry.enabled) {
        paintCardAtClient(entry.element, input.clientX, input.clientY, input.pressed);
      } else {
        clearCardSpotlight(entry.element);
      }
    }
  }, []);

  const frameRef = useRef<number | null>(null);

  /**
   * Repaints one animation frame from now, after the layout the trigger started has settled; a
   * later trigger replaces the pending frame. Does nothing once the grid has unmounted.
   */
  const scheduleRepaint = useCallback(() => {
    if (gridRef.current === null) {
      return;
    }
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      repaint();
    });
  }, [repaint]);

  // Watches the grid and every card for a size change; cards register before the grid's effects run.
  const observerRef = useRef<ResizeObserver | null>(null);
  const observer = useCallback(() => {
    observerRef.current ??= new ResizeObserver(scheduleRepaint);
    return observerRef.current;
  }, [scheduleRepaint]);

  const registerCard = useCallback(
    (entry: CardEntry) => {
      cardsRef.current.add(entry);
      observer().observe(entry.element);
      scheduleRepaint();
      return () => {
        cardsRef.current.delete(entry);
        observerRef.current?.unobserve(entry.element);
        scheduleRepaint();
      };
    },
    [observer, scheduleRepaint]
  );

  const contextValue = useMemo<BentoContextValue>(
    () => ({
      spotlightEnabled: spotlight,
      columns,
      rows,
      registerCard,
    }),
    [spotlight, columns, rows, registerCard]
  );

  // The props that move the input or the cards; the layout ones reflow the grid under the cursor.
  useEffect(() => {
    spotlightRef.current = spotlight;
    cursorRef.current = cursor;
    repaint();
  }, [spotlight, cursor, columns, rows, gap, repaint]);

  // The real pointer, the media queries, the window size and the grid's layout.
  useEffect(() => {
    const grid = gridRef.current;
    const reducedQuery = window.matchMedia(REDUCED_MOTION);
    const finePointer = window.matchMedia(FINE_POINTER);

    // Read in the capture phase, so a tile's own handler cannot hide a press or its release.
    const onPointer = (event: PointerEvent) => {
      if (isTouch(event)) {
        return;
      }
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      pressedRef.current = event.buttons !== 0;
      repaint();
    };
    const onPointerExit = (event: PointerEvent) => {
      if (isTouch(event)) {
        return;
      }
      pointerRef.current = null;
      pressedRef.current = false;
      repaint();
    };
    // A wrapper settling, such as a revealed `<Step>`, moves its tiles without resizing them.
    const onTransitionEnd = (event: TransitionEvent) => {
      if (isOutsideCards(event)) {
        scheduleRepaint();
      }
    };

    const capture = { capture: true, passive: true };
    window.addEventListener("pointermove", onPointer, capture);
    window.addEventListener("pointerdown", onPointer, capture);
    window.addEventListener("pointerup", onPointer, capture);
    window.addEventListener("pointercancel", onPointerExit, capture);
    document.documentElement.addEventListener("pointerleave", onPointerExit);
    reducedQuery.addEventListener("change", repaint);
    finePointer.addEventListener("change", repaint);
    // The deck applies a new canvas scale in the render after `resize`, a transform no observer sees.
    window.addEventListener("resize", scheduleRepaint);
    if (grid !== null) {
      observer().observe(grid);
      grid.addEventListener("transitionend", onTransitionEnd);
    }

    return () => {
      window.removeEventListener("pointermove", onPointer, capture);
      window.removeEventListener("pointerdown", onPointer, capture);
      window.removeEventListener("pointerup", onPointer, capture);
      window.removeEventListener("pointercancel", onPointerExit, capture);
      document.documentElement.removeEventListener("pointerleave", onPointerExit);
      reducedQuery.removeEventListener("change", repaint);
      finePointer.removeEventListener("change", repaint);
      window.removeEventListener("resize", scheduleRepaint);
      grid?.removeEventListener("transitionend", onTransitionEnd);
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [repaint, scheduleRepaint, observer]);

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
  // Inside `<Bento>` a tile spans at most the tracks the grid declares, so it never adds implicit ones.
  const columnSpan = bento === null ? colSpan : Math.min(colSpan, bento.columns);
  const rowCount = bento?.rows;
  const rowSpanned = rowCount === undefined ? rowSpan : Math.min(rowSpan, rowCount);

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

    const reducedQuery = window.matchMedia(REDUCED_MOTION);
    const finePointer = window.matchMedia(FINE_POINTER);

    // Read in the capture phase, so a handler inside the card cannot hide a press or its release.
    const onPointer = (event: PointerEvent) => {
      if (isTouch(event) || reducedQuery.matches || !finePointer.matches) {
        return;
      }
      paintCardAtClient(card, event.clientX, event.clientY, event.buttons !== 0);
    };
    const onClear = () => {
      clearCardSpotlight(card);
    };
    const onPointerExit = (event: PointerEvent) => {
      if (!isTouch(event)) {
        onClear();
      }
    };

    const capture = { capture: true, passive: true };
    window.addEventListener("pointermove", onPointer, capture);
    window.addEventListener("pointerdown", onPointer, capture);
    window.addEventListener("pointerup", onPointer, capture);
    window.addEventListener("pointercancel", onPointerExit, capture);
    document.documentElement.addEventListener("pointerleave", onPointerExit);
    reducedQuery.addEventListener("change", onClear);
    finePointer.addEventListener("change", onClear);

    return () => {
      window.removeEventListener("pointermove", onPointer, capture);
      window.removeEventListener("pointerdown", onPointer, capture);
      window.removeEventListener("pointerup", onPointer, capture);
      window.removeEventListener("pointercancel", onPointerExit, capture);
      document.documentElement.removeEventListener("pointerleave", onPointerExit);
      reducedQuery.removeEventListener("change", onClear);
      finePointer.removeEventListener("change", onClear);
    };
  }, [bento, enabled]);

  const hasTitle = title !== undefined && title !== "";
  const hasDescription = description !== undefined && description !== "";

  return (
    <div
      ref={cardRef}
      className={className === undefined ? "deck-spotlight-card" : `deck-spotlight-card ${className}`}
      data-col-span={columnSpan > 1 ? String(columnSpan) : undefined}
      data-row-span={rowSpanned > 1 ? String(rowSpanned) : undefined}
      data-active={active ? "" : undefined}
      data-spotlight={enabled ? "on" : "off"}>
      <span className="deck-spotlight-light" aria-hidden="true" />
      <span className="deck-spotlight-border" aria-hidden="true" />
      <div className="deck-spotlight-content">{children}</div>
      {(hasTitle || hasDescription) && (
        <div className="deck-spotlight-footer">
          {hasTitle && <div className="deck-spotlight-title">{title}</div>}
          {hasDescription && <p className="deck-spotlight-description">{description}</p>}
        </div>
      )}
    </div>
  );
}
