import { ElmeraGroupLogo } from "@elmeragroup/fuse/icons";

import { GhostFiberBackground } from "./ghost-fiber.tsx";

const DEFAULT_TAGLINE = "Preferred by more customers. Every day.";

/** Optional ambient background styles `<ElmeraCover>` supports. */
export type ElmeraCoverBackground = "none" | "ghost-fiber";

/** The props a slide gives `<ElmeraCover>`. */
export type ElmeraCoverProps = {
  /** Line shown under the Elmera Group wordmark. Defaults to `"Preferred by more customers. Every day."`. Pass `null` or `""` to omit it. */
  readonly tagline?: string | null;
  /** Ambient background behind the cover. Defaults to `"none"`. */
  readonly background?: ElmeraCoverBackground;
};

/**
 * Renders the neutral Elmera Group cover with Fuse's `ElmeraGroupLogo` wordmark and an Inter
 * tagline centered on the slide in the active theme's foreground and muted foreground tokens.
 */
export function ElmeraCover({ tagline = DEFAULT_TAGLINE, background = "none" }: ElmeraCoverProps) {
  return (
    <div className="deck-elmera-cover" data-background={background}>
      {background === "ghost-fiber" && <GhostFiberBackground />}
      <ElmeraGroupLogo className="deck-elmera-cover-logo" title="Elmera Group" />
      {tagline !== null && tagline !== "" && <p className="deck-elmera-cover-tagline">{tagline}</p>}
    </div>
  );
}
