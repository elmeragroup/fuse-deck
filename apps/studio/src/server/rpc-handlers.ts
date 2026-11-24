/**
 * The renderer's RPC calls, each a thin translation onto `DeckScopes`, deck-core and
 * `RecentDecks`. Deck-core's errors cross the wire as `DeckOperationFailed`, tagged with the
 * original error's tag, except a save's `SlideConflict`, which crosses as itself.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Bundler } from "@elmeragroup/deck-core/bundler/bundler";
import { DeckFiles } from "@elmeragroup/deck-core/deck/deck-files";
import { saveSlide } from "@elmeragroup/deck-core/deck/save-slide";

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
        scopes.admit(scopeId, "Read", ({ files, bundler }) =>
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
        scopes.admit(scopeId, "Write", ({ files }) =>
          files
            .moveSlide(id, position)
            .pipe(Effect.mapBoth({ onSuccess: (manifest) => manifest.order, onFailure: operationFailed }))
        ),
      "slide.open": ({ scopeId, id }) =>
        scopes.admit(scopeId, "Read", ({ files }) =>
          files.openSlide(id).pipe(Effect.mapError(operationFailed))
        ),
      "slide.save": ({ scopeId, id, expected, source }) =>
        scopes.admit(scopeId, "Write", ({ files, bundler }) =>
          saveSlide(id, expected, source).pipe(
            Effect.provideService(DeckFiles, files),
            Effect.provideService(Bundler, bundler),
            // A conflict crosses typed, with the disk's text, so the editor can show it.
            Effect.mapError((error) => (error._tag === "SlideConflict" ? error : operationFailed(error)))
          )
        ),
      "recent.list": () => recent.list,
      "agent.chat": ({ scopeId }) => scopes.chat(scopeId),
      "agent.prompt": ({ scopeId, input }) =>
        scopes.admit(scopeId, "Read", ({ agent }) => agent.prompt(input)),
      "agent.stop": ({ scopeId }) => scopes.admit(scopeId, "Read", ({ agent }) => agent.stop),
      "agent.decide": ({ scopeId, requestId, optionId }) =>
        scopes.admit(scopeId, "Read", ({ agent }) => agent.decide(requestId, optionId)),
      "changes.list": ({ scopeId }) => scopes.admit(scopeId, "Read", ({ agent }) => agent.changes),
      "view.report": ({ scopeId, position, requestId }) =>
        scopes.admit(scopeId, "Read", ({ view }) => view.report(position, Option.fromNullOr(requestId))),
      "view.requests": ({ scopeId }) => scopes.viewRequests(scopeId),
    });
  })
);
