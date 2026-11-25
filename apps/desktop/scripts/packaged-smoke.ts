/**
 * The packaged smoke test: S0's proof that the packaged app runs with no checkout and a bare PATH.
 *
 * It copies the packaged app and the fixture deck (one slide that imports
 * `@elmeragroup/fuse/button`) into a fresh temporary directory, so no workspace sits on any path the
 * app sees. It launches the copied app's executable through Playwright's Electron driver, with
 * `PATH=/usr/bin:/bin`, that directory as the working directory and its own user data directory.
 * It checks that the backend runs on the app's own executable, that the window frames the deck
 * from 127.0.0.1 under the page's Content-Security-Policy, and that the frame renders the slide and
 * its Fuse Button. Then it quits the app
 * as a user does, through `app.quit()`, and checks that the app exited 0 and the backend is gone.
 *
 * Usage: node scripts/packaged-smoke.ts (after `package`)
 */

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import type { ElectronApplication } from "playwright";

/** One step of the smoke test failed. */
class SmokeFailed extends Schema.TaggedError<SmokeFailed>()("SmokeFailed", {
  message: Schema.String,
}) {}

const desktopRoot = path.resolve(import.meta.dirname, "..");
const PRODUCT_NAME = "fuse-deck studio";
const packagedApp = path.join(desktopRoot, ".artifacts", "release", "mac-arm64", `${PRODUCT_NAME}.app`);
const fixtureDeck = path.join(desktopRoot, "test", "fixtures", "deck");

/** The fixture deck's backend command line carries this path inside the copied app. */
const BACKEND_ENTRY = path.join("backend", "node_modules", "@elmeragroup", "fuse-deck", "dist", "bin.mjs");

/** Run a command to completion and return its stdout; a non-zero exit fails. */
const run = Effect.fn("run")(function* (command: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const label = `${command} ${args.join(" ")}`;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { stdin: "ignore" }));
      const [stdout, exitCode] = yield* Effect.all([text(handle.stdout), handle.exitCode], {
        concurrency: "unbounded",
      });
      return { stdout, exitCode };
    })
  ).pipe(Effect.mapError((error) => new SmokeFailed({ message: `${label}: ${error.message}` })));
});

function text<E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> {
  return stream.pipe(Stream.decodeText(), Stream.mkString);
}

/** The direct children of `pid` with their command lines. */
const childProcesses = Effect.fn("childProcesses")(function* (pid: number) {
  const { stdout } = yield* run("/bin/ps", ["-A", "-o", "pid=,ppid=,command="]);
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match !== null && Number(match[2]) === pid
      ? [{ pid: Number(match[1]), command: match[3] ?? "" }]
      : [];
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGKILL `pid`, unless it already exited. */
function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // It exited between the listing and the kill.
  }
}

/** How the app's main process ended. */
type AppExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

const smoke = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(packagedApp))) {
    return yield* new SmokeFailed({ message: `No ${packagedApp}. Run the package task first.` });
  }
  // realPath: macOS's temporary directory is a symlink, and the process table shows the real path.
  const sandbox = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "fuse-deck-studio-smoke-" })
  );
  const app = path.join(sandbox, `${PRODUCT_NAME}.app`);
  const deck = path.join(sandbox, "deck");
  const userData = path.join(sandbox, "user-data");
  // ditto keeps the bundle's symlinks and attributes, as Finder's copy does.
  const copied = yield* run("/usr/bin/ditto", [packagedApp, app]);
  if (copied.exitCode !== 0) {
    return yield* new SmokeFailed({ message: `ditto exited ${String(copied.exitCode)}.` });
  }
  yield* fs.copy(fixtureDeck, deck);
  const executable = path.join(app, "Contents", "MacOS", PRODUCT_NAME);
  yield* Console.log(`Launching ${executable}\n  deck ${deck}\n  PATH=/usr/bin:/bin, cwd ${sandbox}`);

  const { electronApp, main } = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const launched = await _electron.launch({
          executablePath: executable,
          args: [`--user-data-dir=${userData}`],
          cwd: sandbox,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: homedir(),
            TMPDIR: tmpdir(),
            FUSE_DECK_STUDIO_DECK: deck,
          },
          timeout: 60_000,
        });
        return { electronApp: launched, main: launched.process() };
      },
      catch: (cause) => new SmokeFailed({ message: `The app did not launch: ${String(cause)}` }),
    }),
    // Only when a step below failed before the app quit: kill the app and its backend, which runs
    // in its own process group and would outlive a killed app.
    ({ main: launched }) =>
      Effect.gen(function* () {
        if (launched.exitCode !== null || launched.signalCode !== null) {
          return;
        }
        const children = yield* childProcesses(launched.pid ?? -1).pipe(Effect.orElseSucceed(() => []));
        for (const child of children.filter(({ command }) => command.includes(BACKEND_ENTRY))) {
          yield* Effect.sync(() => killIfAlive(child.pid));
        }
        launched.kill("SIGKILL");
      })
  );
  const mainPid = main.pid ?? -1;
  const output: string[] = [];
  main.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  main.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const exited = new Promise<AppExit>((resolve) => {
    main.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const windowErrors: string[] = [];
  const frameUrl = yield* Effect.tryPromise({
    try: () => renderSlide(electronApp, windowErrors),
    catch: (cause) =>
      new SmokeFailed({
        message: `The window did not render the slide: ${String(cause)}\n[window errors]\n${windowErrors.join("\n")}\n[app output]\n${output.join("")}`,
      }),
  });
  if (windowErrors.length > 0) {
    return yield* new SmokeFailed({
      message: `The window rendered the slide but reported errors:\n${windowErrors.join("\n")}`,
    });
  }
  yield* Console.log(`The frame rendered the slide and its Fuse Button from ${frameUrl}`);
  if (new URL(frameUrl).hostname !== "127.0.0.1") {
    return yield* new SmokeFailed({ message: `The deck was framed from ${frameUrl}, not 127.0.0.1.` });
  }

  const backends = (yield* childProcesses(mainPid)).filter(({ command }) => command.includes(BACKEND_ENTRY));
  const [backend] = backends;
  if (backend === undefined || backends.length !== 1) {
    return yield* new SmokeFailed({
      message: `Expected one backend child of pid ${String(mainPid)}, found ${String(backends.length)}.`,
    });
  }
  if (!backend.command.startsWith(`${executable} `)) {
    return yield* new SmokeFailed({
      message: `The backend does not run on the app's executable: ${backend.command}`,
    });
  }
  yield* Console.log(`The backend is pid ${String(backend.pid)}: ${backend.command}`);

  yield* Effect.tryPromise({
    try: () => electronApp.close(),
    catch: (cause) => new SmokeFailed({ message: `The app did not quit: ${String(cause)}` }),
  });
  const exit = yield* Effect.promise(() => exited);
  yield* Console.log(`[app output]\n${output.join("")}`);
  if (exit.code !== 0 || exit.signal !== null) {
    return yield* new SmokeFailed({
      message: `The app exited with code ${String(exit.code)} and signal ${String(exit.signal)}, not 0.`,
    });
  }
  if (isAlive(backend.pid)) {
    return yield* new SmokeFailed({ message: `The backend, pid ${String(backend.pid)}, outlived the app.` });
  }
  if (
    !output.join("").includes(`[backend] stopped pid ${String(backend.pid)}: the backend exited with code`)
  ) {
    return yield* new SmokeFailed({ message: "The app did not report the backend's exit on quit." });
  }
  yield* Console.log(
    "Packaged smoke passed: the copied app started with a bare PATH, ran the backend on its own executable, framed the deck from 127.0.0.1, rendered the slide's Fuse Button, and quit with exit 0 after its backend exited."
  );
}).pipe(Effect.scoped);

/**
 * Wait for the stub page to frame the deck, then for the slide and its Fuse Button inside the frame.
 * The first load optimizes the deck's dependencies and reloads the frame once, so the waits allow
 * for a cold start.
 *
 * @param windowErrors - Collects the window's console errors and page errors.
 * @returns The frame's address.
 */
async function renderSlide(electronApp: ElectronApplication, windowErrors: string[]): Promise<string> {
  const window = await electronApp.firstWindow({ timeout: 60_000 });
  // The page and its frame log here, Content-Security-Policy violations included.
  window.on("console", (message) => {
    if (message.type() === "error") {
      windowErrors.push(`console.error: ${message.text()}`);
    }
  });
  window.on("pageerror", (error) => windowErrors.push(`pageerror: ${error.message}`));
  const frame = window.frameLocator("#deck");
  const slide = frame.locator('section[aria-roledescription="slide"]');
  try {
    await slide.and(frame.getByRole("region", { name: "Intro" })).waitFor({ timeout: 120_000 });
    await frame.getByRole("button", { name: "Ask" }).waitFor({ timeout: 30_000 });
  } catch (error) {
    // What the stub page shows says how far startup got.
    const status = await window
      .locator("#status")
      .textContent({ timeout: 1_000 })
      .catch(() => null);
    throw new Error(`${String(error)}\nThe stub page's status: ${String(status)}`, { cause: error });
  }
  // A missing policy would make the page more permissive and pass everything above, so read it.
  const policy = Schema.decodeUnknownSync(Schema.NullOr(Schema.String))(
    await window.evaluate(
      "fetch(location.href).then((response) => response.headers.get('content-security-policy'))"
    )
  );
  if (policy === null || !policy.split("; ").includes("frame-src http://127.0.0.1:*")) {
    throw new Error(
      `The stub page's Content-Security-Policy lacks frame-src http://127.0.0.1:*: ${String(policy)}`
    );
  }
  const src = await window.locator("#deck").getAttribute("src");
  if (src === null) {
    throw new Error("The deck frame has no src.");
  }
  return src;
}

smoke.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
