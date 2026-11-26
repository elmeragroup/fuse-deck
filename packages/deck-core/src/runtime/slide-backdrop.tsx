import { createContext, use, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * The slide-level backdrop mount point inside a `<Deck>`:
 * - `unmanaged`: rendered outside a `<Deck>`, so backdrops mount inline.
 * - `pending`: inside a `<Deck>` before the slide backdrop host commits, so backdrops wait instead
 *   of mounting inline and remounting.
 * - `ready`: inside a `<Deck>` with the slide backdrop host mounted and ready for portals.
 */
export type SlideBackdropHost =
  | { readonly _tag: "unmanaged" }
  | { readonly _tag: "pending" }
  | { readonly _tag: "ready"; readonly element: HTMLDivElement };

const UNMANAGED_HOST = { _tag: "unmanaged" } as const;
const PENDING_HOST = { _tag: "pending" } as const;

const SlideBackdropContext = createContext<SlideBackdropHost>(UNMANAGED_HOST);

/**
 * Provides a slide-level backdrop mount point as the first direct child of `.deck-slide`, so
 * slide backgrounds stay centered on the slide and behind every sibling even when the component
 * requesting them sits inside a positioned or stacked wrapper.
 */
export function SlideBackdrop({ children }: { readonly children?: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    setHost(hostRef.current);
  }, []);

  const value = useMemo<SlideBackdropHost>(
    () => (host === null ? PENDING_HOST : { _tag: "ready", element: host }),
    [host]
  );

  return (
    <>
      <div ref={hostRef} className="deck-slide-backdrop" aria-hidden="true" />
      <SlideBackdropContext value={value}>{children}</SlideBackdropContext>
    </>
  );
}

/** Returns the current slide's backdrop host state for portaling slide-level backgrounds. */
export function useSlideBackdropHost(): SlideBackdropHost {
  return use(SlideBackdropContext);
}
