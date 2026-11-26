import { createContext, use, useCallback, useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";

import { GhostFiberCanvas } from "./ghost-fiber.tsx";
import { useStepVisible } from "./step.tsx";

type RegisterSlideBackdrop = () => () => void;

const SlideBackdropContext = createContext<RegisterSlideBackdrop | null>(null);

/**
 * Provides a lazy slide-level backdrop as a direct child of `.deck-slide`, rendered after slide
 * content only while at least one revealed `<GhostFiberBackground>` demands it. Reference-counting
 * keeps one shared canvas mounted even when multiple ghost-fiber covers appear on the same slide,
 * while plain slides render zero `.deck-slide-backdrop` DOM nodes.
 */
export function SlideBackdrop({ children }: { readonly children?: ReactNode }) {
  const [activeCount, setActiveCount] = useState(0);

  const register = useCallback(() => {
    setActiveCount((count) => count + 1);
    return () => {
      setActiveCount((count) => count - 1);
    };
  }, []);

  return (
    <>
      <SlideBackdropContext value={register}>{children}</SlideBackdropContext>
      {activeCount > 0 && (
        <div className="deck-slide-backdrop" aria-hidden="true">
          <GhostFiberCanvas />
        </div>
      )}
    </>
  );
}

/**
 * Registers ghost-fiber backdrop demand with the enclosing `<SlideBackdrop>` while every
 * enclosing `<Step>` ancestor is revealed.
 */
export function GhostFiberBackground() {
  const visible = useStepVisible();
  const register = use(SlideBackdropContext);

  useLayoutEffect(() => {
    if (!visible || register === null) {
      return;
    }
    return register();
  }, [visible, register]);

  return null;
}
