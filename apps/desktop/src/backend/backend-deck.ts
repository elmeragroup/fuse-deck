/**
 * Main's own question to the backend: which deck is open. Main asks with the session bearer and no
 * Origin, the only way `GET /api/deck` answers, so the renderer cannot supply the answer.
 */

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DECK_PATH, DeckResponse } from "@elmeragroup/fuse-deck-studio/contract/studio-launch";

import { BackendAuth } from "./backend-auth.ts";

/** How long main waits for the backend, a restart included, before it gives up on the question. */
const DECK_LOOKUP_TIMEOUT = Duration.seconds(5);

/** Main could not learn which deck the backend has open. */
export class OpenDeckUnknown extends Schema.TaggedError<OpenDeckUnknown>()("OpenDeckUnknown", {
  message: Schema.String,
}) {}

/**
 * The address of the deck the backend has open, or none while no deck is open or one is closing.
 *
 * @returns The address, or `OpenDeckUnknown` when the backend did not answer in time or at all.
 */
export const openDeckUrl = Effect.fn("BackendDeck.openDeckUrl")(function* () {
  const auth = yield* BackendAuth;
  const http = yield* HttpClient.HttpClient;
  return yield* auth.connection.pipe(
    Effect.flatMap((connection) =>
      http.execute(
        HttpClientRequest.get(new URL(DECK_PATH, connection.url).href).pipe(
          HttpClientRequest.bearerToken(connection.bearer)
        )
      )
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(DeckResponse)),
    Effect.map(({ url }) => Option.fromNullOr(url)),
    Effect.timeoutOrElse({
      duration: DECK_LOOKUP_TIMEOUT,
      orElse: () =>
        Effect.fail(new OpenDeckUnknown({ message: "The studio backend did not answer in time." })),
    }),
    Effect.mapError((error) =>
      error._tag === "OpenDeckUnknown"
        ? error
        : new OpenDeckUnknown({
            message: `The studio backend did not say which deck is open: ${error.message}`,
          })
    )
  );
});
