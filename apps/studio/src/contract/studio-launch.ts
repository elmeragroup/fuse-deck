/**
 * How the studio backend starts and how its clients authenticate. Electron main, the renderer, the
 * backend and the tests share these documents.
 *
 * - Main writes one `StudioLaunch` line to the backend's stdin and keeps the pipe open; the
 *   backend exits when it closes. The bootstrap credential never appears on argv or in the
 *   environment.
 * - The backend prints one `StudioReady` line on stdout once it listens.
 * - `POST /api/session` trades the one-use bootstrap credential for the session bearer.
 * - `POST /api/ticket` with `Authorization: Bearer` returns a one-use WebSocket ticket.
 * - `GET /ws?ticket=` upgrades to the RPC socket.
 * - SIGTERM, or stdin's end, stops the backend within `BACKEND_STOP_DEADLINE`.
 */

import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

/**
 * How long the backend takes at most to stop, from SIGTERM or stdin's end to its exit: the open
 * deck's drain (10 s), Vite's close (3 s) and the HTTP server's grace (1 s), with a second to
 * spare. The backend exits when it runs out, and main waits longer than this before SIGKILL.
 */
export const BACKEND_STOP_DEADLINE = Duration.seconds(15);

/** What main hands the backend at spawn, on stdin. */
export const StudioLaunch = Schema.Struct({
  /** The one-use credential main exchanges for the session bearer. */
  bootstrap: Schema.NonEmptyString,
  /** The renderer's exact origin, such as `fuse-deck-studio://app`; the only origin let in. */
  origin: Schema.NonEmptyString,
  /** Where the backend keeps its settings, Electron's user data directory. */
  userDataDirectory: Schema.NonEmptyString,
});

/** What main hands the backend at spawn. */
export type StudioLaunch = typeof StudioLaunch.Type;

/** The backend's readiness document, the one line it prints on stdout. */
export const StudioReady = Schema.TaggedStruct("StudioReady", {
  /** The backend's address, `http://127.0.0.1:<port>/`. */
  url: Schema.String,
});

/** The backend's readiness document. */
export type StudioReady = typeof StudioReady.Type;

/** The path that trades the bootstrap credential for the session bearer. */
export const SESSION_PATH = "/api/session";

/** The path that issues a WebSocket ticket for a session bearer. */
export const TICKET_PATH = "/api/ticket";

/** The RPC socket's path. */
export const SOCKET_PATH = "/ws";

/** The body of a `POST /api/session`. */
export const SessionRequest = Schema.Struct({ bootstrap: Schema.NonEmptyString });

/** The answer to a `POST /api/session`. */
export const SessionResponse = Schema.Struct({ bearer: Schema.NonEmptyString });

/** The answer to a `POST /api/ticket`. */
export const TicketResponse = Schema.Struct({
  ticket: Schema.NonEmptyString,
  /** How long the ticket is good for, from its issue. */
  expiresInMillis: Schema.Int,
});

/** Where the renderer reaches the backend: its address and the session bearer. */
export const BackendConnection = Schema.Struct({
  url: Schema.String,
  bearer: Schema.NonEmptyString,
});

/** Where the renderer reaches the backend. */
export type BackendConnection = typeof BackendConnection.Type;
