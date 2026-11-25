/**
 * The open deck. The backend starts with none and holds at most one. Each opening is a scope with
 * its own id, the deck's files, and its own listener on a fresh 127.0.0.1 port, where Vite serves
 * the deck in middleware mode. Vite then installs none of the process handlers its own server
 * installs, which end the process on SIGTERM or when stdin ends, so a stop waits for the drain.
 *
 * Opening and closing are serialized. To switch, the old scope is marked closing, so it admits no
 * new call; the calls it already admitted get the drain timeout to settle and are cancelled after
 * that; then its dev server stops, and only then does the next deck open. A call names its scope
 * by id and is admitted or refused before it does anything, so a call meant for the old deck can
 * never run against the new one. The admitted calls are the fibers in the scope's set: the drain
 * waits for that set, and the published count is its size.
 */

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import path from "node:path";

import { Bundler } from "@elmeragroup/deck-core/bundler/bundler";
import { DeckFiles } from "@elmeragroup/deck-core/deck/deck-files";

import { DeckOpenFailed, ScopeId, StaleScope } from "../contract/studio-rpc.ts";
import type { DeckChanged, OpenDeck, OpenRequestId, StudioState } from "../contract/studio-rpc.ts";
import { RecentDecks } from "./recent-decks.ts";

/**
 * How long a closing deck's admitted calls may run before they are cancelled, by default. With
 * Vite's close and the HTTP server's grace after it, a stop fits `BACKEND_STOP_DEADLINE`.
 */
export const DRAIN_TIMEOUT = Duration.seconds(10);

/** How long `deck.changed` gathers watcher events into one report. */
const CHANGE_WINDOW = Duration.millis(50);

/** The deck services a call about an open deck works with. */
export type ScopedDeck = {
  readonly deck: OpenDeck;
  readonly files: DeckFiles["Service"];
  readonly bundler: Bundler["Service"];
};

/** One opening of a deck, while it is open or closing. */
type LiveScope = ScopedDeck & {
  readonly scope: Scope.Closeable;
  /** The admitted calls that have not settled. */
  readonly work: FiberSet.FiberSet<unknown, unknown>;
  readonly changes: PubSub.PubSub<DeckChanged>;
  /** Set once, when the scope starts closing; from then on it admits nothing. */
  closing: boolean;
  /** What this scope last published, so each change publishes once. */
  published: { readonly closing: boolean; readonly admitted: number } | undefined;
};

/** The deck's listener could not start on 127.0.0.1. */
class PreviewListenFailed extends Schema.TaggedError<PreviewListenFailed>()("PreviewListenFailed", {
  message: Schema.String,
}) {}

/** What the open deck's scopes need from the host. */
export type DeckScopesConfig = {
  /** The renderer's origin, the only page allowed to frame a deck. */
  readonly embedderOrigin: string;
  /** The deck runtime's directory, `main.js` and `deck.css`. */
  readonly runtimeRoot: string;
  /** Where each deck's dev server keeps what Vite generates: the studio's own storage, never the deck. */
  readonly cacheRoot: string;
  /** How long a closing deck's admitted calls may run before they are cancelled. */
  readonly drainTimeout: Duration.Duration;
};

/** Opens, closes and admits calls about the one open deck. */
export class DeckScopes extends Context.Service<
  DeckScopes,
  {
    /** Where the deck stands, now and as it changes. */
    readonly state: Stream.Stream<StudioState>;
    /** Close the open deck, if any, then open the deck in `directory`, for the request `requestId`. */
    readonly open: (directory: string, requestId: OpenRequestId) => Effect.Effect<OpenDeck, DeckOpenFailed>;
    /** Close the deck `scopeId` names. */
    readonly close: (scopeId: ScopeId) => Effect.Effect<void, StaleScope>;
    /**
     * Run `work` against the deck `scopeId` names, or fail with `StaleScope` before it starts when
     * that deck is closing or gone. Admitted work keeps the deck open until it settles.
     */
    readonly admit: <A, E>(
      scopeId: ScopeId,
      work: (deck: ScopedDeck) => Effect.Effect<A, E>
    ) => Effect.Effect<A, E | StaleScope>;
    /** The open deck's file changes, until it closes. */
    readonly changes: (scopeId: ScopeId) => Stream.Stream<DeckChanged, StaleScope>;
  }
>()("@elmeragroup/fuse-deck-studio/server/DeckScopes") {
  /**
   * The deck scopes. Closing the layer closes the open deck.
   *
   * @param config - The embedder origin and the runtime directory.
   */
  static readonly layer = (config: DeckScopesConfig) =>
    Layer.effect(
      DeckScopes,
      Effect.gen(function* () {
        const recent = yield* RecentDecks;
        // Each deck's layers read the file system this layer was built with.
        const platform = yield* Effect.context<FileSystem.FileSystem>();
        const state = yield* SubscriptionRef.make<StudioState>({ _tag: "Empty", failed: null });
        const switching = yield* Semaphore.make(1);
        // One publish at a time, so a count read before another publish never lands after it.
        const publishing = yield* Semaphore.make(1);
        let current: LiveScope | undefined;

        /** Publish `live`'s state, while it is the current scope and only when it changed. */
        const publish = (live: LiveScope) =>
          publishing.withPermits(1)(
            Effect.gen(function* () {
              if (current !== live) {
                return;
              }
              const admitted = yield* FiberSet.size(live.work);
              const { closing } = live;
              if (live.published?.closing === closing && live.published.admitted === admitted) {
                return;
              }
              live.published = { closing, admitted };
              yield* SubscriptionRef.set(
                state,
                closing
                  ? { _tag: "Closing", deck: live.deck, admitted }
                  : { _tag: "Open", deck: live.deck, admitted }
              );
            })
          );

        const stale = (scopeId: string) =>
          new StaleScope({ scopeId, message: `The deck scope ${scopeId} is closing or no longer open.` });

        /** The scope `scopeId` names, if it is open and admitting. */
        const admitting = (scopeId: ScopeId): LiveScope | undefined =>
          current?.deck.scopeId === scopeId && !current.closing ? current : undefined;

        const closeLive = Effect.fn("DeckScopes.closeLive")(function* (live: LiveScope) {
          live.closing = true;
          yield* publish(live);
          yield* Effect.logInfo(
            `Closing ${live.deck.root} once its ${String(yield* FiberSet.size(live.work))} admitted calls settle.`
          );
          const drained = yield* FiberSet.awaitEmpty(live.work).pipe(
            Effect.timeoutOption(config.drainTimeout)
          );
          if (Option.isNone(drained)) {
            yield* Effect.logWarning(
              `Cancelling ${String(yield* FiberSet.size(live.work))} calls on ${live.deck.root} that did not settle within ${Duration.format(config.drainTimeout)}.`
            );
          }
          yield* FiberSet.clear(live.work);
          yield* publish(live);
          yield* Scope.close(live.scope, Exit.void);
          current = undefined;
        });

        const openLive = Effect.fn("DeckScopes.openLive")(function* (
          directory: string,
          requestId: OpenRequestId,
          scope: Scope.Closeable
        ) {
          const fs = yield* FileSystem.FileSystem;
          const scopeId = yield* newScopeId;
          // Vite serves only files under the deck's real path, and its watcher reports real paths,
          // so a deck reached through a symlink, such as macOS's temporary directory, opens there.
          const realDirectory = yield* fs.realPath(directory);
          const services = yield* Layer.buildWithScope(
            Bundler.layer({ runtimeRoot: config.runtimeRoot, cacheRoot: config.cacheRoot }).pipe(
              Layer.provideMerge(DeckFiles.layerFrom(realDirectory))
            ),
            scope
          );
          const files = Context.get(services, DeckFiles);
          const bundler = Context.get(services, Bundler);
          const { manifest } = yield* files.load;
          // Added to the scope before the dev server, so it closes after Vite has let go of it.
          const listener = yield* loopbackListener.pipe(Scope.provide(scope));
          const server = yield* bundler
            .dev({ _tag: "Embedded", embedder: { origin: config.embedderOrigin, scopeId }, listener })
            .pipe(Scope.provide(scope));
          const work = yield* FiberSet.make<unknown, unknown>().pipe(Scope.provide(scope));
          const changes = yield* PubSub.unbounded<DeckChanged>();
          yield* Scope.addFinalizer(scope, PubSub.shutdown(changes));
          yield* server.changes.pipe(
            Stream.map((file) => path.relative(files.root, file).split(path.sep).join("/")),
            Stream.filter(isReportedPath),
            Stream.groupedWithin(64, CHANGE_WINDOW),
            Stream.runForEach((paths) => PubSub.publish(changes, { scopeId, paths: [...new Set(paths)] })),
            Effect.forkIn(scope)
          );
          const live: LiveScope = {
            deck: { scopeId, requestId, root: files.root, title: manifest.title, url: server.url },
            files,
            bundler,
            scope,
            work,
            changes,
            closing: false,
            published: undefined,
          };
          return live;
        });

        const open = Effect.fn("DeckScopes.open")(function* (directory: string, requestId: OpenRequestId) {
          // Uninterruptible, so a renderer that disconnects mid-switch cannot leave a scope half
          // closed or a dev server without an owner.
          return yield* switching.withPermits(1)(
            Effect.uninterruptible(
              Effect.gen(function* () {
                if (current !== undefined) {
                  yield* closeLive(current);
                }
                yield* SubscriptionRef.set(state, { _tag: "Opening", path: directory, requestId });
                const scope = yield* Scope.make();
                const opened = yield* Effect.exit(
                  openLive(directory, requestId, scope).pipe(Effect.provide(platform))
                );
                if (Exit.isFailure(opened)) {
                  yield* Scope.close(scope, Exit.void);
                  const failure = Cause.findErrorOption(opened.cause);
                  const message = Option.match(failure, {
                    onNone: () => Cause.pretty(opened.cause),
                    onSome: (error) => error.message,
                  });
                  // The state keeps the failure, for a renderer whose connection dropped before
                  // the result reached it.
                  yield* SubscriptionRef.set(state, { _tag: "Empty", failed: { requestId, message } });
                  return yield* new DeckOpenFailed({ path: directory, message });
                }
                const live = opened.value;
                // Recorded before Open is published, so a renderer that sees the deck open and
                // then reads the recent decks finds it there.
                yield* recent.record({ root: live.deck.root, title: live.deck.title });
                current = live;
                yield* publish(live);
                return live.deck;
              })
            )
          );
        });

        const close = Effect.fn("DeckScopes.close")(function* (scopeId: ScopeId) {
          yield* switching.withPermits(1)(
            Effect.uninterruptible(
              Effect.gen(function* () {
                const live = admitting(scopeId);
                if (live === undefined) {
                  return yield* stale(scopeId);
                }
                yield* closeLive(live);
                yield* SubscriptionRef.set(state, { _tag: "Empty", failed: null });
              })
            )
          );
        });

        /**
         * Check the scope and fork `work` into its set as one step: the scheduler may not yield
         * between them, so a scope that starts closing either refused the call or waits for it.
         * The work itself yields as usual and stays interruptible, so a drain timeout cancels it.
         */
        const register = <A, E>(scopeId: ScopeId, work: (deck: ScopedDeck) => Effect.Effect<A, E>) =>
          Effect.suspend(() => {
            const live = admitting(scopeId);
            return live === undefined
              ? Effect.fail(stale(scopeId))
              : FiberSet.run(
                  live.work,
                  work(live).pipe(
                    Effect.interruptible,
                    Effect.provideService(Scheduler.PreventSchedulerYield, false)
                  )
                ).pipe(Effect.map((fiber) => ({ live, fiber })));
          }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true));

        const admit = <A, E>(scopeId: ScopeId, work: (deck: ScopedDeck) => Effect.Effect<A, E>) =>
          // Uninterruptible from the check through the registration and the watch on the fiber,
          // so an interrupted caller leaves no admitted call uncounted or unpublished. A caller
          // interrupted while it waits only stops waiting; the call runs on until it settles.
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const { live, fiber } = yield* register(scopeId, work);
              // The set drops the fiber as it exits, before this watch resumes, so the publish
              // counts it out.
              yield* Fiber.await(fiber).pipe(
                Effect.andThen(publish(live)),
                Effect.interruptible,
                Effect.forkIn(live.scope)
              );
              yield* publish(live);
              return yield* restore(Fiber.join(fiber));
            })
          );

        /**
         * The open deck's file changes. The stream subscribes first and then reports no paths, so
         * a reader that loads the deck on each report, the first included, misses no edit.
         */
        const changes = (scopeId: ScopeId) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const live = admitting(scopeId);
              if (live === undefined) {
                return yield* stale(scopeId);
              }
              const subscription = yield* PubSub.subscribe(live.changes);
              const subscribed: DeckChanged = { scopeId, paths: [] };
              return Stream.concat(Stream.make(subscribed), Stream.fromSubscription(subscription));
            })
          );

        yield* Effect.addFinalizer(() => (current === undefined ? Effect.void : closeLive(current)));

        return DeckScopes.of({
          state: SubscriptionRef.changes(state),
          open,
          close,
          admit,
          changes,
        });
      })
    );
}

const newScopeId = Effect.sync(() => ScopeId.make(randomUUID()));

/**
 * A listener on a free 127.0.0.1 port, the deck's own origin, until the scope closes. The release
 * drops its open connections, the HMR socket among them, so the close does not wait on the page.
 */
const loopbackListener = Effect.acquireRelease(
  Effect.callback<HttpServer, PreviewListenFailed>((resume) => {
    const listener = createServer();
    listener.once("error", (error) => {
      resume(
        Effect.fail(
          new PreviewListenFailed({ message: `The deck's listener did not start: ${error.message}` })
        )
      );
    });
    listener.listen(0, "127.0.0.1", () => {
      resume(Effect.succeed(listener));
    });
  }),
  (listener) =>
    Effect.callback<void>((resume) => {
      listener.closeAllConnections();
      listener.close(() => {
        resume(Effect.void);
      });
    })
);

/**
 * Whether a watched path is the deck's own: not a hidden file or directory, not under
 * `node_modules`, and not a temporary file an atomic write renames away.
 */
function isReportedPath(relative: string): boolean {
  const segments = relative.split("/");
  return (
    !relative.startsWith("..") &&
    !relative.endsWith(".tmp") &&
    segments.every((segment) => segment !== "node_modules" && !segment.startsWith("."))
  );
}
