/**
 * The Electron main process: the composition root. It parses the configuration, wires the
 * Electron services, the window and the lifecycle into one layer, and runs the program. The layer
 * graph follows t3code's `apps/desktop/src/main.ts` (pingdotgg/t3code at 2fe7febc, MIT licence,
 * Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md), cut to the services the studio uses.
 */

import { handleStdioError } from "./app/stdioErrors.ts";

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", handleStdioError);
}

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import { randomBytes } from "node:crypto";

import { StudioLaunch } from "@elmeragroup/fuse-deck-studio/contract/studio-launch";

import { program } from "./app/desktop-app.ts";
import { DECK_VARIABLE, parseDesktopConfig, RENDERER_DEV_URL_VARIABLE } from "./app/desktop-config.ts";
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopShutdown from "./app/DesktopShutdown.ts";
import * as DesktopState from "./app/DesktopState.ts";
import { DEFAULT_BACKEND_TIMING } from "./backend/backend-manager.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import { DesktopWindow } from "./window/desktop-window.ts";

// The app scheme's privileges must be registered before Electron emits ready, so this runs at
// import time rather than inside the program.
Effect.runSync(Layer.build(ElectronProtocol.layerSchemePrivileges).pipe(Effect.scoped));

const parsed = parseDesktopConfig({
  appPath: Electron.app.getAppPath(),
  resourcesPath: process.resourcesPath,
  isPackaged: Electron.app.isPackaged,
  cwd: process.cwd(),
  deck: process.env[DECK_VARIABLE],
  rendererDevUrl: process.env[RENDERER_DEV_URL_VARIABLE],
});

const encodeLaunch = Schema.encodeSync(Schema.fromJsonString(StudioLaunch));

if (Result.isFailure(parsed)) {
  process.stderr.write(`${parsed.failure.message}\n`);
  Electron.dialog.showErrorBox("fuse-deck studio cannot start", parsed.failure.message);
  Electron.app.exit(1);
} else {
  const config = parsed.success;
  const isDevelopment = config.renderer._tag === "DevServer";
  const userDataDirectory = Electron.app.getPath("userData");

  const layerElectron = Layer.mergeAll(
    ElectronApp.layer,
    ElectronProtocol.layer,
    ElectronShell.layer,
    ElectronWindow.layer,
    DesktopIpc.layer(Electron.ipcMain).pipe(Layer.provide(ElectronWindow.layer))
  );

  const layerDesktop = Layer.mergeAll(
    DesktopLifecycle.layer,
    DesktopShutdown.layer,
    DesktopState.layer,
    DesktopWindow.layer({
      applicationUrl: ElectronProtocol.getDesktopUrl(isDevelopment),
      preloadPath: config.preloadPath,
      title: "fuse-deck studio",
    })
  ).pipe(Layer.provideMerge(layerElectron), Layer.provideMerge(NodeServices.layer));

  program({
    renderer: config.renderer,
    initialDeck: config.initialDeck,
    backend: {
      // The backend runs on Electron's own Node: the app ships no second runtime.
      executable: process.execPath,
      args: [config.backendEntry],
      cwd: config.backendDirectory,
      env: { ...stringEnvironment(process.env), ELECTRON_RUN_AS_NODE: "1" },
      // A fresh bootstrap credential for each run, on stdin, never on argv or in the environment.
      launch: Effect.sync(() => {
        const bootstrap = randomBytes(32).toString("base64url");
        return {
          stdin: encodeLaunch({
            bootstrap,
            origin: ElectronProtocol.getDesktopOrigin(isDevelopment),
            userDataDirectory,
          }),
          bootstrap: Redacted.make(bootstrap),
        };
      }),
    },
    backendTiming: DEFAULT_BACKEND_TIMING,
  }).pipe(Effect.provide(layerDesktop), NodeRuntime.runMain);
}

/** The environment's set variables, for a child that inherits them. */
function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]]))
  );
}
