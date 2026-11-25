import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  ViewTransition,
} from "react";
import type { ComponentType } from "react";

import type { LayoutName } from "../deck/vocabulary.ts";
import { bridgeParent, reportPosition, requestedPosition } from "./bridge.ts";
import { ElmeraCover } from "./elmera-cover.tsx";
import { LAYOUTS } from "./layouts.tsx";
import type { ManifestEmbedder, MdxComponents } from "./manifest.ts";
import { Morph } from "./morph.tsx";
import { fromHash, moveForKey, moveTo, toHash } from "./position.ts";
import type { Position } from "./position.ts";
import { Split } from "./split.tsx";
import { RevealedSteps, Step } from "./step.tsx";
import { Video } from "./video.tsx";

/** The components every slide gets without an import. */
const MDX_COMPONENTS = { Step, Morph, Video, Split, ElmeraCover } satisfies MdxComponents;

/** A slide, loaded. */
export type LoadedSlide = {
  readonly id: string;
  readonly title: string | null;
  readonly layout: LayoutName;
  readonly steps: number;
  readonly Content: ComponentType<{ readonly components: MdxComponents }>;
};

/** The deck the runtime renders. */
export type LoadedDeck = {
  readonly title: string;
  readonly aspect: "16:9" | "4:3";
  /** The studio page that frames the deck, which turns on the preview bridge, or null. */
  readonly embedder: ManifestEmbedder | null;
  readonly slides: readonly LoadedSlide[];
};

/** The logical canvas size per aspect, scaled to fit the window. */
const CANVAS = { "16:9": { width: 1920, height: 1080 }, "4:3": { width: 1440, height: 1080 } } as const;

/**
 * Where a position came from. A move through the deck adds a history entry; a position read from
 * the address, at load or on Back, Forward or an edited hash, only corrects that entry when the
 * deck clamps it, so Back never returns to an address that clamps forward again.
 */
type Source = "navigation" | "address";

/**
 * The deck. A slide change runs in a transition, so it animates as a view transition and React
 * queues and batches presses that arrive while one runs. A step change is a synchronous update, so
 * it never starts a view transition. The URL hash mirrors the position; the first position comes
 * from the hash before the first paint, and Back and Forward animate only when the slide changes.
 * In the studio's preview it reports each committed position to the studio and goes where the
 * studio asks.
 */
export function Deck({ deck }: { readonly deck: LoadedDeck }) {
  const [current, setCurrent] = useState<{
    readonly position: Position;
    readonly source: Source;
    /** The studio request this position answers, or null for a move of the user's or the address's. */
    readonly requestId: string | null;
  }>(() => ({
    position: fromHash(location.hash, deck.slides),
    source: "address",
    requestId: null,
  }));
  const { position } = current;
  // The position the latest key press asked for, which a pending transition has not committed yet.
  const target = useRef(position);
  const committed = useRef(position);

  useLayoutEffect(() => {
    committed.current = position;
  }, [position]);

  // After each committed change, and once after every load. A position the studio asked for is
  // reported under its request id, even when it was already the position shown.
  const { requestId } = current;
  useEffect(() => {
    const parent = bridgeParent(deck.embedder);
    if (parent !== null) {
      reportPosition(parent, position, deck.slides, requestId);
    }
  }, [deck.embedder, position, deck.slides, requestId]);

  useEffect(() => {
    const go = (next: Position, source: Source, requestId: string | null = null) => {
      target.current = next;
      if (next.slide === committed.current.slide) {
        setCurrent({ position: next, source, requestId });
      } else {
        startTransition(() => {
          setCurrent({ position: next, source, requestId });
        });
      }
    };
    const onKey = (event: KeyboardEvent) => {
      // A control in the slide that handled the key, such as a slider, a video or an open overlay, keeps it.
      if (
        event.defaultPrevented ||
        document.querySelector("[data-deck-overlay='open']") !== null ||
        ownsKey(event.target, event.key)
      ) {
        return;
      }
      const move = moveForKey(event);
      if (move !== null) {
        event.preventDefault();
        go(moveTo(target.current, move, deck.slides), "navigation");
      }
    };
    const onPopState = () => {
      const next = fromHash(location.hash, deck.slides);
      if (next.slide === committed.current.slide) {
        go(next, "address");
        return;
      }
      // React commits a transition started during `popstate` eagerly, so the browser can restore
      // scroll, and an eager commit runs no view transition. Starting it from the next task keeps
      // the slide change animated.
      setTimeout(() => {
        go(next, "address");
      });
    };
    const parent = bridgeParent(deck.embedder);
    const onMessage = (event: MessageEvent) => {
      const next = parent === null ? null : requestedPosition(parent, event, deck.slides);
      if (next !== null) {
        go(next.position, "navigation", next.requestId);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPopState);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("message", onMessage);
    };
  }, [deck.slides, deck.embedder]);

  useEffect(() => {
    const hash = toHash(current.position, deck.slides);
    if (hash === location.hash) {
      return;
    }
    if (current.source === "address") {
      history.replaceState(null, "", hash);
    } else {
      history.pushState(null, "", hash);
    }
  }, [current, deck.slides]);

  useEffect(() => {
    document.title = deck.title;
  }, [deck.title]);

  const slide = deck.slides[position.slide];
  const canvas = CANVAS[deck.aspect];
  const scale = useSyncExternalStore(subscribeToResize, () =>
    Math.min(window.innerWidth / canvas.width, window.innerHeight / canvas.height)
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    viewportRef.current?.style.setProperty("--deck-scale", String(scale));
  }, [scale]);
  if (slide === undefined) {
    return <p className="deck-empty">The deck has no slides.</p>;
  }
  const Layout = LAYOUTS[slide.layout];
  const { Content } = slide;

  return (
    <div ref={viewportRef} className="deck-viewport">
      <div
        className="deck-canvas"
        data-aspect={deck.aspect}
        style={{ width: canvas.width, height: canvas.height, scale: String(scale) }}>
        <ViewTransition default="none" update="deck-slide">
          <section
            key={slide.id}
            className="deck-slide"
            data-layout={slide.layout}
            aria-roledescription="slide"
            aria-label={slide.title ?? `Slide ${String(position.slide + 1)}`}>
            <RevealedSteps value={position.step}>
              <Layout>
                <Content components={MDX_COMPONENTS} />
              </Layout>
            </RevealedSteps>
          </section>
        </ViewTransition>
      </div>
      <p className="deck-live" aria-live="polite" aria-atomic="true">
        {`Slide ${String(position.slide + 1)} of ${String(deck.slides.length)}`}
      </p>
    </div>
  );
}

function subscribeToResize(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
  };
}

/** Controls that use Enter and Space themselves. */
const ACTIVATABLE =
  "a[href], button, summary, [role='button'], [role='link'], [role='checkbox'], [role='switch'], [role='tab'], [role='menuitem'], [role='option']";

/** Keys a focused `<video>` or `<audio>` element uses for playback, seeking and volume. */
const MEDIA_KEYS = new Set([" ", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * Whether the focused element needs the key more than the deck: every key in a text field, media
 * keys on a `<video>` or `<audio>` element, and Enter and Space on a control that a press
 * activates.
 */
function ownsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
    return true;
  }
  if (MEDIA_KEYS.has(key) && target.closest("video, audio") !== null) {
    return true;
  }
  return (key === "Enter" || key === " ") && target.closest(ACTIVATABLE) !== null;
}
