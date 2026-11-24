/**
 * The renderer's connection to the backend and the state the views read. It follows t3code's
 * session client (pingdotgg/t3code `packages/client-runtime/src/rpc/session.ts` at 2fe7febc, MIT
 * licence, Copyright (c) 2026 T3 Tools Inc.; see apps/desktop/THIRD_PARTY_NOTICES.md), cut to one
 * backend: each session asks the host for the connection, trades the bearer for a fresh ticket,
 * opens one socket that never reconnects on its own, and ends when the socket closes. Then the
 * next session starts, so a restarted backend is reached with its new address and bearer.
 *
 * The client keeps the user's open request, with its id, until its own result answers it or the
 * backend's state names it as open or as failed, whichever the client sees first; the failure's
 * message is kept either way. The first state of each session settles the request: one the backend
 * is opening (the state names its id) is waited for, one it settled is cleared, and any other goes
 * again, so a request survives a dropped connection and a restarted backend together. With no
 * request, a backend that came back without the last deck opens it again, and one that has a deck
 * open, after the window reloads, keeps it.
 * Everything about an open deck is keyed by its scope id, and nothing from another scope lands.
 */

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import type { SlideId } from "@elmeragroup/deck-core/deck/slide-id";

import { SOCKET_PATH, TICKET_PATH, TicketResponse } from "../../contract/studio-launch.ts";
import { StudioRpcs } from "../../contract/studio-rpc.ts";
import { OpenRequestId } from "../../contract/studio-rpc.ts";
import type {
  MovePosition,
  OpenDeck,
  RecentDeck,
  ScopeId,
  SlideSummary,
  StudioState,
} from "../../contract/studio-rpc.ts";
import type { StudioHost } from "../host.ts";

/** How long the client waits before the next session after one ends. */
const RECONNECT_DELAY = Duration.millis(500);

/** How long a socket may take to open. */
const SOCKET_OPEN_TIMEOUT = Duration.seconds(10);

/** Where the connection to the backend stands. */
export type Connection =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Connected"; readonly studio: StudioState }
  | { readonly _tag: "Reconnecting"; readonly reason: string };

/** Where the preview is, as the open deck last reported it. */
export type PreviewPosition = {
  readonly scopeId: ScopeId;
  readonly slideId: string;
  readonly step: number;
};

/** The open deck's slides, in order. */
export type SlideList = {
  readonly scopeId: ScopeId;
  readonly slides: ReadonlyArray<SlideSummary>;
};

/** Everything the views read. */
export type StudioSnapshot = {
  readonly connection: Connection;
  readonly slides: SlideList | null;
  readonly position: PreviewPosition | null;
  readonly recent: ReadonlyArray<RecentDeck>;
  /** The last failure or confirmation to announce, or null. */
  readonly notice: string | null;
};

/** How a slide move ended. */
export type MoveOutcome = { readonly _tag: "Moved" } | { readonly _tag: "NotMoved" };

/** The renderer's handle on the backend. */
export type StudioClient = {
  /** Call `listener` after every snapshot change; the returned function stops it. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => StudioSnapshot;
  /** Open the deck in `directory`, closing the open one first. */
  readonly openDeck: (directory: string) => void;
  /** Ask the host for a deck directory, then open it. */
  readonly pickDeck: () => void;
  /** Close the open deck. */
  readonly closeDeck: () => void;
  /**
   * Move a slide of the open deck. The slide list shows the new order once the edit reaches the
   * disk, through the same report as any other edit.
   *
   * @returns Whether the backend moved it.
   */
  readonly moveSlide: (id: SlideId, position: MovePosition) => Promise<MoveOutcome>;
  /** Record the preview's position, if it is for the open deck's scope. */
  readonly reportPosition: (position: PreviewPosition) => void;
};

type StudioRpcClient = Effect.Success<ReturnType<typeof makeRpcClient>>;

/** An open the user asked for: its path, and the id that the result and the backend's state name. */
type OpenRequest = { readonly id: OpenRequestId; readonly path: string };

function makeRpcClient() {
  return RpcClient.make(StudioRpcs);
}

/** The open deck in a backend state, if one is open or closing. */
export function deckOf(state: StudioState): OpenDeck | null {
  return state._tag === "Open" || state._tag === "Closing" ? state.deck : null;
}

/**
 * Start the client. It runs for the life of the page.
 *
 * @param host - Where the renderer runs.
 * @returns The client.
 */
export function startStudioClient(host: StudioHost): StudioClient {
  const listeners = new Set<() => void>();
  let snapshot: StudioSnapshot = {
    connection: { _tag: "Connecting" },
    slides: null,
    position: null,
    recent: [],
    notice: null,
  };
  const update = (change: Partial<StudioSnapshot>) => {
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) {
      listener();
    }
  };

  // The current session's RPC client, while one is connected.
  let rpc: StudioRpcClient | null = null;
  // The open the user asked for that nothing has settled yet: only its own result, or a state that
  // names its id as open or failed, clears it. A session that ends first leaves it for the next.
  let requested: OpenRequest | null = null;
  // The deck the backend last reported open, which a backend that comes back empty opens again.
  let lastOpen: string | null = null;
  // The scope whose slides and position the snapshot holds.
  let tracked: ScopeId | null = null;

  // Trace headers would need their own CORS allowance, and the renderer exports no traces.
  const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.runFork(
      effect.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false)
      )
    );

  const failureText = (cause: Cause.Cause<{ readonly message: string }>) =>
    Option.match(Cause.findErrorOption(cause), {
      onNone: () => Cause.pretty(cause),
      onSome: (error) => error.message,
    });

  const request = (path: string): OpenRequest => {
    requested = { id: OpenRequestId.make(crypto.randomUUID()), path };
    return requested;
  };

  /** Clear the request when `studio` names it as open, or as failed, keeping the failure's message. */
  const settle = (studio: StudioState) => {
    if (requested === null) {
      return;
    }
    if (studio._tag === "Open" && studio.deck.requestId === requested.id) {
      requested = null;
      update({ notice: null });
    } else if (studio._tag === "Empty" && studio.failed?.requestId === requested.id) {
      requested = null;
      lastOpen = null;
      update({ notice: studio.failed.message });
    }
  };

  /** Send `open` on `client`. Only its own result clears it, and only while it is still wanted. */
  const send = (client: StudioRpcClient, open: OpenRequest) => {
    return client["deck.open"]({ path: open.path, requestId: open.id }).pipe(
      Effect.match({
        onFailure: (error) => {
          // A deck that failed to open is no longer wanted, not even as the one to reopen after a
          // restart. A dropped connection is not the deck's fault: the next session sends the
          // request again.
          if (error._tag === "DeckOpenFailed" && requested?.id === open.id) {
            requested = null;
            lastOpen = null;
          }
          update({ notice: error.message });
        },
        onSuccess: () => {
          if (requested?.id === open.id) {
            requested = null;
            update({ notice: null });
          }
        },
      })
    );
  };

  const refreshRecent = (client: StudioRpcClient) =>
    client["recent.list"]().pipe(
      Effect.match({ onFailure: () => undefined, onSuccess: (recent) => update({ recent }) })
    );

  const refreshSlides = (client: StudioRpcClient, scopeId: ScopeId) =>
    client["slides.list"]({ scopeId }).pipe(
      Effect.match({
        onFailure: (error) => {
          if (error._tag !== "StaleScope") {
            update({ notice: error.message });
          }
        },
        onSuccess: (slides) => {
          if (tracked === scopeId) {
            update({ slides: { scopeId, slides } });
          }
        },
      })
    );

  /**
   * The slide list for one scope. `deck.changed` reports once as soon as it listens, so the first
   * read follows the subscription and no edit falls between them; each later report reads again.
   */
  const followScope = (client: StudioRpcClient, scopeId: ScopeId) =>
    client["deck.changed"]({ scopeId }).pipe(
      Stream.runForEach(() => refreshSlides(client, scopeId)),
      Effect.ignore
    );

  const session = Effect.gen(function* () {
    update({ connection: { _tag: "Connecting" } });
    const connection = yield* host.connection;
    const http = yield* HttpClient.HttpClient;
    const { ticket } = yield* http
      .execute(
        HttpClientRequest.post(new URL(TICKET_PATH, connection.url).href).pipe(
          HttpClientRequest.bearerToken(connection.bearer)
        )
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(TicketResponse))
      );
    const socketUrl = new URL(SOCKET_PATH, connection.url);
    socketUrl.protocol = "ws:";
    socketUrl.searchParams.set("ticket", ticket);

    const disconnected = yield* Deferred.make<void>();
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Effect.void,
      onDisconnect: Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid),
    });
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) })
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(socketUrl.href, { openTimeout: SOCKET_OPEN_TIMEOUT }).pipe(
              Layer.provide(Socket.layerWebSocketConstructorGlobal)
            ),
            RpcSerialization.layerJson,
            Layer.succeed(RpcClient.ConnectionHooks, hooks)
          )
        )
      )
    );
    const client = yield* makeRpcClient().pipe(Effect.provide(protocol));
    rpc = client;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rpc = null;
      })
    );
    const scopeWork = yield* FiberHandle.make();
    let reconciled = false;

    /**
     * Settle the user's request against the first state this session sees, after `settle` had its
     * look. The backend carries it out already when it is opening that request; its result or the
     * state that follows settles it. Any other request goes again: the backend may have restarted
     * since, or never seen it.
     */
    const reconcile = (studio: StudioState) => {
      if (requested === null || (studio._tag === "Opening" && studio.requestId === requested.id)) {
        return Effect.void;
      }
      return Effect.forkScoped(send(client, requested));
    };

    const onState = Effect.fnUntraced(function* (studio: StudioState) {
      update({ connection: { _tag: "Connected", studio } });
      settle(studio);
      if (!reconciled) {
        reconciled = true;
        yield* reconcile(studio);
      }
      if (studio._tag === "Open" && studio.deck.scopeId !== tracked) {
        tracked = studio.deck.scopeId;
        lastOpen = studio.deck.root;
        update({ slides: null, position: null });
        yield* FiberHandle.run(scopeWork, followScope(client, studio.deck.scopeId));
      }
      if (studio._tag === "Empty") {
        tracked = null;
        yield* FiberHandle.clear(scopeWork);
        update({ slides: null, position: null });
        // The empty view lists the recent decks, the one just closed among them.
        yield* Effect.forkScoped(refreshRecent(client));
        if (requested === null && lastOpen !== null) {
          yield* Effect.forkScoped(send(client, request(lastOpen)));
        }
      }
    });

    yield* client["studio.state"]().pipe(
      Stream.runForEach(onState),
      Effect.ignore,
      Effect.ensuring(Deferred.succeed(disconnected, undefined)),
      Effect.forkScoped
    );
    yield* Deferred.await(disconnected);
  });

  const loop = Effect.gen(function* () {
    const initial = yield* Effect.orElseSucceed(host.initialDeck, () => Option.none());
    if (Option.isSome(initial) && requested === null) {
      request(initial.value);
    }
    while (true) {
      const ended = yield* Effect.exit(Effect.scoped(session));
      tracked = null;
      update({
        connection: {
          _tag: "Reconnecting",
          reason: ended._tag === "Failure" ? failureText(ended.cause) : "The backend closed the connection.",
        },
        slides: null,
        position: null,
      });
      yield* Effect.sleep(RECONNECT_DELAY);
    }
  });
  run(loop);

  // A deck asked for while no session is connected is opened by the next session, which settles
  // the request against the state it finds.
  const openRequested = (directory: string) => {
    lastOpen = null;
    const open = request(directory);
    if (rpc === null) {
      update({ notice: `Opening ${directory} once the studio backend is connected.` });
      return;
    }
    run(send(rpc, open));
  };

  const withClient = (action: (client: StudioRpcClient) => Effect.Effect<void>) => {
    if (rpc === null) {
      update({ notice: "The studio is not connected to its backend yet." });
      return;
    }
    run(action(rpc));
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    openDeck: (directory) => {
      openRequested(directory);
    },
    pickDeck: () => {
      run(
        host.pickDeck.pipe(
          Effect.match({
            onFailure: (error) => {
              update({ notice: error.message });
            },
            onSuccess: (picked) => {
              if (Option.isSome(picked)) {
                openRequested(picked.value);
              }
            },
          })
        )
      );
    },
    closeDeck: () => {
      const scopeId = tracked;
      if (scopeId === null) {
        return;
      }
      requested = null;
      lastOpen = null;
      withClient((client) => client["deck.close"]({ scopeId }).pipe(Effect.ignore));
    },
    moveSlide: (id, position) => {
      const scopeId = tracked;
      const client = rpc;
      if (scopeId === null || client === null) {
        update({ notice: "The studio is not connected to its backend yet." });
        return Promise.resolve({ _tag: "NotMoved" });
      }
      return Effect.runPromise(
        client["slides.move"]({ scopeId, id, position }).pipe(
          Effect.match({
            onFailure: (error): MoveOutcome => {
              if (error._tag !== "StaleScope") {
                update({ notice: error.message });
              }
              return { _tag: "NotMoved" };
            },
            onSuccess: (): MoveOutcome => {
              const where = position._tag === "Before" ? "before" : "after";
              update({ notice: `Moved ${id} ${where} ${position.anchor}.` });
              return { _tag: "Moved" };
            },
          }),
          Effect.catchCause(() => Effect.succeed<MoveOutcome>({ _tag: "NotMoved" }))
        )
      );
    },
    reportPosition: (position) => {
      if (position.scopeId === tracked) {
        update({ position });
      }
    },
  };
}
