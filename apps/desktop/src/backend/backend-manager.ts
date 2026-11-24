/**
 * Runs the studio's backend process and keeps it running. Ported from the spawn, readiness,
 * restart-backoff and stop parts of t3code's `DesktopBackendManager` (pingdotgg/t3code
 * `apps/desktop/src/backend/DesktopBackendManager.ts` at 2fe7febc, MIT licence, Copyright (c) 2026
 * T3 Tools Inc.; see THIRD_PARTY_NOTICES.md), without its WSL, telemetry, pool and recovery parts.
 *
 * Each run gets a fresh launch document on stdin, which the manager keeps open for the life of the
 * run: the backend exits when the pipe closes, so a crashed main leaves none behind. The backend
 * announces that it listens with one JSON document on stdout, `{"_tag":"StudioReady","url"}`, in
 * place of t3code's HTTP readiness poll. The run is ready once the manager has traded the run's
 * bootstrap credential for the session bearer (after t3code's `DesktopLocalEnvironmentAuth`).
 * The credential works once, and a request whose answer is lost may have spent it, so a failed
 * exchange is never tried again: it ends the run, and the next run gets a fresh credential.
 *
 * A backend that exits, prints no readiness document in time or hands over no bearer starts again
 * after a delay that doubles from `initialRestartDelay` up to `maxRestartDelay`, and drops back to
 * the start once a run was ready. Closing the layer's scope stops the backend with SIGTERM, then
 * SIGKILL after `terminateGrace`.
 */

import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  BACKEND_STOP_DEADLINE,
  SESSION_PATH,
  SessionResponse,
  StudioReady,
} from "@elmeragroup/fuse-deck-studio/contract/studio-launch";

import type { BackendLaunch, BackendStatus } from "./backend-status.ts";

/** The process to run. The composition root builds it, environment included. */
export type BackendCommand = {
  /** The executable, `process.execPath` in the packaged app. */
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** The child's whole environment; nothing is inherited past it. */
  readonly env: Readonly<Record<string, string>>;
  /** The launch document for one run, made fresh for each: the first line of the run's stdin. */
  readonly launch: Effect.Effect<BackendLaunch>;
};

/** How long the bearer exchange with a run that just printed its readiness document may take. */
const EXCHANGE_TIMEOUT = Duration.seconds(10);

/** Main could not trade a run's bootstrap credential for its bearer. */
export class BearerExchangeFailed extends Schema.TaggedError<BearerExchangeFailed>()("BearerExchangeFailed", {
  message: Schema.String,
}) {}

/** How long each phase may take. Tests shorten them. */
export type BackendTiming = {
  /** How long a run may take to print its readiness document. The bearer exchange follows. */
  readonly readinessTimeout: Duration.Duration;
  /** How long SIGTERM has before SIGKILL. */
  readonly terminateGrace: Duration.Duration;
  readonly initialRestartDelay: Duration.Duration;
  readonly maxRestartDelay: Duration.Duration;
};

/**
 * t3code's restart delays; the readiness wait covers a deck's first optimizer run. SIGKILL waits
 * five seconds past the backend's own stop deadline, so a stop that drains an open deck's calls
 * finishes first.
 */
export const DEFAULT_BACKEND_TIMING: BackendTiming = {
  readinessTimeout: Duration.seconds(90),
  terminateGrace: Duration.sum(BACKEND_STOP_DEADLINE, Duration.seconds(5)),
  initialRestartDelay: Duration.millis(500),
  maxRestartDelay: Duration.seconds(10),
};

/** Supervises the backend process for the life of its layer. */
export class BackendManager extends Context.Service<
  BackendManager,
  {
    /** The backend's status, current and as it changes. */
    readonly status: SubscriptionRef.SubscriptionRef<BackendStatus>;
  }
>()("@elmeragroup/fuse-deck-studio/backend/BackendManager") {
  /**
   * Start supervising `command` now, and stop the backend when the layer's scope closes.
   *
   * @param command - The backend process.
   * @param timing - Readiness, stop and restart durations.
   */
  static readonly layer = (command: BackendCommand, timing: BackendTiming) =>
    Layer.effect(
      BackendManager,
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<BackendStatus>({ _tag: "Starting", attempt: 0 });
        yield* supervise(command, timing, status).pipe(Effect.forkScoped);
        return BackendManager.of({ status });
      })
    );
}

/** The backend's readiness document, the one line of stdout this manager reads. */
const decodeReady = Schema.decodeUnknownOption(Schema.fromJsonString(StudioReady));

/**
 * Trade `bootstrap` for the session bearer of the backend at `url`, once, with no Origin.
 *
 * @returns The bearer, or why the run gave none.
 */
const exchangeBootstrap = Effect.fn("BackendManager.exchangeBootstrap")(function* (
  url: string,
  bootstrap: Redacted.Redacted<string>
) {
  const http = yield* HttpClient.HttpClient;
  return yield* http
    .execute(
      HttpClientRequest.post(new URL(SESSION_PATH, url).href).pipe(
        HttpClientRequest.bodyJsonUnsafe({ bootstrap: Redacted.value(bootstrap) })
      )
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionResponse)),
      Effect.map(({ bearer }) => Redacted.make(bearer)),
      Effect.timeout(EXCHANGE_TIMEOUT),
      Effect.mapError(
        (error) =>
          new BearerExchangeFailed({ message: `the backend at ${url} gave no bearer: ${error.message}` })
      )
    );
});

/** Run the backend, again and again, until interrupted. */
const supervise = Effect.fn("BackendManager.supervise")(function* (
  command: BackendCommand,
  timing: BackendTiming,
  status: SubscriptionRef.SubscriptionRef<BackendStatus>
) {
  let attempt = 0;
  while (true) {
    yield* SubscriptionRef.set(status, { _tag: "Starting", attempt });
    const end = yield* runOnce(command, timing, status);
    // As in t3code, a run that became ready resets the backoff.
    const failed = end.wasReady ? 0 : attempt;
    const delay = restartDelay(timing, failed);
    attempt = end.wasReady ? 0 : attempt + 1;
    yield* Console.error(`[backend] ${end.reason}; restarting in ${Duration.format(delay)}`);
    yield* SubscriptionRef.set(status, {
      _tag: "Restarting",
      reason: end.reason,
      attempt,
      delayMillis: Duration.toMillis(delay),
    });
    yield* Effect.sleep(delay);
  }
});

/** t3code's backoff: the initial delay, doubled for each run in a row that never became ready, capped. */
function restartDelay(timing: BackendTiming, attempt: number): Duration.Duration {
  return Duration.min(Duration.times(timing.initialRestartDelay, 2 ** attempt), timing.maxRestartDelay);
}

/**
 * One run: spawn, wait for the readiness document, then wait for the exit. Interrupting it stops
 * the process and logs how it exited.
 */
const runOnce = Effect.fn("BackendManager.runOnce")(function* (
  command: BackendCommand,
  timing: BackendTiming,
  status: SubscriptionRef.SubscriptionRef<BackendStatus>
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const launch = yield* command.launch;
      const spawned = yield* Effect.result(
        spawner.spawn(
          ChildProcess.make(command.executable, [...command.args], {
            cwd: command.cwd,
            env: command.env,
            // The launch document, then nothing: the pipe stays open until the run's scope closes.
            stdin: { stream: Stream.make(new TextEncoder().encode(`${launch.stdin}\n`)), endOnDone: false },
            killSignal: "SIGTERM",
            forceKillAfter: timing.terminateGrace,
          })
        )
      );
      if (Result.isFailure(spawned)) {
        return { reason: `the backend did not spawn: ${spawned.failure.message}`, wasReady: false };
      }
      const handle = spawned.success;
      yield* Console.error(`[backend] started pid ${String(handle.pid)} in ${command.cwd}`);
      // Runs before the spawner's own release, so the exit it logs is the one the stop caused.
      yield* Effect.addFinalizer(() => stop(handle, timing));
      // Both pipes drain for the whole run, so a full pipe never stalls the backend. Only stdout
      // carries the readiness document; stderr has Vite's logs and Electron's own messages.
      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Console.error(`[backend] ${line}`)),
        Effect.ignore,
        Effect.forkScoped
      );
      const readyUrl = yield* Deferred.make<string>();
      yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Option.match(decodeReady(line), {
            onNone: () => Effect.void,
            onSome: ({ url }) => Deferred.succeed(readyUrl, url),
          })
        ),
        Effect.ignore,
        Effect.forkScoped
      );
      const outcome = yield* Effect.raceFirst(
        Effect.map(Deferred.await(readyUrl), (url) => ({ _tag: "Ready" as const, url })),
        Effect.map(Effect.result(handle.exitCode), (exit) => ({ _tag: "Exited" as const, exit }))
      ).pipe(Effect.timeoutOption(timing.readinessTimeout));
      if (Option.isNone(outcome)) {
        return {
          reason: `the backend printed no readiness document within ${Duration.format(timing.readinessTimeout)}`,
          wasReady: false,
        };
      }
      if (outcome.value._tag === "Exited") {
        return { reason: `${exitReason(outcome.value.exit)} before it was ready`, wasReady: false };
      }
      const { url } = outcome.value;
      const bearer = yield* Effect.result(exchangeBootstrap(url, launch.bootstrap));
      if (Result.isFailure(bearer)) {
        return { reason: bearer.failure.message, wasReady: false };
      }
      yield* SubscriptionRef.set(status, { _tag: "Ready", url, bearer: bearer.success });
      return { reason: exitReason(yield* Effect.result(handle.exitCode)), wasReady: true };
    })
  );
});

/** How a run's exit reads in the log and the status. */
function exitReason(exit: Result.Result<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>): string {
  return Result.isSuccess(exit)
    ? `the backend exited with code ${String(exit.success)}`
    : `the backend ended: ${exit.failure.message}`;
}

/** Stop a running backend: SIGTERM to its process group, SIGKILL after the grace. */
const stop = Effect.fn("BackendManager.stop")(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
  timing: BackendTiming
) {
  if (!(yield* Effect.orElseSucceed(handle.isRunning, () => false))) {
    return;
  }
  yield* Effect.ignore(handle.kill({ killSignal: "SIGTERM", forceKillAfter: timing.terminateGrace }));
  const exited = yield* Effect.result(handle.exitCode);
  yield* Console.error(`[backend] stopped pid ${String(handle.pid)}: ${exitReason(exited)}`);
});
