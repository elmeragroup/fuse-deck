// Derived from pingdotgg/t3code apps/desktop/src/app/DesktopLifecycle.ts at 2fe7febc.
// MIT licence, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// Changes: drops relaunch, the theme and updater hooks, the window-bounds flush and the Linux
// child and AppImage cleanup; logs through Effect's logger in place of DesktopObservability; a quit
// while the page reports an unsaved draft first asks the page, which quits again once it is settled;
// a signal quits without asking.

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import { DEFAULT_BACKEND_TIMING } from "../backend/backend-manager.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopState from "./DesktopState.ts";
import { DesktopWindow } from "../window/desktop-window.ts";

export type DesktopLifecycleRuntimeServices =
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow
  | ElectronApp.ElectronApp;

type DesktopLifecycleRegistrationServices =
  | DesktopLifecycleRuntimeServices
  | ElectronWindow.ElectronWindow;

/**
 * @effect-expect-leaking DesktopShutdown | DesktopState | DesktopWindow | ElectronApp | ElectronWindow
 */
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly register: Effect.Effect<
      void,
      never,
      Scope.Scope | DesktopLifecycleRegistrationServices
    >;
  }
>()("@elmeragroup/fuse-deck-studio/app/DesktopLifecycle") {}

const logLifecycleInfo = (message: string, attributes: Record<string, unknown> = {}) =>
  Effect.logInfo(message).pipe(Effect.annotateLogs({ component: "desktop-lifecycle", ...attributes }));
const logLifecycleError = (message: string, attributes: Record<string, unknown> = {}) =>
  Effect.logError(message).pipe(Effect.annotateLogs({ component: "desktop-lifecycle", ...attributes }));

function addScopedListener<Args extends ReadonlyArray<unknown>>(
  target: unknown,
  eventName: string,
  listener: (...args: Args) => void,
  options: { readonly prepend?: boolean } = {},
): Effect.Effect<void, never, Scope.Scope> {
  const eventTarget = target as {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    prependListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
  };
  const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
  return Effect.acquireRelease(
    Effect.sync(() => {
      if (options.prepend) eventTarget.prependListener(eventName, untypedListener);
      else eventTarget.on(eventName, untypedListener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(eventName, untypedListener);
      }),
  ).pipe(Effect.asVoid);
}

const requestDesktopShutdownAndWait = Effect.fn("desktop.lifecycle.requestShutdownAndWait")(
  function* (
    beforeRequest: Effect.Effect<void> = Effect.void,
  ): Effect.fn.Return<void, never, DesktopShutdown.DesktopShutdown> {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    yield* beforeRequest;
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  },
);

interface QuitState {
  phase: "running" | "waiting" | "allowed";
  waitingSinceNanos: bigint;
}

// Longer than a backend's stop budget (SIGTERM, the grace before SIGKILL, then
// a few seconds for the kill), so a double Cmd-Q at the start of a normal quit
// cannot cut the backend stop short and orphan it.
const SHUTDOWN_STALL_THRESHOLD = Duration.sum(DEFAULT_BACKEND_TIMING.terminateGrace, Duration.seconds(5));

const startWaitingForShutdown = Effect.fn("desktop.lifecycle.startWaitingForShutdown")(function* (
  quit: QuitState,
) {
  quit.phase = "waiting";
  quit.waitingSinceNanos = yield* Clock.monotonicTimeNanos;
});

// While a quit waits on shutdown, `quitting` makes activation open nothing. If
// that shutdown stalls, a repeated Quit or SIGTERM is the user's only way out
// short of SIGKILL.
const exitIfShutdownStalled = Effect.fn("desktop.lifecycle.exitIfShutdownStalled")(function* (
  quit: QuitState,
  source: string,
) {
  const pendingMs = Number(
    ((yield* Clock.monotonicTimeNanos) - quit.waitingSinceNanos) / 1_000_000n,
  );
  if (pendingMs < Duration.toMillis(SHUTDOWN_STALL_THRESHOLD)) {
    yield* logLifecycleInfo("quit already in progress", { source, pendingMs });
    return;
  }
  yield* logLifecycleError("desktop shutdown stalled; exiting without it", { source, pendingMs });
  const electronApp = yield* ElectronApp.ElectronApp;
  yield* electronApp.exit(0);
});

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
  quit: QuitState,
): void {
  if (quit.phase === "allowed") {
    void runEffect(
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);
        yield* logLifecycleInfo("before-quit received");
      }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
    );
    return;
  }

  event.preventDefault();
  if (quit.phase === "waiting") {
    void runEffect(exitIfShutdownStalled(quit, "before-quit"));
    return;
  }
  // A page with an unsaved draft asks the user first; the quit stays "running" until the page
  // answers through the leave channel, which quits again. A cancelled quit leaves nothing behind.
  void runEffect(
    Effect.gen(function* () {
      const desktopWindow = yield* DesktopWindow;
      return yield* desktopWindow.askToLeave("quit");
    }),
  ).then((asked) => {
    if (!asked) {
      shutDownAndQuit(runEffect, quit);
    }
  });
}

function shutDownAndQuit(
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
  quit: QuitState,
): void {
  // A second before-quit while the page was asked may have started the shutdown already.
  if (quit.phase !== "running") {
    return;
  }
  void runEffect(
    Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* (yield* DesktopWindow).releaseForQuit;
      yield* startWaitingForShutdown(quit);
      yield* Ref.set(state.quitting, true);
      yield* logLifecycleInfo("before-quit received");
      yield* requestDesktopShutdownAndWait(
        electronWindow.destroyAll.pipe(
          Effect.catchCause((cause) =>
            logLifecycleError("failed to destroy windows before shutdown", { cause }),
          ),
        ),
      );
    }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
  ).finally(() => {
    quit.phase = "allowed";
    void runEffect(
      Effect.gen(function* () {
        const electronApp = yield* ElectronApp.ElectronApp;
        yield* electronApp.quit;
      }).pipe(Effect.withSpan("desktop.lifecycle.quitAfterShutdown")),
    );
  });
}

function quitFromSignal(
  signal: "SIGINT" | "SIGTERM",
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
  quit: QuitState,
): void {
  if (quit.phase === "waiting") {
    void runEffect(exitIfShutdownStalled(quit, signal));
    return;
  }
  void runEffect(
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ signal });
      const electronApp = yield* ElectronApp.ElectronApp;
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      // A signal never asks about a draft, so Electron's close of the windows must go through.
      yield* (yield* DesktopWindow).releaseForQuit;
      yield* startWaitingForShutdown(quit);
      yield* logLifecycleInfo("process signal received", { signal });
      yield* requestDesktopShutdownAndWait();
      quit.phase = "allowed";
      yield* electronApp.quit;
    }).pipe(Effect.withSpan("desktop.lifecycle.processSignal")),
  );
}

/** @public */
export const make = DesktopLifecycle.of({
  register: Effect.gen(function* () {
    const desktopWindow = yield* DesktopWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const platform = process.platform;
    const context = yield* Effect.context<DesktopLifecycleRegistrationServices>();
    const runEffect = Effect.runPromiseWith(context);
    const quit: QuitState = { phase: "running", waitingSinceNanos: 0n };
    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      handleBeforeQuit(event, runEffect, quit);
    });
    yield* electronApp.on("activate", () => {
      void runEffect(
        Effect.gen(function* () {
          const state = yield* DesktopState.DesktopState;
          if (yield* Ref.get(state.quitting)) return;
          yield* desktopWindow.activate;
        }).pipe(Effect.withSpan("desktop.lifecycle.activate")),
      );
    });
    yield* electronApp.on("window-all-closed", () => {
      void runEffect(
        Effect.gen(function* () {
          const app = yield* ElectronApp.ElectronApp;
          const state = yield* DesktopState.DesktopState;
          if (platform !== "darwin" && !(yield* Ref.get(state.quitting))) {
            yield* app.quit;
          }
        }).pipe(Effect.withSpan("desktop.lifecycle.windowAllClosed")),
      );
    });

    // Electron can exit without before-quit, e.g. when the X11/Wayland connection drops.
    // Prepended so the record is buffered before the trace sink's own exit flush runs.
    yield* addScopedListener(
      process,
      "exit",
      (exitCode: number) => {
        Effect.runSyncWith(context)(
          Effect.gen(function* () {
            const shutdown = yield* DesktopShutdown.DesktopShutdown;
            if (quit.phase === "allowed" || (yield* shutdown.isComplete)) return;
            const attributes = { exitCode, quitPhase: quit.phase };
            yield* logLifecycleError(
              "desktop main process exiting before shutdown completed",
              attributes,
            ).pipe(Effect.withSpan("desktop.lifecycle.exit", { attributes }));
          }),
        );
      },
      { prepend: true },
    );

    if (platform !== "win32") {
      yield* addScopedListener(process, "SIGINT", () => {
        quitFromSignal("SIGINT", runEffect, quit);
      });
      yield* addScopedListener(process, "SIGTERM", () => {
        quitFromSignal("SIGTERM", runEffect, quit);
      });
    }
  }).pipe(Effect.withSpan("desktop.lifecycle.register")),
});

export const layer = Layer.succeed(DesktopLifecycle, make);
