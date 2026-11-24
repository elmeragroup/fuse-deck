/**
 * The shape of the deck manifest the bundler generates as `virtual:fuse-deck`
 * (`src/bundler/bundler.ts`). `virtual-manifest.d.ts` declares that module with this type.
 */

import type { ComponentType } from "react";

import type { LayoutName } from "../deck/vocabulary.ts";

/** The components MDX looks up for JSX names a slide did not import. */
export type MdxComponents = Readonly<Record<string, ComponentType<never>>>;

/** One slide's entry: what the compile derived and an import of its module. */
export type ManifestSlide = {
  readonly id: string;
  readonly title: string | null;
  readonly layout: LayoutName;
  readonly steps: number;
  readonly load: () => Promise<{ readonly default: ComponentType<{ readonly components: MdxComponents }> }>;
};

/** The page that frames the deck in the studio's preview, as the studio named it. */
export type ManifestEmbedder = {
  /** The framing page's origin. */
  readonly origin: string;
  /** The studio's id for this opening of the deck. */
  readonly scopeId: string;
};

/** The deck's settings and its slides in order. */
export type DeckManifest = {
  readonly title: string;
  readonly aspect: "16:9" | "4:3";
  /** The studio page that frames the deck, or null when no studio served it. */
  readonly embedder: ManifestEmbedder | null;
  readonly slides: readonly ManifestSlide[];
};
