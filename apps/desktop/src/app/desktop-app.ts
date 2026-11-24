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
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import { LeaveIntent, PickedDeck } from "@elmeragroup/fuse-deck-studio/contract/desktop-bridge";
import { BackendConnection } from "@elmeragroup/fuse-deck-studio/contract/studio-launch";

import { BackendAuth } from "../backend/backend-auth.ts";
import { openDeckUrl } from "../backend/backend-deck.ts";
import type { OpenDeckUnknown } from "../backend/backend-deck.ts";
import { BackendManager } from "../backend/backend-manager.ts";
import type { BackendCommand, BackendTiming } from "../backend/backend-manager.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  BACKEND_CONNECTION_CHANNEL,
  INITIAL_DECK_CHANNEL,
  LEAVE_CHANNEL,
  PICK_DECK_CHANNEL,
  PRESENT_CHANNEL,
  UNSAVED_DRAFT_CHANNEL,
} from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { DesktopWindow } from "../window/desktop-window.ts";
import { presentableUrl } from "../window/present-url.ts";
import type { RendererSource } from "./desktop-config.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";

/** What the program starts. */
export type DesktopAppInput = {
  readonly renderer: RendererSource;
  readonly backend: BackendCommand;
  readonly backendTiming: BackendTiming;
  /** A deck the renderer opens at start. */
  readonly initialDeck: Option.Option<string>;
};

/** The renderer asked to present an address that is not a page of the deck the backend has open. */
class PresentRefused extends Schema.TaggedError<PresentRefused>()("PresentRefused", {
  url: Schema.String,
}) {}

/** Ask the user for a deck directory with the system dialog, over the main window when there is one. */
const pickDeck = Effect.fn("desktop.pickDeck")(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const parent = yield* electronWindow.main;
  const options: Electron.OpenDialogOptions = {
    title: "Open deck",
    buttonLabel: "Open deck",
    properties: ["openDirectory"],
  };
  const picked = yield* Effect.promise(() =>
    Option.match(parent, {
      onNone: () => Electron.dialog.showOpenDialog(options),
      onSome: (window) => Electron.dialog.showOpenDialog(window, options),
    })
  );
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
});

/**
 * Run the shell until it quits.
 *
 * @param input - Where the renderer comes from and the backend to run.
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
  const isDevelopment = input.renderer._tag === "DevServer";
  const scheme = ElectronProtocol.getDesktopScheme(isDevelopment);
  yield* protocol.registerDesktopProtocol(
    input.renderer._tag === "DevServer"
      ? { scheme, targetOrigin: input.renderer.url }
      : { scheme, assetDirectory: input.renderer.directory }
  );

  const backend = yield* Layer.build(
    BackendAuth.layer.pipe(
      Layer.provideMerge(BackendManager.layer(input.backend, input.backendTiming)),
      Layer.provide(FetchHttpClient.layer)
    )
  );
  const auth = Context.get(backend, BackendAuth);

  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: BACKEND_CONNECTION_CHANNEL,
      payload: Schema.Undefined,
      result: BackendConnection,
      handler: () => auth.connection,
    })
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: PICK_DECK_CHANNEL,
      payload: Schema.Undefined,
      result: PickedDeck,
      handler: pickDeck,
    })
  );
  // The deck to open at start goes to the first page that asks. A reloaded page finds the deck
  // the backend has open; asking for the start deck again would reopen it, since its path may
  // differ from the backend's real path, and a reopen ends the deck's agent session.
  let initialDeck = input.initialDeck;
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: INITIAL_DECK_CHANNEL,
      payload: Schema.Undefined,
      result: PickedDeck,
      handler: () =>
        Effect.sync(() => {
          const deck = Option.getOrNull(initialDeck);
          initialDeck = Option.none();
          return deck;
        }),
    })
  );

  const desktopWindow = yield* DesktopWindow;
  // Main asks the backend which deck is open; the renderer's word for it is never taken.
  const present = Effect.fn("desktop.present")(function* (url: string) {
    const openDeck = yield* openDeckUrl().pipe(
      Effect.provideService(BackendAuth, auth),
      Effect.provide(FetchHttpClient.layer)
    );
    return yield* Option.match(presentableUrl(url, openDeck), {
      onNone: (): Effect.Effect<
        void,
        PresentRefused | OpenDeckUnknown | ElectronWindow.ElectronWindowCreateError
      > => Effect.fail(new PresentRefused({ url })),
      onSome: desktopWindow.present,
    });
  });
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: PRESENT_CHANNEL,
      payload: Schema.String,
      result: Schema.Undefined,
      // Only a page of the open deck opens; anything else the renderer sends is refused.
      handler: present,
    })
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: UNSAVED_DRAFT_CHANNEL,
      payload: Schema.Boolean,
      result: Schema.Undefined,
      handler: desktopWindow.recordUnsavedDraft,
    })
  );
  // The page settled its draft after main held back a quit or a window close: go on.
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: LEAVE_CHANNEL,
      payload: LeaveIntent,
      result: Schema.Undefined,
      handler: (intent) =>
        desktopWindow.leave(intent).pipe(Effect.andThen(intent === "quit" ? electronApp.quit : Effect.void)),
    })
  );
  yield* desktopWindow.open;
  yield* shutdown.awaitRequest;
}, Effect.scoped);
