import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { SlideId } from "@elmeragroup/deck-core/deck/slide-id";

import type { ViewRequest } from "../src/contract/studio-rpc.ts";
import { makeDeckView } from "../src/server/deck-view.ts";
import type { DeckView } from "../src/server/deck-view.ts";

const slide = Schema.decodeSync(SlideId);

/** The last step each slide has, as the framed deck clamps a step past it. */
const LAST_STEP = 3;

/**
 * A renderer for `view`: it answers each go with the position the deck commits for it, clamped to
 * `LAST_STEP`, under the go's request id.
 */
const renderer = Effect.fnUntraced(function* (view: DeckView) {
  yield* Stream.runForEach(view.requests, (request) =>
    request._tag === "Go"
      ? view.report(
          { slideId: request.slideId, step: Math.min(request.step, LAST_STEP) },
          Option.some(request.requestId)
        )
      : Effect.void
  ).pipe(Effect.forkScoped);
  // The fork subscribes before it first waits, so the view has a listener once this yields.
  yield* Effect.yieldNow;
});

describe("DeckView", () => {
  it.live("answers two go calls on one slide each with the position committed for it", () =>
    Effect.gen(function* () {
      const view = yield* makeDeckView(Duration.seconds(5));
      yield* renderer(view);
      const [first, second] = yield* Effect.all([view.go(slide("a-two"), 1), view.go(slide("a-two"), 9)], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(
        [first, second],
        [
          { slideId: "a-two", step: 1 },
          { slideId: "a-two", step: LAST_STEP },
        ]
      );
    }).pipe(Effect.scoped)
  );

  it.live("takes no report without the go's request id as its answer", () =>
    Effect.gen(function* () {
      const view = yield* makeDeckView(Duration.millis(300));
      // A renderer that reports the slide the user moved to, never as the answer to a go.
      yield* Stream.runForEach(view.requests, () =>
        view.report({ slideId: slide("a-two"), step: 0 }, Option.none())
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const result = yield* Effect.result(view.go(slide("a-two"), 2));
      assert.strictEqual(result._tag === "Failure" ? result.failure._tag : "Shown", "PreviewNotShown");
    }).pipe(Effect.scoped)
  );

  it.live("tells the renderer to drop a go that was stopped, so it never navigates later", () =>
    Effect.gen(function* () {
      const view = yield* makeDeckView(Duration.seconds(5));
      const seen: ViewRequest[] = [];
      const asked = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      // A renderer whose deck has not loaded the slide yet, so it carries out nothing.
      yield* Stream.runForEach(view.requests, (request) =>
        Effect.sync(() => {
          seen.push(request);
        }).pipe(Effect.andThen(Deferred.succeed(request._tag === "Go" ? asked : cancelled, undefined)))
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const going = yield* Effect.forkChild(view.go(slide("agenda"), 0));
      yield* Deferred.await(asked);
      yield* Fiber.interrupt(going);
      yield* Deferred.await(cancelled);
      const [go, cancel] = seen;
      assert.deepStrictEqual(
        { go: go?._tag, cancel: cancel?._tag, same: go?.requestId === cancel?.requestId },
        { go: "Go", cancel: "Cancel", same: true }
      );
    }).pipe(Effect.scoped)
  );
});
