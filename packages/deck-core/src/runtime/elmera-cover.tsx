import type { ReactNode } from "react";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { ElmeraGroupLogo } from "@elmeragroup/fuse/icons";

import { GhostFiberBackground } from "./slide-backdrop.tsx";

const DEFAULT_TAGLINE = "Preferred by more customers. Every day.";

/** Optional ambient background styles `<ElmeraCover>` supports. */
export type ElmeraCoverBackground = "none" | "ghost-fiber";

/** The props `<ElmeraCover.Tagline>` accepts, including Base UI's `render` prop for composition. */
export type ElmeraCoverTaglineProps = useRender.ComponentProps<"p">;

/** The props a slide gives `<ElmeraCover>`. */
export type ElmeraCoverProps = {
  /**
   * Shorthand text shown under the Elmera Group wordmark. Defaults to
   * `"Preferred by more customers. Every day."` when `children` are omitted. Pass `null` or `""`
   * to omit it.
   */
  readonly tagline?: string | null;
  /** Ambient background behind the cover. Defaults to `"none"`. */
  readonly background?: ElmeraCoverBackground;
  /** Composed slot content such as `<ElmeraCover.Tagline render={<a href="…" />} />`. */
  readonly children?: ReactNode;
};

/**
 * The tagline slot below the Elmera Group wordmark on `<ElmeraCover>`. Renders a `<p>` by default
 * and composes with any element or component through Base UI's `render` prop, merging classes,
 * refs and event handlers.
 */
export function ElmeraCoverTagline({ className, render, ref, ...props }: ElmeraCoverTaglineProps) {
  return useRender({
    defaultTagName: "p",
    ref,
    render,
    props: mergeProps<"p">(
      {
        className:
          className === undefined ? "deck-elmera-cover-tagline" : `deck-elmera-cover-tagline ${className}`,
      },
      props
    ),
  });
}

/**
 * Renders the neutral Elmera Group cover with Fuse's `ElmeraGroupLogo` wordmark and an Inter
 * tagline centered on the slide in the active theme's foreground and muted foreground tokens.
 * Supports shorthand `tagline` or composed `<ElmeraCover.Tagline>` children.
 */
function ElmeraCoverRoot({ tagline, background = "none", children }: ElmeraCoverProps) {
  const resolvedTagline = tagline === undefined ? (children === undefined ? DEFAULT_TAGLINE : null) : tagline;

  return (
    <div className="deck-elmera-cover" data-background={background}>
      {background === "ghost-fiber" && <GhostFiberBackground />}
      <ElmeraGroupLogo className="deck-elmera-cover-logo" title="Elmera Group" />
      {resolvedTagline !== null && resolvedTagline !== "" && (
        <ElmeraCoverTagline>{resolvedTagline}</ElmeraCoverTagline>
      )}
      {children}
    </div>
  );
}

/**
 * Neutral Elmera Group cover with compound `Root` and `Tagline` parts. Use `<ElmeraCover />` for
 * the standard cover, or compose `<ElmeraCover.Tagline render={<a href="…" />} />` to swap the
 * tagline element while keeping its grid placement and typography.
 */
export const ElmeraCover = Object.assign(ElmeraCoverRoot, {
  Root: ElmeraCoverRoot,
  Tagline: ElmeraCoverTagline,
});
