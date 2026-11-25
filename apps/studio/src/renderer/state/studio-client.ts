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
 * open, after the window reloads, keeps it. While it
 * opens that deck again, the snapshot names it in `reopening`, so the workspace and its draft stay
 * until the deck is open again. A reopen that failed stays named in `reopenFailed` until the user
 * retries it or lets the deck go, so the workspace can keep a draft with edits meanwhile.
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
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import type {
  DiskSlide,
  OpenedSlide,
  SavedSlide,
  SlideRevision,
} from "@elmeragroup/deck-core/deck/slide-edit";
import { SlideId } from "@elmeragroup/deck-core/deck/slide-id";

import type { ChatState, ObservedChanges, PromptInput } from "../../contract/agent-chat.ts";
import type { LeaveIntent } from "../../contract/desktop-bridge.ts";
import { SOCKET_PATH, TICKET_PATH, TicketResponse } from "../../contract/studio-launch.ts";
import { OpenRequestId, StudioRpcs } from "../../contract/studio-rpc.ts";
import type {
  MovePosition,
  OpenDeck,
  RecentDeck,
  ScopeId,
  SlideSummary,
  StudioState,
} from "../../contract/studio-rpc.ts";
import type { StudioHost } from "../host.ts";

const decodeSlideId = Schema.decodeUnknownOption(SlideId);

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

/** What the agent's `view_go` asks the preview of the deck `scopeId` names. */
export type PreviewRequest =
  | {
      readonly _tag: "Go";
      readonly scopeId: ScopeId;
      readonly requestId: string;
      readonly slideId: string;
      readonly step: number;
    }
  | { readonly _tag: "Cancel"; readonly scopeId: ScopeId; readonly requestId: string };

/** The open deck's slides, in order. */
export type SlideList = {
  readonly scopeId: ScopeId;
  readonly slides: ReadonlyArray<SlideSummary>;
};

/** The files the open deck's watcher last reported changed. Each report has its own serial. */
export type DiskChange = {
  readonly scopeId: ScopeId;
  readonly serial: number;
  /** Paths relative to the deck directory, such as `slides/intro.mdx`. */
  readonly paths: ReadonlyArray<string>;
};

/** Everything the views read. */
export type StudioSnapshot = {
  readonly connection: Connection;
  readonly slides: SlideList | null;
  /** The open deck's agent chat, as the backend last reported it, or null before the first report. */
  readonly chat: ChatState | null;
  /** The last change on disk the open deck reported, or null before the first. */
  readonly diskChange: DiskChange | null;
  readonly position: PreviewPosition | null;
  readonly recent: ReadonlyArray<RecentDeck>;
  /** The last failure or confirmation to announce, or null. */
  readonly notice: string | null;
  /**
   * The deck directory the client is opening again because the backend came back without it,
   * such as after a restart, or null. It clears once that deck is open or its reopen failed.
   */
  readonly reopening: string | null;
  /**
   * The deck the client could not open again, and why, or null. The workspace keeps its draft
   * while this names its deck, until the user retries the reopen or lets the deck go.
   */
  readonly reopenFailed: ReopenFailure | null;
  /** Counts the sessions that reached the backend, so a view can tell a reconnect from a render. */
  readonly session: number;
};

/** A deck the client opened again after the backend came back without it, and the open failed. */
export type ReopenFailure = {
  /** The deck directory. */
  readonly root: string;
  readonly message: string;
};

/** How opening a slide's source ended. */
export type OpenOutcome =
  | { readonly _tag: "Opened"; readonly slide: OpenedSlide }
  /** The order names the slide but its file is gone, or the order no longer names it. */
  | { readonly _tag: "Gone"; readonly message: string }
  | { readonly _tag: "Failed"; readonly message: string };

/** How saving a slide's source ended. */
export type SaveOutcome =
  | { readonly _tag: "Saved"; readonly saved: SavedSlide }
  /** The file changed or was deleted since it was opened; nothing was written. */
  | { readonly _tag: "Conflict"; readonly disk: DiskSlide }
  /** The deck's order no longer names the slide; nothing was written. */
  | { readonly _tag: "NotInDeck"; readonly message: string }
  | { readonly _tag: "Failed"; readonly message: string };

/** How a slide move ended. */
export type MoveOutcome = { readonly _tag: "Moved" } | { readonly _tag: "NotMoved" };

/** How sending a prompt, stopping a turn or answering a permission request ended. */
export type ChatOutcome = { readonly _tag: "Done" } | { readonly _tag: "Failed"; readonly message: string };

/** How reading the observed changes ended. */
export type ChangesOutcome =
  | { readonly _tag: "Read"; readonly changes: ObservedChanges }
  | { readonly _tag: "Failed"; readonly message: string };

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
  /** Open again the deck `reopenFailed` names. */
  readonly retryReopen: () => void;
  /** Let go of the deck `reopenFailed` names, and of the workspace kept for it. */
  readonly dismissReopenFailure: () => void;
  /**
   * Move a slide of the open deck. The slide list shows the new order once the edit reaches the
   * disk, through the same report as any other edit.
   *
   * @returns Whether the backend moved it.
   */
  readonly moveSlide: (id: SlideId, position: MovePosition) => Promise<MoveOutcome>;
  /**
   * Record the preview's position, if it is for the open deck's scope, and report it to the
   * backend, where the agent's `view_current` reads it, as the answer to the go `requestId` names
   * when it is one.
   */
  readonly reportPosition: (position: PreviewPosition, requestId: string | null) => void;
  /**
   * Call `listener` with each go the agent's `view_go` asks the preview for, and each cancel of
   * one; returns the unsubscribe.
   */
  readonly onViewRequest: (listener: (request: PreviewRequest) => void) => () => void;
  /** Show `message` in the status line, which announces it. */
  readonly announce: (message: string) => void;
  /** Read a slide's source and its revision from the deck `scopeId` names. */
  readonly openSlide: (scopeId: ScopeId, id: SlideId) => Promise<OpenOutcome>;
  /**
   * Save a slide's source in the deck `scopeId` names, over the revision the editor opened, or
   * over no file when `expected` is null.
   */
  readonly saveSlide: (
    scopeId: ScopeId,
    id: SlideId,
    expected: SlideRevision | null,
    source: string
  ) => Promise<SaveOutcome>;
  /**
   * Present the deck page at `url`: a fullscreen window in the desktop app, the preview frame in
   * the browser's fullscreen otherwise.
   */
  readonly present: (url: string, frame: HTMLIFrameElement | null) => void;
  /** Tell the host whether the Source tab holds a draft with edits. */
  readonly reportUnsavedDraft: (unsaved: boolean) => void;
  /** Send a prompt to the agent of the deck `scopeId` names. */
  readonly sendPrompt: (scopeId: ScopeId, input: PromptInput) => Promise<ChatOutcome>;
  /** Stop the running turn of the deck `scopeId` names. */
  readonly stopAgent: (scopeId: ScopeId) => Promise<ChatOutcome>;
  /** Answer a pending permission request with one of the choices the agent offered. */
  readonly decide: (scopeId: ScopeId, requestId: string, optionId: string) => Promise<ChatOutcome>;
  /** The files that changed on disk since the last turn started. */
  readonly listChanges: (scopeId: ScopeId) => Promise<ChangesOutcome>;
  /** Call `listener` each time the host holds back a quit or a window close; returns the unsubscribe. */
  readonly onLeaveRequest: (listener: (intent: LeaveIntent) => void) => () => void;
  /** Go on with the quit or the window close the host held back. */
  readonly leave: (intent: LeaveIntent) => void;
};

type StudioRpcClient = Effect.Success<ReturnType<typeof makeRpcClient>>;

/**
 * An open the client asked for: its path, the id that the result and the backend's state name, and
 * whether the user asked for it or the client opens the last deck again after a restart.
 */
type OpenRequest = { readonly id: OpenRequestId; readonly path: string; readonly kind: "User" | "Reopen" };

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
  const viewListeners = new Set<(request: PreviewRequest) => void>();
  let snapshot: StudioSnapshot = {
    connection: { _tag: "Connecting" },
    slides: null,
    chat: null,
    diskChange: null,
    position: null,
    recent: [],
    notice: null,
    reopening: null,
    reopenFailed: null,
    session: 0,
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
  let changeSerial = 0;
  // Set once the page told main to go on with a quit. Main stops answering the page while it
  // shuts down, so a draft report the save's re-render sends after that would go nowhere.
  let quitting = false;

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

  const request = (path: string, kind: OpenRequest["kind"]): OpenRequest => {
    requested = { id: OpenRequestId.make(crypto.randomUUID()), path, kind };
    return requested;
  };

  /**
   * `open` failed. It is no longer wanted, not even as the deck to reopen after a restart. A
   * failed reopen is kept as `reopenFailed`, so the workspace can keep the draft it holds.
   */
  const openFailed = (open: OpenRequest, message: string) => {
    requested = null;
    lastOpen = null;
    update({
      notice: message,
      reopening: null,
      reopenFailed: open.kind === "Reopen" ? { root: open.path, message } : snapshot.reopenFailed,
    });
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
      openFailed(requested, studio.failed.message);
    }
  };

  /** Send `open` on `client`. Only its own result clears it, and only while it is still wanted. */
  const send = (client: StudioRpcClient, open: OpenRequest) => {
    return client["deck.open"]({ path: open.path, requestId: open.id }).pipe(
      Effect.match({
        onFailure: (error) => {
          // A dropped connection is not the deck's fault: the next session sends the request again.
          if (error._tag === "DeckOpenFailed" && requested?.id === open.id) {
            openFailed(open, error.message);
            return;
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
    Effect.all(
      [
        client["deck.changed"]({ scopeId }).pipe(
          Stream.runForEach(({ paths }) =>
            Effect.suspend(() => {
              if (tracked === scopeId && paths.length > 0) {
                changeSerial += 1;
                update({ diskChange: { scopeId, serial: changeSerial, paths } });
              }
              return refreshSlides(client, scopeId);
            })
          ),
          Effect.ignore
        ),
        // The agent's go requests, which the preview carries out.
        client["view.requests"]({ scopeId }).pipe(
          Stream.runForEach((request) =>
            Effect.sync(() => {
              if (tracked === scopeId) {
                for (const listener of viewListeners) {
                  listener({ ...request, scopeId });
                }
              }
            })
          ),
          Effect.ignore
        ),
        // The chat, with its turn, which keeps Source read-only while the agent works.
        client["agent.chat"]({ scopeId }).pipe(
          Stream.runForEach((chat) =>
            Effect.sync(() => {
              if (tracked === scopeId) {
                update({ chat });
              }
            })
          ),
          Effect.ignore
        ),
      ],
      { concurrency: "unbounded", discard: true }
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
      const first = !reconciled;
      settle(studio);
      if (!reconciled) {
        reconciled = true;
        yield* reconcile(studio);
      }
      const opened = studio._tag === "Open" && studio.deck.scopeId !== tracked ? studio.deck : null;
      // A backend that has no deck, while the user asked for none, lost the last one: open it again.
      const reopen = studio._tag === "Empty" && requested === null ? lastOpen : null;
      if (opened !== null) {
        tracked = opened.scopeId;
        lastOpen = opened.root;
      }
      if (studio._tag === "Empty") {
        tracked = null;
      }
      // One update, so no view sees the empty state without the reopen that follows it.
      const newScope = opened !== null || studio._tag === "Empty";
      update({
        connection: { _tag: "Connected", studio },
        slides: newScope ? null : snapshot.slides,
        // A chat of the scope that is open again stays until its stream reports.
        chat:
          studio._tag === "Empty" || (opened !== null && snapshot.chat?.scopeId !== opened.scopeId)
            ? null
            : snapshot.chat,
        position: newScope ? null : snapshot.position,
        reopening: studio._tag === "Open" ? null : (reopen ?? snapshot.reopening),
        reopenFailed: studio._tag === "Open" ? null : snapshot.reopenFailed,
        session: first ? snapshot.session + 1 : snapshot.session,
      });
      if (opened !== null) {
        yield* FiberHandle.run(scopeWork, followScope(client, opened.scopeId));
      }
      if (studio._tag === "Empty") {
        yield* FiberHandle.clear(scopeWork);
        // The empty view lists the recent decks, the one just closed among them.
        yield* Effect.forkScoped(refreshRecent(client));
        if (reopen !== null) {
          yield* Effect.forkScoped(send(client, request(reopen, "Reopen")));
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
      request(initial.value, "User");
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
        // The chat stays, with its turn, so Source stays read-only while an agent turn may still
        // run; the next session replaces it.
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
    update({ reopening: null, reopenFailed: null });
    const open = request(directory, "User");
    if (rpc === null) {
      update({ notice: `Opening ${directory} once the studio backend is connected.` });
      return;
    }
    run(send(rpc, open));
  };

  const notConnected = "The studio is not connected to its backend yet.";

  /** Run a chat call on the current session, as a promise of how it ended. */
  const chatCall = <E extends { readonly message: string }>(
    call: (client: StudioRpcClient) => Effect.Effect<void, E>
  ): Promise<ChatOutcome> => {
    const client = rpc;
    if (client === null) {
      return Promise.resolve({ _tag: "Failed", message: notConnected });
    }
    return Effect.runPromise(
      call(client).pipe(
        Effect.match({
          onFailure: (error): ChatOutcome => ({ _tag: "Failed", message: error.message }),
          onSuccess: (): ChatOutcome => ({ _tag: "Done" }),
        }),
        Effect.catchCause((cause) =>
          Effect.succeed<ChatOutcome>({ _tag: "Failed", message: failureText(cause) })
        )
      )
    );
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
      update({ reopening: null, reopenFailed: null });
      withClient((client) => client["deck.close"]({ scopeId }).pipe(Effect.ignore));
    },
    retryReopen: () => {
      const failed = snapshot.reopenFailed;
      if (failed === null) {
        return;
      }
      const open = request(failed.root, "Reopen");
      update({ reopening: failed.root, reopenFailed: null, notice: null });
      if (rpc !== null) {
        run(send(rpc, open));
      }
    },
    dismissReopenFailure: () => {
      update({ reopenFailed: null });
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
    reportPosition: (position, requestId) => {
      if (position.scopeId !== tracked) {
        return;
      }
      update({ position });
      const client = rpc;
      const slideId = decodeSlideId(position.slideId);
      if (client !== null && Option.isSome(slideId)) {
        run(
          client["view.report"]({
            scopeId: position.scopeId,
            position: { slideId: slideId.value, step: position.step },
            requestId,
          }).pipe(Effect.ignore)
        );
      }
    },
    onViewRequest: (listener) => {
      viewListeners.add(listener);
      return () => {
        viewListeners.delete(listener);
      };
    },
    announce: (message) => {
      update({ notice: message });
    },
    openSlide: (scopeId, id) => {
      const client = rpc;
      if (client === null) {
        return Promise.resolve({ _tag: "Failed", message: notConnected });
      }
      return Effect.runPromise(
        client["slide.open"]({ scopeId, id }).pipe(
          Effect.match({
            onFailure: (error): OpenOutcome =>
              error._tag === "DeckOperationFailed" &&
              (error.reason === "SlideFileMissing" || error.reason === "SlideNotInDeck")
                ? { _tag: "Gone", message: error.message }
                : { _tag: "Failed", message: error.message },
            onSuccess: (slide): OpenOutcome => ({ _tag: "Opened", slide }),
          }),
          Effect.catchCause((cause) =>
            Effect.succeed<OpenOutcome>({ _tag: "Failed", message: failureText(cause) })
          )
        )
      );
    },
    saveSlide: (scopeId, id, expected, source) => {
      const client = rpc;
      if (client === null) {
        return Promise.resolve({ _tag: "Failed", message: notConnected });
      }
      return Effect.runPromise(
        client["slide.save"]({ scopeId, id, expected, source }).pipe(
          Effect.match({
            onFailure: (error): SaveOutcome => {
              if (error._tag === "SlideConflict") {
                return { _tag: "Conflict", disk: error.disk };
              }
              if (error._tag === "DeckOperationFailed" && error.reason === "SlideNotInDeck") {
                return { _tag: "NotInDeck", message: error.message };
              }
              // A stale scope, a held lock, a disk failure or a dropped connection.
              return { _tag: "Failed", message: error.message };
            },
            onSuccess: (saved): SaveOutcome => ({ _tag: "Saved", saved }),
          }),
          Effect.catchCause((cause) =>
            Effect.succeed<SaveOutcome>({ _tag: "Failed", message: failureText(cause) })
          )
        )
      );
    },
    present: (url, frame) => {
      run(
        host.present({ url, frame }).pipe(
          Effect.match({
            onFailure: (error) => {
              update({ notice: error.message });
            },
            onSuccess: () => undefined,
          })
        )
      );
    },
    reportUnsavedDraft: (unsaved) => {
      if (!quitting) {
        run(host.reportUnsavedDraft(unsaved).pipe(Effect.ignore));
      }
    },
    sendPrompt: (scopeId, input) => chatCall((client) => client["agent.prompt"]({ scopeId, input })),
    stopAgent: (scopeId) => chatCall((client) => client["agent.stop"]({ scopeId })),
    decide: (scopeId, requestId, optionId) =>
      chatCall((client) => client["agent.decide"]({ scopeId, requestId, optionId })),
    listChanges: (scopeId) => {
      const client = rpc;
      if (client === null) {
        return Promise.resolve({ _tag: "Failed", message: notConnected });
      }
      return Effect.runPromise(
        client["changes.list"]({ scopeId }).pipe(
          Effect.match({
            onFailure: (error): ChangesOutcome => ({ _tag: "Failed", message: error.message }),
            onSuccess: (changes): ChangesOutcome => ({ _tag: "Read", changes }),
          }),
          Effect.catchCause((cause) =>
            Effect.succeed<ChangesOutcome>({ _tag: "Failed", message: failureText(cause) })
          )
        )
      );
    },
    onLeaveRequest: (listener) => host.onLeaveRequest(listener),
    leave: (intent) => {
      quitting ||= intent === "quit";
      run(
        host.leave(intent).pipe(
          Effect.match({
            onFailure: (error) => {
              // Main did not go on, so it still answers the page's reports.
              quitting = false;
              update({ notice: error.message });
            },
            onSuccess: () => undefined,
          })
        )
      );
    },
  };
}
