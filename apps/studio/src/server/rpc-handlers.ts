/**
 * The renderer's RPC calls, each a thin translation onto `DeckScopes`, deck-core and
 * `RecentDecks`. Deck-core's errors cross the wire as `DeckOperationFailed`, tagged with the
 * original error's tag.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { DeckOperationFailed, StudioRpcs } from "../contract/studio-rpc.ts";
import { DeckScopes } from "./deck-scopes.ts";
import { RecentDecks } from "./recent-decks.ts";

/** How many slides compile at once while the slide list loads. */
const LIST_CONCURRENCY = 4;

/** A deck-core failure, as the renderer receives it. */
function operationFailed(error: { readonly _tag: string; readonly message: string }): DeckOperationFailed {
  return new DeckOperationFailed({ reason: error._tag, message: error.message });
}

/** The handlers for every call in `StudioRpcs`. */
export const StudioRpcHandlers = StudioRpcs.toLayer(
  Effect.gen(function* () {
    const scopes = yield* DeckScopes;
    const recent = yield* RecentDecks;
    return StudioRpcs.of({
      "studio.state": () => scopes.state,
      "deck.open": ({ path, requestId }) => scopes.open(path, requestId),
      "deck.close": ({ scopeId }) => scopes.close(scopeId),
      "deck.changed": ({ scopeId }) => scopes.changes(scopeId),
      "slides.list": ({ scopeId }) =>
        scopes.admit(scopeId, ({ files, bundler }) =>
          Effect.gen(function* () {
            const loaded = yield* files.load;
            return yield* Effect.forEach(
              loaded.slides,
              ({ id }) =>
                files.readSlide(id).pipe(
                  Effect.flatMap((text) => bundler.compile(id, text)),
                  // A slide that does not compile still has a place in the list.
                  Effect.map((slide) => ({ id, title: Option.getOrNull(slide.metadata.title) })),
                  Effect.orElseSucceed(() => ({ id, title: null }))
                ),
              { concurrency: LIST_CONCURRENCY }
            );
          }).pipe(Effect.mapError(operationFailed))
        ),
      "slides.move": ({ scopeId, id, position }) =>
        scopes.admit(scopeId, ({ files }) =>
          files
            .moveSlide(id, position)
            .pipe(Effect.mapBoth({ onSuccess: (manifest) => manifest.order, onFailure: operationFailed }))
        ),
      "recent.list": () => recent.list,
    });
  })
);
