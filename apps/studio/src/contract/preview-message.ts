/**
 * A preview bridge message, `{ scopeId, slideId, step }`, as the studio reads one. deck-core's
 * runtime (`src/runtime/bridge.ts`) posts and reads the same shape on the deck's side.
 */

import * as Schema from "effect/Schema";

/** A position in the framed deck, in either direction. */
export const PreviewMessage = Schema.Struct({
  scopeId: Schema.String,
  slideId: Schema.String,
  step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** A position in the framed deck. */
export type PreviewMessage = typeof PreviewMessage.Type;
