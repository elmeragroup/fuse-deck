/**
 * What the open deck's preview shows, for the agent's view tools. The renderer reports each
 * position the framed deck commits, through the preview bridge, and carries out each go request
 * the backend sends it. One view per deck scope, made and ended with the scope.
 *
 * A go request names a slide id and a step, under a request id of its own. The renderer posts it to
 * the frame and posts it again after each report that is not that slide, since a page that has not
 * loaded a new slide yet ignores it and reports once more after it reloads. When the frame reports
 * the slide, the renderer reports that position under the go's request id, and `go` returns it: the
 * position the deck committed, a step past the slide's last clamped to its last. A report under no
 * id, or under another go's, answers nothing.
 *
 * Go requests run one at a time per deck, so two calls cannot take each other's answer. A go that is
 * interrupted, as Stop does, or that times out sends the renderer a cancel under its id, so its
 * request cannot move the preview later. `go` fails with `PreviewNotShown` when no renderer listens
 * or none answers in time.
 */

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { randomUUID } from "node:crypto";

import type { SlideId } from "@elmeragroup/deck-core/deck/slide-id";

import type { ViewPosition, ViewRequest } from "../contract/studio-rpc.ts";

/** How long `go` waits for the preview to show the slide it asked for. */
export const GO_DEADLINE = Duration.seconds(10);

/** The preview did not show the slide a view tool asked for. */
export class PreviewNotShown extends Schema.TaggedError<PreviewNotShown>()("PreviewNotShown", {
  message: Schema.String,
  hint: Schema.String,
}) {}

/** One deck scope's view. */
export type DeckView = {
  /** The position the preview last reported, or none before its first report. */
  readonly current: Effect.Effect<Option.Option<ViewPosition>>;
  /** Record a position the preview committed, as the answer to the go `requestId` names, if any. */
  readonly report: (position: ViewPosition, requestId: Option.Option<string>) => Effect.Effect<void>;
  /** Ask the preview to show `slideId` at `step`, and return the position it committed. */
  readonly go: (slideId: SlideId, step: number) => Effect.Effect<ViewPosition, PreviewNotShown>;
  /** The go and cancel requests, for the renderer to carry out, until the scope closes. */
  readonly requests: Stream.Stream<ViewRequest>;
};

/** A position the preview committed, and the go it answers. */
type Report = { readonly position: ViewPosition; readonly requestId: Option.Option<string> };

/**
 * A view for one deck scope, which ends with the scope.
 *
 * @param deadline - How long `go` waits for the preview.
 */
export const makeDeckView = Effect.fn("DeckView.make")(function* (deadline: Duration.Duration) {
  const position = yield* SubscriptionRef.make(Option.none<ViewPosition>());
  const reports = yield* PubSub.unbounded<Report>();
  const requests = yield* PubSub.unbounded<ViewRequest>();
  yield* Effect.addFinalizer(() => Effect.andThen(PubSub.shutdown(reports), PubSub.shutdown(requests)));
  const going = yield* Semaphore.make(1);
  let listeners = 0;

  const notShown = (slideId: SlideId, reason: string) =>
    new PreviewNotShown({
      message: `The preview did not show slide ${slideId}: ${reason}`,
      hint: "Open the deck's Preview tab in the studio, then call view_go again.",
    });

  const ask = Effect.fn("DeckView.ask")(function* (slideId: SlideId, step: number) {
    if (listeners === 0) {
      return yield* notShown(slideId, "no studio window shows this deck.");
    }
    const requestId = randomUUID();
    // Subscribed before the request goes out, so an answer that comes at once is not missed.
    const subscription = yield* PubSub.subscribe(reports);
    const answer = Stream.fromSubscription(subscription).pipe(
      Stream.filter((report) => Option.contains(report.requestId, requestId)),
      Stream.runHead,
      Effect.timeoutOption(deadline),
      Effect.map(Option.flatten)
    );
    const committed = yield* PubSub.publish(requests, { _tag: "Go", requestId, slideId, step }).pipe(
      Effect.andThen(answer),
      // Stopped or unanswered: the renderer drops the request, so it cannot move the preview later.
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) && Option.isSome(exit.value)
          ? Effect.void
          : PubSub.publish(requests, { _tag: "Cancel", requestId })
      )
    );
    return yield* Effect.fromOption(committed).pipe(
      Effect.mapBoth({
        onSuccess: (report) => report.position,
        onFailure: () => notShown(slideId, `no report within ${Duration.format(deadline)}.`),
      })
    );
  }, Effect.scoped);

  return {
    current: SubscriptionRef.get(position),
    report: (report, requestId) =>
      Effect.andThen(
        SubscriptionRef.set(position, Option.some(report)),
        PubSub.publish(reports, { position: report, requestId })
      ),
    go: (slideId, step) => going.withPermits(1)(ask(slideId, step)),
    requests: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(requests);
        listeners += 1;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            listeners -= 1;
          })
        );
        return Stream.fromSubscription(subscription);
      })
    ),
  } satisfies DeckView;
});
