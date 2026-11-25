/**
 * The shell's startup and shutdown, after t3code's `DesktopApp.program` (pingdotgg/t3code
 * `apps/desktop/src/app/DesktopApp.ts` at 2fe7febc, MIT licence, Copyright (c) 2026 T3 Tools Inc.;
 * see THIRD_PARTY_NOTICES.md).
 *
 * The program holds one scope from startup to quit. Quitting requests shutdown; the program then
 * closes its scope, which stops the backend first, and marks shutdown complete last, so the
 * lifecycle's quit waits for the backend to exit.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { BackendManager } from "../backend/backend-manager.ts";
import type { BackendCommand, BackendTiming } from "../backend/backend-manager.ts";
import { BackendStatus } from "../backend/backend-status.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { BACKEND_STATUS_CHANGED_CHANNEL, BACKEND_STATUS_CHANNEL } from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { DesktopWindow } from "../window/desktop-window.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";

/** What the program starts. */
export type DesktopAppInput = {
  /** The stub page's files. */
  readonly rendererDirectory: string;
  readonly backend: BackendCommand;
  readonly backendTiming: BackendTiming;
};

const encodeStatus = Schema.encodeEffect(BackendStatus);

/**
 * Run the shell until it quits.
 *
 * @param input - The page to serve and the backend to run.
 */
export const program = Effect.fn("desktop.app")(function* (input: DesktopAppInput) {
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  // Added first, so it runs last: after the backend has stopped.
  yield* Effect.addFinalizer(() => shutdown.markComplete);

  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  yield* lifecycle.register;
  const electronApp = yield* ElectronApp.ElectronApp;
  yield* electronApp.whenReady;

  const protocol = yield* ElectronProtocol.ElectronProtocol;
  yield* protocol.registerDesktopProtocol({
    scheme: ElectronProtocol.getDesktopScheme(false),
    assetDirectory: input.rendererDirectory,
  });

  const backend = yield* Layer.build(BackendManager.layer(input.backend, input.backendTiming));
  const { status } = Context.get(backend, BackendManager);

  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: BACKEND_STATUS_CHANNEL,
      payload: Schema.Undefined,
      result: BackendStatus,
      handler: () => SubscriptionRef.get(status),
    })
  );
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  yield* SubscriptionRef.changes(status).pipe(
    Stream.runForEach((current) =>
      Effect.flatMap(encodeStatus(current), (encoded) =>
        electronWindow.sendAll(BACKEND_STATUS_CHANGED_CHANNEL, encoded)
      )
    ),
    Effect.ignore,
    Effect.forkScoped
  );

  const desktopWindow = yield* DesktopWindow;
  yield* desktopWindow.open;
  yield* shutdown.awaitRequest;
}, Effect.scoped);
