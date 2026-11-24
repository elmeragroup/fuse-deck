import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import path from "node:path";

import { BackendManager } from "../src/backend/backend-manager.ts";
import type { BackendStatus } from "../src/backend/backend-status.ts";

const FAKE_BACKEND = path.join(import.meta.dirname, "fixtures", "fake-backend.mjs");

/** Short enough for a test, long enough that a stopped process has time to exit by itself. */
const TIMING = {
  readinessTimeout: Duration.seconds(20),
  terminateGrace: Duration.millis(500),
  initialRestartDelay: Duration.millis(10),
  maxRestartDelay: Duration.millis(40),
};

type Mode = "ready" | "stubborn" | "fail-twice" | "exit-after-ready";

/**
 * Start a manager over the fake backend in `mode`, in a scope the test closes.
 *
 * @returns The manager's status, the scope that owns the manager, and the directory where the fake
 *   records its pids.
 */
const startManager = Effect.fn("startManager")(function* (mode: Mode) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* fs.makeTempDirectoryScoped({ prefix: "fuse-deck-studio-backend-" });
  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(
    BackendManager.layer(
      { executable: process.execPath, args: [FAKE_BACKEND, mode, state], cwd: state, env: {} },
      TIMING
    ),
    scope
  );
  return { status: Context.get(context, BackendManager).status, scope, state };
});

/** Wait for the manager to report Ready, and return the address it reported. */
const readyUrl = Effect.fn("readyUrl")(function* (status: SubscriptionRef.SubscriptionRef<BackendStatus>) {
  const ready = yield* SubscriptionRef.changes(status).pipe(
    Stream.filter((current) => current._tag === "Ready"),
    Stream.runHead,
    Effect.timeout("20 seconds")
  );
  return Option.map(ready, (current) => current.url);
});

/** The pids the fake backend recorded, one per run. */
const runPids = Effect.fn("runPids")(function* (state: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path.join(state, "pids"));
  return text.split("\n").filter(Boolean).map(Number);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("BackendManager", () => {
  it.live("reports the address from the readiness document, past other stdout lines", () =>
    Effect.gen(function* () {
      const { status, scope } = yield* startManager("ready");
      const url = yield* readyUrl(status);
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(url, Option.some("http://127.0.0.1:4000/"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("stops the backend when its scope closes", () =>
    Effect.gen(function* () {
      const { status, scope, state } = yield* startManager("ready");
      yield* readyUrl(status);
      const [pid] = yield* runPids(state);
      assert.isDefined(pid);
      assert.isTrue(isAlive(pid));
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(isAlive(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("kills a backend that ignores SIGTERM once the grace has passed", () =>
    Effect.gen(function* () {
      const { status, scope, state } = yield* startManager("stubborn");
      yield* readyUrl(status);
      const [pid] = yield* runPids(state);
      assert.isDefined(pid);
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(isAlive(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("starts a backend again after runs that exit before they are ready", () =>
    Effect.gen(function* () {
      const { status, scope, state } = yield* startManager("fail-twice");
      const url = yield* readyUrl(status);
      const pids = yield* runPids(state);
      yield* Scope.close(scope, Exit.void);
      // The fake's third run is the first to print a readiness document, at port 4000 + 2.
      assert.deepStrictEqual(url, Option.some("http://127.0.0.1:4002/"));
      assert.strictEqual(pids.length, 3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("starts a backend again after a ready run exits, and reports the new address", () =>
    Effect.gen(function* () {
      const { status, scope } = yield* startManager("exit-after-ready");
      const second = yield* SubscriptionRef.changes(status).pipe(
        Stream.filter((current) => current._tag === "Ready" && current.url.endsWith(":4001/")),
        Stream.runHead,
        Effect.timeout("20 seconds")
      );
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Option.isSome(second));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
