/**
 * The studio backend's entry. Electron main runs it on its own executable with
 * `ELECTRON_RUN_AS_NODE=1` and writes the launch document to its stdin. Logs go to stderr, so
 * stdout carries only `StudioReady`.
 */

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import path from "node:path";

import { runStudioServer } from "./studio-server.ts";

// The build puts this file in dist/server and the deck runtime in dist/runtime.
const runtimeRoot = path.join(import.meta.dirname, "..", "runtime");

runStudioServer(runtimeRoot, {
  pathVariable: process.env.PATH ?? "/usr/bin:/bin",
  shell: process.env.SHELL ?? "/bin/zsh",
  // The agent's adapter runs on this Node, which is Electron's in the desktop app.
  node: { executable: process.execPath, electron: process.versions.electron !== undefined },
}).pipe(
  Effect.provideService(References.LogToStderr, true),
  Effect.provide(NodeServices.layer),
  // A normal stop exits the process too. Vite 8.3 can leave its watcher running after its
  // close times out (see deck-core's bundler), and a backend whose parent is gone must not linger.
  NodeRuntime.runMain({
    teardown: (exit, onExit) => {
      Runtime.defaultTeardown(exit, (code) => {
        onExit(code);
        process.exit(code);
      });
    },
  })
);
