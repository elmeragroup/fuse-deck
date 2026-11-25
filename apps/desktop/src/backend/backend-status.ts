/**
 * The backend's status as main reports it to the stub page. It crosses IPC, so it is a schema:
 * main encodes it and the page decodes it. This module imports only Schema, so the page's bundle
 * stays free of Node.
 */

import * as Schema from "effect/Schema";

/** Where the backend stands, as the stub page shows it. */
export const BackendStatus = Schema.Union([
  /** A run is starting and has not printed its readiness document yet. */
  Schema.TaggedStruct("Starting", { attempt: Schema.Int }),
  /** The backend serves the deck at `url`. */
  Schema.TaggedStruct("Ready", { url: Schema.String }),
  /** The last run ended; the next one starts after `delayMillis`. */
  Schema.TaggedStruct("Restarting", {
    reason: Schema.String,
    attempt: Schema.Int,
    delayMillis: Schema.Finite,
  }),
]);

/** Where the backend stands. */
export type BackendStatus = typeof BackendStatus.Type;
