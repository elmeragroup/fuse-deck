import type { ReactNode } from "react";

/** Column width proportions `<Split>` supports. */
export type SplitRatio = "1:1" | "2:3" | "3:2" | "1:2" | "2:1";

/** Vertical alignment of the two columns inside `<Split>`. */
export type SplitAlign = "stretch" | "center" | "start";

/** The props a slide gives `<Split>`. */
export type SplitProps = {
  /** Column width ratio. Default: `"1:1"`. */
  readonly ratio?: SplitRatio;
  /** Vertical alignment of the columns. Default: `"stretch"`. */
  readonly align?: SplitAlign;
  /** Two child blocks, placed side by side. */
  readonly children?: ReactNode;
};

/**
 * Places two blocks side by side across the remaining height of the slide, for pairing prose,
 * lists or metrics with a Fuse chart, image or `<Video>`.
 */
export function Split({ ratio = "1:1", align = "stretch", children }: SplitProps) {
  return (
    <div className="deck-split" data-ratio={ratio} data-align={align}>
      {children}
    </div>
  );
}
