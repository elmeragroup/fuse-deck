/**
 * The renderer's API on the studio backend: an `effect/rpc` group served over the authenticated
 * WebSocket. The backend and the renderer both import this module, so it imports only Schema,
 * `effect/rpc` and deck-core's slide id, none of which reaches Node.
 *
 * A slide's source is opened with the revision of its bytes, and saved over that revision: a save
 * of a slide that changed on disk since fails with deck-core's `SlideConflict`, which carries what
 * the file holds now.
 *
 * Every call about an open deck carries the scope id that `deck.open` returned. The backend
 * resolves that id once, before it does anything, and fails with `StaleScope` when the deck it
 * names is closing or gone.
 */

import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import {
  OpenedSlide,
  SavedSlide,
  SlideConflict,
  SlideRevision,
} from "@elmeragroup/deck-core/deck/slide-edit";
import { SlideId } from "@elmeragroup/deck-core/deck/slide-id";

/** The id of one opening of a deck. A deck opened twice gets two ids. */
export const ScopeId = Schema.String.pipe(Schema.brand("ScopeId"));

/** The id of one opening of a deck. */
export type ScopeId = typeof ScopeId.Type;

/**
 * The id of one request to open a deck. The renderer picks it, and the backend's state names it
 * while the deck opens, once it is open and after the open failed, so a renderer that lost the
 * request's own result to a dropped connection can still tell how it ended.
 */
export const OpenRequestId = Schema.String.pipe(Schema.brand("OpenRequestId"));

/** The id of one request to open a deck. */
export type OpenRequestId = typeof OpenRequestId.Type;

/** A deck the backend has open. */
export const OpenDeck = Schema.Struct({
  scopeId: ScopeId,
  /** The request that opened it. */
  requestId: OpenRequestId,
  /** The deck directory, absolute. */
  root: Schema.String,
  /** `deck.json`'s title. */
  title: Schema.String,
  /** The deck's dev server, on 127.0.0.1, which the preview frames. */
  url: Schema.String,
});

/** A deck the backend has open. */
export type OpenDeck = typeof OpenDeck.Type;

/** Where the backend's deck stands. */
export const StudioState = Schema.Union([
  /** No deck is open. `failed` names the open request that failed last, if the last open failed. */
  Schema.TaggedStruct("Empty", {
    failed: Schema.NullOr(Schema.Struct({ requestId: OpenRequestId, message: Schema.String })),
  }),
  /** A deck at `path` is opening, for the request `requestId`. */
  Schema.TaggedStruct("Opening", { path: Schema.String, requestId: OpenRequestId }),
  /**
   * `deck` is open, with `admitted` calls about it still running. `writing` of them write to the
   * deck; the rest only read it.
   */
  Schema.TaggedStruct("Open", { deck: OpenDeck, admitted: Schema.Int, writing: Schema.Int }),
  /**
   * `deck` is closing: it takes no new calls, and the next deck opens once its `admitted` calls,
   * `writing` of them writes, have settled or been cancelled.
   */
  Schema.TaggedStruct("Closing", { deck: OpenDeck, admitted: Schema.Int, writing: Schema.Int }),
]);

/** Where the backend's deck stands. */
export type StudioState = typeof StudioState.Type;

/** A slide as the slide list shows it. */
export const SlideSummary = Schema.Struct({
  id: SlideId,
  /** The slide's first heading or frontmatter title, or null when it has neither or does not compile. */
  title: Schema.NullOr(Schema.String),
});

/** A slide as the slide list shows it. */
export type SlideSummary = typeof SlideSummary.Type;

/** Where a moved slide goes: right before or right after another slide. */
export const MovePosition = Schema.Union([
  Schema.TaggedStruct("Before", { anchor: SlideId }),
  Schema.TaggedStruct("After", { anchor: SlideId }),
]);

/** Where a moved slide goes. */
export type MovePosition = typeof MovePosition.Type;

/** Files in the open deck that changed on disk, relative to the deck directory. */
export const DeckChanged = Schema.Struct({
  scopeId: ScopeId,
  paths: Schema.Array(Schema.String),
});

/** Files in the open deck that changed on disk. */
export type DeckChanged = typeof DeckChanged.Type;

/** A deck the studio opened before. */
export const RecentDeck = Schema.Struct({
  /** The deck directory, absolute. */
  root: Schema.String,
  title: Schema.String,
});

/** A deck the studio opened before. */
export type RecentDeck = typeof RecentDeck.Type;

/** The call named a deck scope that is closing or no longer open. */
export class StaleScope extends Schema.TaggedError<StaleScope>()("StaleScope", {
  scopeId: Schema.String,
  message: Schema.String,
}) {}

/** The deck could not be opened. */
export class DeckOpenFailed extends Schema.TaggedError<DeckOpenFailed>()("DeckOpenFailed", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** Reading or editing the open deck failed; `reason` is the deck model's error tag. */
export class DeckOperationFailed extends Schema.TaggedError<DeckOperationFailed>()("DeckOperationFailed", {
  reason: Schema.String,
  message: Schema.String,
}) {}

const ScopePayload = { scopeId: ScopeId };

/** The renderer's API on the studio backend. */
export class StudioRpcs extends RpcGroup.make(
  Rpc.make("studio.state", { success: StudioState, stream: true }),
  Rpc.make("deck.open", {
    payload: { path: Schema.String, requestId: OpenRequestId },
    success: OpenDeck,
    error: DeckOpenFailed,
  }),
  Rpc.make("deck.close", { payload: ScopePayload, error: StaleScope }),
  Rpc.make("deck.changed", { payload: ScopePayload, success: DeckChanged, error: StaleScope, stream: true }),
  Rpc.make("slides.list", {
    payload: ScopePayload,
    success: Schema.Array(SlideSummary),
    error: Schema.Union([StaleScope, DeckOperationFailed]),
  }),
  Rpc.make("slides.move", {
    payload: { ...ScopePayload, id: SlideId, position: MovePosition },
    success: Schema.Array(SlideId),
    error: Schema.Union([StaleScope, DeckOperationFailed]),
  }),
  Rpc.make("slide.open", {
    payload: { ...ScopePayload, id: SlideId },
    success: OpenedSlide,
    error: Schema.Union([StaleScope, DeckOperationFailed]),
  }),
  Rpc.make("slide.save", {
    payload: {
      ...ScopePayload,
      id: SlideId,
      /** The revision the editor opened, or null when it expects no file. */
      expected: Schema.NullOr(SlideRevision),
      source: Schema.String,
    },
    success: SavedSlide,
    error: Schema.Union([StaleScope, SlideConflict, DeckOperationFailed]),
  }),
  Rpc.make("recent.list", { success: Schema.Array(RecentDeck) })
) {}
