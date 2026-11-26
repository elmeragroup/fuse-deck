import { createContext, use, useCallback, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { createPortal } from "react-dom";

type SlideBackdropRegistration = {
  readonly host: HTMLDivElement | null;
  readonly register: () => () => void;
};

const SlideBackdropContext = createContext<SlideBackdropRegistration | null>(null);

/**
 * Provides a lazy slide-level backdrop mount point as a direct child of `.deck-slide`, rendered
 * after slide content only while at least one `<SlideBackdropPortal>` is active. Slide backgrounds
 * stay centered on the slide and behind every sibling without adding DOM nodes to plain slides.
 */
export function SlideBackdrop({ children }: { readonly children?: ReactNode }) {
  const [activeCount, setActiveCount] = useState(0);
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  const register = useCallback(() => {
    setActiveCount((count) => count + 1);
    return () => {
      setActiveCount((count) => count - 1);
    };
  }, []);

  const value = useMemo<SlideBackdropRegistration>(() => ({ host, register }), [host, register]);

  return (
    <>
      <SlideBackdropContext value={value}>{children}</SlideBackdropContext>
      {activeCount > 0 && <div ref={setHost} className="deck-slide-backdrop" aria-hidden="true" />}
    </>
  );
}

/**
 * Registers a slide-level backdrop with the enclosing `<SlideBackdrop>` and portals its children
 * into the slide's `.deck-slide-backdrop` host once committed.
 */
export function SlideBackdropPortal({ children }: { readonly children?: ReactNode }) {
  const backdrop = use(SlideBackdropContext);
  const register = backdrop?.register ?? null;

  useLayoutEffect(() => {
    if (register === null) {
      return;
    }
    return register();
  }, [register]);

  const host = backdrop?.host ?? null;
  if (host === null) {
    return null;
  }

  return createPortal(children, host);
}
