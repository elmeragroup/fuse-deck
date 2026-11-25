/**
 * The backend's status as main tracks it. A run is Ready once main holds its session bearer,
 * which the renderer receives over IPC; the bootstrap credential never leaves main.
 */

import type * as Redacted from "effect/Redacted";

/** What one run of the backend gets on stdin, and the credential inside it. */
export type BackendLaunch = {
  /** The launch document, one line of JSON. */
  readonly stdin: string;
  /** The bootstrap credential the document carries. */
  readonly bootstrap: Redacted.Redacted<string>;
};

/** Where the backend stands. */
export type BackendStatus =
  /** A run is starting: it has not printed its readiness document, or main holds no bearer yet. */
  | { readonly _tag: "Starting"; readonly attempt: number }
  /** The backend listens at `url`, and `bearer` is the session bearer main traded for. */
  | { readonly _tag: "Ready"; readonly url: string; readonly bearer: Redacted.Redacted<string> }
  /** The last run ended; the next one starts after `delayMillis`. */
  | {
      readonly _tag: "Restarting";
      readonly reason: string;
      readonly attempt: number;
      readonly delayMillis: number;
    };
