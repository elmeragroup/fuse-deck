import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import path from "node:path";

import { BackendAuth } from "../src/backend/backend-auth.ts";
import { BackendManager } from "../src/backend/backend-manager.ts";

const FAKE_BACKEND = path.join(import.meta.dirname, "fixtures", "fake-backend.mjs");

/** Short enough for a test, long enough that a stopped process has time to exit by itself. */
const TIMING = {
  readinessTimeout: Duration.seconds(20),
  terminateGrace: Duration.millis(500),
  initialRestartDelay: Duration.millis(10),
  maxRestartDelay: Duration.millis(40),
};

type Mode = "ready" | "stubborn" | "fail-twice" | "exit-after-ready" | "drop-exchange";

/**
 * Start a manager over the fake backend in `mode`, in a scope the test closes, with main's view of
 * it: the connection the renderer asks for.
 *
 * @returns The connection, the scope that owns the manager, and the directory where the fake
 *   records its runs.
 */
const startManager = Effect.fn("startManager")(function* (mode: Mode) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* fs.makeTempDirectoryScoped({ prefix: "fuse-deck-studio-backend-" });
  const scope = yield* Scope.make();
  // A test that fails before it closes the scope still stops the fake: the test's own scope does.
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  let runs = 0;
  // The fake takes its launch document's line as the run's bootstrap credential.
  const launch = Effect.sync(() => {
    runs += 1;
    return { stdin: `launch-${String(runs)}`, bootstrap: Redacted.make(`launch-${String(runs)}`) };
  });
  const context = yield* Layer.buildWithScope(
    BackendAuth.layer.pipe(
      Layer.provideMerge(
        BackendManager.layer(
          { executable: process.execPath, args: [FAKE_BACKEND, mode, state], cwd: state, env: {}, launch },
          TIMING
        )
      ),
      Layer.provide(FetchHttpClient.layer)
    ),
    scope
  );
  return { connection: Context.get(context, BackendAuth).connection, scope, state };
});

/** The lines the fake wrote to `file` in its state directory, one per run. */
const lines = Effect.fn("lines")(function* (state: string, file: "pids" | "urls" | "launches") {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path.join(state, file));
  return text.split("\n").filter(Boolean);
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
      const { connection, scope, state } = yield* startManager("ready");
      const ready = yield* connection.pipe(Effect.timeout("20 seconds"));
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(ready, { url: (yield* lines(state, "urls"))[0], bearer: "bearer-0" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("stops the backend when its scope closes", () =>
    Effect.gen(function* () {
      const { connection, scope, state } = yield* startManager("ready");
      yield* connection.pipe(Effect.timeout("20 seconds"));
      const [pid] = (yield* lines(state, "pids")).map(Number);
      assert.isDefined(pid);
      assert.isTrue(isAlive(pid));
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(isAlive(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("kills a backend that ignores SIGTERM once the grace has passed", () =>
    Effect.gen(function* () {
      const { connection, scope, state } = yield* startManager("stubborn");
      yield* connection.pipe(Effect.timeout("20 seconds"));
      const [pid] = (yield* lines(state, "pids")).map(Number);
      assert.isDefined(pid);
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(isAlive(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("starts a backend again after runs that exit before they are ready", () =>
    Effect.gen(function* () {
      const { connection, scope, state } = yield* startManager("fail-twice");
      const ready = yield* connection.pipe(Effect.timeout("20 seconds"));
      const pids = yield* lines(state, "pids");
      yield* Scope.close(scope, Exit.void);
      // The fake's third run is the first to print a readiness document.
      assert.strictEqual(ready.bearer, "bearer-2");
      assert.strictEqual(pids.length, 3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("starts a backend again after a ready run exits, with its own launch document and bearer", () =>
    Effect.gen(function* () {
      const { connection, scope, state } = yield* startManager("exit-after-ready");
      // The first run exits once it handed over its bearer; the connection then follows the next.
      const second = yield* connection.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("50 millis"),
          until: (ready) => ready.bearer === "bearer-1",
        }),
        Effect.timeout("20 seconds")
      );
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(yield* lines(state, "launches"), ["launch-1", "launch-2"]);
      assert.deepStrictEqual(second, { url: (yield* lines(state, "urls"))[1], bearer: "bearer-1" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("starts a fresh run when the bearer exchange's answer is lost", () =>
    Effect.gen(function* () {
      const { connection, scope, state } = yield* startManager("drop-exchange");
      const ready = yield* connection.pipe(Effect.timeout("20 seconds"));
      const pids = (yield* lines(state, "pids")).map(Number);
      yield* Scope.close(scope, Exit.void);
      // The first run spent its credential, so only a second run, with a fresh one, has a bearer.
      assert.deepStrictEqual(ready, { url: (yield* lines(state, "urls"))[1], bearer: "bearer-1" });
      assert.deepStrictEqual(yield* lines(state, "launches"), ["launch-1", "launch-2"]);
      assert.isFalse(pids.some(isAlive));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
