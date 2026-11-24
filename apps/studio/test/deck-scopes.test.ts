import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import path from "node:path";

import { SlideId } from "@elmeragroup/deck-core/deck/slide-id";

import { OpenRequestId } from "../src/contract/studio-rpc.ts";
import type { DeckChanged, StudioState } from "../src/contract/studio-rpc.ts";
import { DeckScopes } from "../src/server/deck-scopes.ts";
import { RecentDecks } from "../src/server/recent-decks.ts";
import { DECK_A, DECK_B, DECK_RUNTIME, writeDeck } from "./decks.ts";

/** A fresh open request id, as the renderer picks one. */
const newRequestId = () => OpenRequestId.make(crypto.randomUUID());

/** The renderer origin the scopes are opened for. */
const EMBEDDER = "fuse-deck-studio://app";

/** A temporary directory with decks A and B and a user data directory, and the scopes over them. */
const setup = Effect.fn("setup")(function* (
  drainTimeout: Duration.Duration,
  recentDecks: (
    userData: string
  ) => Layer.Layer<RecentDecks, never, FileSystem.FileSystem> = RecentDecks.layer
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "fuse-deck-studio-scopes-" });
  const deckA = yield* Effect.promise(() => writeDeck(path.join(root, "a"), DECK_A));
  const deckB = yield* Effect.promise(() => writeDeck(path.join(root, "b"), DECK_B));
  const services = yield* Layer.build(
    DeckScopes.layer({ embedderOrigin: EMBEDDER, runtimeRoot: DECK_RUNTIME, drainTimeout }).pipe(
      Layer.provideMerge(recentDecks(path.join(root, "user-data")))
    )
  );
  const scopes = Context.get(services, DeckScopes);
  const recent = Context.get(services, RecentDecks);
  // Every state the scopes publish, in order, from now on.
  const seen = yield* Ref.make<ReadonlyArray<StudioState>>([]);
  yield* scopes.state.pipe(
    Stream.runForEach((state) => Ref.update(seen, (all) => [...all, state])),
    Effect.forkScoped
  );
  return { scopes, recent, deckA, deckB, seen };
});

/** Wait until the scopes publish a state `matches` accepts. */
function waitForState(
  scopes: DeckScopes["Service"],
  matches: (state: StudioState) => boolean
): Effect.Effect<void> {
  return scopes.state.pipe(Stream.filter(matches), Stream.runHead, Effect.asVoid);
}

/** `deck.json`'s order, as the file on disk holds it. */
const readOrder = Effect.fn("readOrder")(function* (deck: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path.join(deck, "deck.json"));
  return (yield* Schema.decodeEffect(DeckOrder)(text)).order;
});

const DeckOrder = Schema.fromJsonString(Schema.Struct({ order: Schema.Array(Schema.String) }));

/** A short label for each state, so a test can compare sequences. */
function label(state: StudioState): string {
  switch (state._tag) {
    case "Empty":
      return "Empty";
    case "Opening":
      return `Opening ${path.basename(state.path)}`;
    case "Open":
      return `Open ${state.deck.title} ${String(state.admitted)}`;
    case "Closing":
      return `Closing ${state.deck.title} ${String(state.admitted)}`;
  }
}

const slide = Schema.decodeSync(SlideId);

describe("DeckScopes", () => {
  it.live("opens each deck in its own scope on its own dev server", () =>
    Effect.gen(function* () {
      const { scopes, deckA, deckB } = yield* setup(Duration.seconds(10));
      const a = yield* scopes.open(deckA, newRequestId());
      const b = yield* scopes.open(deckB, newRequestId());
      assert.notStrictEqual(a.scopeId, b.scopeId);
      assert.notStrictEqual(new URL(a.url).port, new URL(b.url).port);
      assert.strictEqual(new URL(b.url).hostname, "127.0.0.1");
      assert.strictEqual(b.title, "Deck B");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("refuses a call for a closed scope before the call runs", () =>
    Effect.gen(function* () {
      const { scopes, deckA, deckB } = yield* setup(Duration.seconds(10));
      const a = yield* scopes.open(deckA, newRequestId());
      yield* scopes.open(deckB, newRequestId());
      const ran = yield* Ref.make(false);
      const error = yield* Effect.flip(scopes.admit(a.scopeId, () => Ref.set(ran, true)));
      assert.strictEqual(error._tag, "StaleScope");
      assert.isFalse(yield* Ref.get(ran));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("lets an admitted reorder settle on the old deck before the next deck opens", () =>
    Effect.gen(function* () {
      const { scopes, deckA, deckB, seen } = yield* setup(Duration.seconds(30));
      const a = yield* scopes.open(deckA, newRequestId());
      const orderB = [...(yield* readOrder(deckB))];
      const gate = yield* Deferred.make<void>();
      const reorder = yield* scopes
        .admit(a.scopeId, ({ files }) =>
          Deferred.await(gate).pipe(
            Effect.andThen(files.moveSlide(slide("a-one"), { _tag: "After", anchor: slide("a-three") }))
          )
        )
        .pipe(Effect.forkScoped);
      yield* waitForState(scopes, (state) => state._tag === "Open" && state.admitted === 1);
      const switching = yield* scopes.open(deckB, newRequestId()).pipe(Effect.forkScoped);
      // The switch has started and is waiting on the reorder: A is closing with one call admitted.
      yield* waitForState(scopes, (state) => state._tag === "Closing" && state.admitted === 1);
      yield* Deferred.succeed(gate, undefined);
      const moved = yield* Fiber.join(reorder);
      const b = yield* Fiber.join(switching);

      assert.deepStrictEqual([...moved.order], ["a-two", "a-three", "a-one"]);
      assert.deepStrictEqual([...(yield* readOrder(deckA))], ["a-two", "a-three", "a-one"]);
      assert.deepStrictEqual([...(yield* readOrder(deckB))], orderB);
      assert.strictEqual(b.title, "Deck B");
      const labels = (yield* Ref.get(seen)).map(label);
      const from = labels.indexOf("Closing Deck A 1");
      assert.deepStrictEqual(labels.slice(from), [
        "Closing Deck A 1",
        "Closing Deck A 0",
        "Opening b",
        "Open Deck B 0",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("cancels an admitted call that outlives the drain timeout, then opens the next deck", () =>
    Effect.gen(function* () {
      const { scopes, deckA, deckB } = yield* setup(Duration.millis(200));
      const a = yield* scopes.open(deckA, newRequestId());
      const interrupted = yield* Deferred.make<void>();
      const stuck = yield* scopes
        .admit(a.scopeId, () =>
          Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
        )
        .pipe(Effect.forkScoped);
      yield* waitForState(scopes, (state) => state._tag === "Open" && state.admitted === 1);
      const b = yield* scopes.open(deckB, newRequestId());
      assert.strictEqual(b.title, "Deck B");
      assert.isTrue(yield* Deferred.isDone(interrupted));
      const exit = yield* Fiber.await(stuck);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("reports a slide written on disk right after the stream's first report", () =>
    Effect.gen(function* () {
      const { scopes, deckA } = yield* setup(Duration.seconds(10));
      const fs = yield* FileSystem.FileSystem;
      const a = yield* scopes.open(deckA, newRequestId());
      const reports = yield* Queue.unbounded<DeckChanged>();
      yield* scopes.changes(a.scopeId).pipe(
        Stream.runForEach((report) => Queue.offer(reports, report)),
        Effect.forkScoped
      );
      // The first report comes once the stream listens, before anything changed on disk.
      const first = yield* Queue.take(reports).pipe(Effect.timeout("10 seconds"));
      assert.deepStrictEqual(first, { scopeId: a.scopeId, paths: [] });
      yield* fs.writeFileString(path.join(deckA, "slides", "a-two.mdx"), "# A two, edited\n");
      const edited = yield* Queue.take(reports).pipe(
        Effect.repeat({ until: (report) => report.paths.includes("slides/a-two.mdx") }),
        Effect.timeout("10 seconds")
      );
      assert.strictEqual(edited.scopeId, a.scopeId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("records the deck in the recent decks before it reports the deck open", () =>
    Effect.gen(function* () {
      const recording = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Recent decks that hold each record until the test releases it.
      const held = () =>
        Layer.succeed(
          RecentDecks,
          RecentDecks.of({
            list: Effect.succeed([]),
            record: () =>
              Deferred.succeed(recording, undefined).pipe(Effect.andThen(Deferred.await(release))),
          })
        );
      const { scopes, deckA } = yield* setup(Duration.seconds(10), held);
      const opening = yield* scopes.open(deckA, newRequestId()).pipe(Effect.forkScoped);
      yield* Deferred.await(recording);
      const whileRecording = yield* scopes.state.pipe(Stream.runHead);
      yield* Deferred.succeed(release, undefined);
      const a = yield* Fiber.join(opening);
      assert.deepStrictEqual(
        Option.map(whileRecording, (state) => state._tag),
        Option.some("Opening")
      );
      const afterwards = yield* scopes.state.pipe(Stream.runHead);
      assert.deepStrictEqual(afterwards, Option.some({ _tag: "Open", deck: a, admitted: 0 }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("frames a deck only for the embedder, and answers no other origin's cross-origin read", () =>
    Effect.gen(function* () {
      const { scopes, deckA } = yield* setup(Duration.seconds(10));
      const a = yield* scopes.open(deckA, newRequestId());
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.get(a.url).pipe(HttpClientRequest.setHeader("origin", "http://127.0.0.1:1"))
      );
      assert.strictEqual(response.headers["content-security-policy"], `frame-ancestors ${EMBEDDER}`);
      assert.isUndefined(response.headers["access-control-allow-origin"]);
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer]))
  );

  it.live("keeps the opened decks, newest first", () =>
    Effect.gen(function* () {
      const { scopes, recent, deckA, deckB } = yield* setup(Duration.seconds(10));
      yield* scopes.open(deckA, newRequestId());
      yield* scopes.open(deckB, newRequestId());
      yield* scopes.open(deckA, newRequestId());
      const fs = yield* FileSystem.FileSystem;
      assert.deepStrictEqual(yield* recent.list, [
        { root: yield* fs.realPath(deckA), title: "Deck A" },
        { root: yield* fs.realPath(deckB), title: "Deck B" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
