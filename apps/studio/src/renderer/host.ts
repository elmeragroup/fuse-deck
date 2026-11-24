/**
 * Where the renderer runs, and what that host gives it: the backend connection, a way to pick a
 * deck, the deck to open at start, Present, and the question before a quit or a window close drops
 * an unsaved draft.
 *
 * - In the desktop app the preload's `window.fuseDeckStudio` bridge answers through main. Main
 *   holds the session bearer and hands over the current backend's on every call, so a restarted
 *   backend is reached with its own bearer.
 * - Without the bridge, the renderer is in the browser-tab test harness. The page's address
 *   fragment carries the backend's address and either a one-use bootstrap credential, which the
 *   page trades for the bearer once, or the bearer itself, as main would hand it over. The page
 *   removes the fragment before anything renders.
 */

import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { BRIDGE_PROPERTY, LeaveIntent, PickedDeck } from "../contract/desktop-bridge.ts";
import type { FuseDeckStudioBridge } from "../contract/desktop-bridge.ts";
import { BackendConnection, SESSION_PATH, SessionResponse } from "../contract/studio-launch.ts";

/** The host could not say where the backend is. */
export class HostUnavailable extends Schema.TaggedError<HostUnavailable>()("HostUnavailable", {
  message: Schema.String,
}) {}

/** What the renderer needs from where it runs. */
export type StudioHost = {
  /** The current backend's address and session bearer. */
  readonly connection: Effect.Effect<BackendConnection, HostUnavailable, HttpClient.HttpClient>;
  /** Ask the user for a deck directory; none when they cancel. */
  readonly pickDeck: Effect.Effect<Option.Option<string>, HostUnavailable>;
  /** The deck to open at start, if the host names one. */
  readonly initialDeck: Effect.Effect<Option.Option<string>, HostUnavailable>;
  /**
   * Present the deck: the desktop app opens `url` in a fullscreen window; the browser-tab harness
   * puts the preview `frame`, already at that position, in the browser's fullscreen.
   */
  readonly present: (target: PresentTarget) => Effect.Effect<void, HostUnavailable>;
  /**
   * Tell the host whether the Source tab holds a draft with edits. The desktop app then asks the
   * page before it quits or closes its window; the browser-tab harness has nothing to hold back.
   */
  readonly reportUnsavedDraft: (unsaved: boolean) => Effect.Effect<void, HostUnavailable>;
  /** Call `listener` each time the host holds back a quit or a window close; returns the unsubscribe. */
  readonly onLeaveRequest: (listener: (intent: LeaveIntent) => void) => () => void;
  /** Go on with the quit or the window close the host held back. */
  readonly leave: (intent: LeaveIntent) => Effect.Effect<void, HostUnavailable>;
};

/** What Present shows: the deck page at the current position, and the preview frame showing it. */
export type PresentTarget = {
  readonly url: string;
  readonly frame: HTMLIFrameElement | null;
};

/** The fragment parameters the browser-tab harness puts in the page's address. */
const HARNESS_BACKEND = "backend";
const HARNESS_BOOTSTRAP = "bootstrap";
const HARNESS_BEARER = "bearer";
const HARNESS_DECK = "deck";

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- only an interface merges into the DOM's Window
  interface Window {
    readonly [BRIDGE_PROPERTY]?: FuseDeckStudioBridge;
  }
}

const decodeConnection = Schema.decodeUnknownEffect(BackendConnection);
const decodePicked = Schema.decodeUnknownEffect(PickedDeck);
const decodeLeave = Schema.decodeUnknownOption(LeaveIntent);

function unavailable(what: string) {
  return (cause: unknown) =>
    new HostUnavailable({ message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}` });
}

/** The desktop app's host, over the preload bridge. */
function desktopHost(bridge: FuseDeckStudioBridge): StudioHost {
  // Each answer is decoded here, at the IPC boundary.
  const pickedDeck = (what: string, call: FuseDeckStudioBridge["pickDeck"]) =>
    Effect.tryPromise({ try: call, catch: unavailable(what) }).pipe(
      Effect.flatMap(decodePicked),
      Effect.mapBoth({ onSuccess: Option.fromNullOr, onFailure: unavailable(what) })
    );
  return {
    connection: Effect.tryPromise({
      try: bridge.connection,
      catch: unavailable("main did not hand over the backend connection"),
    }).pipe(
      Effect.flatMap(decodeConnection),
      Effect.mapError(unavailable("main's backend connection did not decode"))
    ),
    pickDeck: pickedDeck("the deck dialog failed", bridge.pickDeck),
    initialDeck: pickedDeck("main did not say which deck to open", bridge.initialDeck),
    present: ({ url }) =>
      Effect.tryPromise({
        try: () => bridge.present(url),
        catch: unavailable("the Present window did not open"),
      }),
    reportUnsavedDraft: (unsaved) =>
      Effect.tryPromise({
        try: () => bridge.setUnsavedDraft(unsaved),
        catch: unavailable("main did not take the unsaved draft's state"),
      }),
    onLeaveRequest: (listener) =>
      bridge.onLeaveRequest((intent) => {
        // Decoded here, at the IPC boundary; anything else main never sends.
        const decoded = decodeLeave(intent);
        if (decoded._tag === "Some") {
          listener(decoded.value);
        }
      }),
    leave: (intent) =>
      Effect.tryPromise({ try: () => bridge.leave(intent), catch: unavailable("main did not go on") }),
  };
}

/**
 * The browser-tab test harness's host. It reads the fragment once, at start, and clears it, so
 * the bootstrap credential is gone from the address and the history before anything renders.
 */
function harnessHost(fragment: URLSearchParams): StudioHost {
  const backend = Option.fromNullOr(fragment.get(HARNESS_BACKEND));
  const bootstrap = Option.fromNullOr(fragment.get(HARNESS_BOOTSTRAP));
  const deck = Option.fromNullOr(fragment.get(HARNESS_DECK));
  let bearer: Option.Option<BackendConnection> = Option.flatMap(backend, (url) =>
    Option.map(Option.fromNullOr(fragment.get(HARNESS_BEARER)), (given) => ({ url, bearer: given }))
  );

  const exchange = Effect.gen(function* () {
    if (Option.isNone(backend) || Option.isNone(bootstrap)) {
      return yield* new HostUnavailable({
        message: "Open the studio from the desktop app, or give the page #backend=…&bootstrap=… to test it.",
      });
    }
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(new URL(SESSION_PATH, backend.value).href).pipe(
          HttpClientRequest.bodyJsonUnsafe({ bootstrap: bootstrap.value })
        )
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionResponse)),
        Effect.mapError(unavailable("the backend refused the bootstrap credential"))
      );
    const connection = { url: backend.value, bearer: response.bearer };
    bearer = Option.some(connection);
    return connection;
  });

  return {
    connection: Effect.suspend(() =>
      Option.match(bearer, { onNone: () => exchange, onSome: Effect.succeed })
    ),
    pickDeck: Effect.sync(() => Option.fromNullOr(window.prompt("The deck directory to open"))),
    initialDeck: Effect.succeed(deck),
    // Escape leaves the browser's fullscreen on its own.
    present: ({ frame }) =>
      frame === null
        ? Effect.fail(
            new HostUnavailable({ message: "The preview is not showing, so there is nothing to present." })
          )
        : Effect.tryPromise({
            try: () => frame.requestFullscreen(),
            catch: unavailable("the browser refused fullscreen"),
          }),
    reportUnsavedDraft: () => Effect.void,
    onLeaveRequest: () => () => undefined,
    leave: () => Effect.void,
  };
}

/**
 * The host the renderer runs in. Call it once, before the router reads the address.
 *
 * @returns The desktop host when the preload bridge exists, the browser-tab harness otherwise.
 */
export function detectHost(): StudioHost {
  const bridge = window[BRIDGE_PROPERTY];
  if (bridge !== undefined) {
    return desktopHost(bridge);
  }
  const fragment = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return harnessHost(fragment);
}
