/**
 * The packaged smoke test: the proof that the packaged app runs with no checkout and a bare PATH.
 *
 * It copies the packaged app and the fixture deck (one slide that imports
 * `@elmeragroup/fuse/button`) into a fresh temporary directory, so no workspace sits on any path the
 * app sees. It launches the copied app's executable through Playwright's Electron driver, with
 * `PATH=/usr/bin:/bin`, that directory as the working directory, its own user data directory and
 * `FUSE_DECK_STUDIO_DECK` naming the deck. It checks that the studio backend runs on the app's own
 * executable, that the window frames the deck from 127.0.0.1 under the page's
 * Content-Security-Policy, that the frame renders the slide and its Fuse Button, and that the
 * sidebar marks the slide current. Then it types an unsaved draft into the Source tab, kills the
 * backend, and checks that the app starts a new one, the window reconnects to it and frames the
 * deck again from the new run's dev server, and the draft is still there.
 * Then it asks main to present a page on another 127.0.0.1 port and checks that main refuses it and
 * opens no window. It shows the second slide, presses Present, and checks that a fullscreen window
 * without the preload opens on the deck at that slide, and that Escape closes it.
 * Last it closes the window, which asks about the draft, and Cancel keeps it open. Then it quits the
 * app as a user does, through `app.quit()`. The page asks again: Cancel keeps the app running, and
 * Save on a second quit writes the draft. It checks that the
 * app exited 0, the backend is gone, and the page made no call main had stopped answering.
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
import type { ChildProcess as NodeChildProcess } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";

/** One step of the smoke test failed. */
class SmokeFailed extends Schema.TaggedError<SmokeFailed>()("SmokeFailed", {
  message: Schema.String,
}) {}

const desktopRoot = path.resolve(import.meta.dirname, "..");
const PRODUCT_NAME = "fuse-deck studio";
const packagedApp = path.join(desktopRoot, ".artifacts", "release", "mac-arm64", `${PRODUCT_NAME}.app`);
const fixtureDeck = path.join(desktopRoot, "test", "fixtures", "deck");

/** The backend's command line carries this path inside the copied app. */
const BACKEND_ENTRY = path.join(
  "backend",
  "node_modules",
  "@elmeragroup",
  "fuse-deck-studio",
  "dist",
  "server",
  "bin.mjs"
);

/** The fixture deck's title, which names the preview frame. */
const DECK_TITLE = "Studio smoke";
const PREVIEW = `iframe[title="${DECK_TITLE} preview"]`;

/** The draft the smoke test types into the first slide's source and saves when it quits. */
const DRAFT =
  'import { Button } from "@elmeragroup/fuse/button";\n\n# Intro\n\nTyped in the smoke test.\n\n<Button>Ask</Button>\n';
const SOURCE_EDITOR = "Source of slides/intro.mdx";

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
  const window = yield* Effect.tryPromise({
    try: () => electronApp.firstWindow({ timeout: 60_000 }),
    catch: (cause) => new SmokeFailed({ message: `No window opened: ${String(cause)}` }),
  });
  // The page and its frame log here, Content-Security-Policy violations included.
  window.on("console", (message) => {
    if (message.type() === "error") {
      windowErrors.push(`console.error: ${message.text()}`);
    }
  });
  window.on("pageerror", (error) => windowErrors.push(`pageerror: ${error.message}`));
  const frameUrl = yield* Effect.tryPromise({
    try: () => renderSlide(window, null),
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
    try: () => typeDraft(window),
    catch: (cause) => new SmokeFailed({ message: `The Source tab did not take a draft: ${String(cause)}` }),
  });

  // A crashed backend: main starts another, exchanges its bootstrap credential, and the window
  // reconnects with the new bearer and opens the deck again.
  yield* Effect.sync(() => killIfAlive(backend.pid));
  const restarted = yield* Effect.tryPromise({
    try: () => renderSlide(window, frameUrl),
    catch: (cause) =>
      new SmokeFailed({
        message: `The window did not recover from a backend restart: ${String(cause)}\n[window errors]\n${windowErrors.join("\n")}\n[app output]\n${output.join("")}`,
      }),
  });
  const replacements = (yield* childProcesses(mainPid)).filter(({ command }) =>
    command.includes(BACKEND_ENTRY)
  );
  const [replacement] = replacements;
  if (replacement === undefined || replacements.length !== 1 || replacement.pid === backend.pid) {
    return yield* new SmokeFailed({
      message: `Expected one new backend child after the restart, found ${replacements.map(({ pid }) => String(pid)).join(", ")}.`,
    });
  }
  // The renderer's own reconnect attempts log transport errors while the backend is down; only
  // errors after recovery would mean something.
  windowErrors.length = 0;
  yield* Console.log(
    `After killing pid ${String(backend.pid)}, backend pid ${String(replacement.pid)} serves the deck again at ${restarted}`
  );
  const kept = yield* Effect.promise(() =>
    window.getByRole("textbox", { name: SOURCE_EDITOR, includeHidden: true }).inputValue()
  );
  if (kept !== DRAFT) {
    return yield* new SmokeFailed({
      message: `The unsaved draft did not survive the backend restart; the editor holds:\n${kept}`,
    });
  }
  // The Preview tab shows, so the editor is hidden but holds its text.
  yield* Console.log("The unsaved draft survived the backend restart");

  const refused = yield* Effect.tryPromise({
    try: () => presentAnotherPort(electronApp, window, restarted),
    catch: (cause) => new SmokeFailed({ message: `Present did not refuse another port: ${String(cause)}` }),
  });
  yield* Console.log(`Main refused to present ${refused}`);

  const presented = yield* Effect.tryPromise({
    try: () => present(electronApp, window),
    catch: (cause) =>
      new SmokeFailed({
        message: `Present did not work: ${String(cause)}\n[window errors]\n${windowErrors.join("\n")}\n[app output]\n${output.join("")}`,
      }),
  });
  yield* Console.log(`Present opened ${presented} fullscreen, and Escape closed it`);

  yield* Effect.tryPromise({
    try: () => quitWithDraft(electronApp, window, main),
    catch: (cause) =>
      new SmokeFailed({
        message: `The quit did not ask about the draft: ${String(cause)}\n[app output]\n${output.join("")}`,
      }),
  });
  const exit = yield* Effect.promise(() => exited);
  const written = yield* fs.readFileString(path.join(deck, "slides", "intro.mdx"));
  if (written !== DRAFT) {
    return yield* new SmokeFailed({
      message: `Save on quit did not write the draft; the slide holds:\n${written}`,
    });
  }
  yield* Console.log(`[app output]\n${output.join("")}`);
  // A page call main no longer answers, such as a draft report sent after Save on quit.
  if (output.join("").includes("No handler registered")) {
    return yield* new SmokeFailed({ message: "The page called main after main stopped answering it." });
  }
  if (exit.code !== 0 || exit.signal !== null) {
    return yield* new SmokeFailed({
      message: `The app exited with code ${String(exit.code)} and signal ${String(exit.signal)}, not 0.`,
    });
  }
  if (isAlive(replacement.pid)) {
    return yield* new SmokeFailed({
      message: `The backend, pid ${String(replacement.pid)}, outlived the app.`,
    });
  }
  if (
    !output
      .join("")
      .includes(`[backend] stopped pid ${String(replacement.pid)}: the backend exited with code`)
  ) {
    return yield* new SmokeFailed({ message: "The app did not report the backend's exit on quit." });
  }
  yield* Console.log(
    "Packaged smoke passed: the copied app started with a bare PATH, ran the studio backend on its own executable, framed the deck from 127.0.0.1, rendered the slide's Fuse Button, recovered from a killed backend with the unsaved draft kept, refused to present another port, presented the current slide fullscreen and left on Escape, asked about the draft on quit, saved it, and quit with exit 0 after its backend exited."
  );
}).pipe(Effect.scoped);

/**
 * Wait for the window to frame the deck, then for the slide and its Fuse Button inside the frame,
 * and for the sidebar to mark the slide current. The first load optimizes the deck's dependencies
 * and reloads the frame once, so the waits allow for a cold start.
 *
 * @param previous - The frame address before a restart, which the new one must differ from, or null.
 * @returns The frame's address.
 */
async function renderSlide(window: Page, previous: string | null): Promise<string> {
  const preview = window.locator(PREVIEW);
  if (previous !== null) {
    // A selector, not a page function: the window's policy runs no evaluated script.
    await window
      .locator(`${PREVIEW}:not([src=${JSON.stringify(previous)}])`)
      .waitFor({ state: "attached", timeout: 120_000 });
  }
  const frame = window.frameLocator(PREVIEW);
  const slide = frame.locator('section[aria-roledescription="slide"]');
  try {
    await slide.and(frame.getByRole("region", { name: "Intro" })).waitFor({ timeout: 120_000 });
    await frame.getByRole("button", { name: "Ask" }).waitFor({ timeout: 30_000 });
    await window
      .getByRole("button", { name: "Intro" })
      .and(window.locator('[aria-current="true"]'))
      .waitFor({ timeout: 30_000 });
  } catch (error) {
    // What the status line shows says how far startup got.
    const status = await window
      .getByRole("status")
      .textContent({ timeout: 1_000 })
      .catch(() => null);
    throw new Error(`${String(error)}\nThe studio's status: ${String(status)}`, { cause: error });
  }
  // A missing policy would make the page more permissive and pass everything above, so read it.
  const policy = Schema.decodeUnknownSync(Schema.NullOr(Schema.String))(
    await window.evaluate(
      "fetch(location.href).then((response) => response.headers.get('content-security-policy'))"
    )
  );
  if (policy === null || !policy.split("; ").includes("frame-src http://127.0.0.1:*")) {
    throw new Error(
      `The studio's Content-Security-Policy lacks frame-src http://127.0.0.1:*: ${String(policy)}`
    );
  }
  const src = await preview.getAttribute("src");
  if (src === null) {
    throw new Error("The deck frame has no src.");
  }
  return src;
}

/**
 * Show the second slide, press Present, and check the window it opens: fullscreen, on the deck's
 * 127.0.0.1 page at that slide, with no preload bridge. Then press Escape and wait for it to close.
 *
 * @returns The Present window's address.
 */
async function present(electronApp: ElectronApplication, window: Page): Promise<string> {
  await window.getByRole("button", { name: "Outro" }).click();
  await window
    .getByRole("button", { name: "Outro" })
    .and(window.locator('[aria-current="true"]'))
    .waitFor({ timeout: 30_000 });
  const opened = electronApp.waitForEvent("window", { timeout: 30_000 });
  await window.getByRole("button", { name: "Present" }).click();
  const presented = await opened;
  await presented.getByRole("region", { name: "Outro" }).waitFor({ timeout: 60_000 });
  const url = new URL(presented.url());
  if (url.hostname !== "127.0.0.1" || url.hash !== "#/outro") {
    throw new Error(`Present opened ${url.href}, not the deck at #/outro.`);
  }
  if ((await presented.evaluate("typeof window.fuseDeckStudio")) !== "undefined") {
    throw new Error("The Present window has the studio's preload bridge.");
  }
  // macOS animates into fullscreen; wait until the window is there.
  const deadline = Date.now() + 15_000;
  while (!(await presentedIsFullScreen(electronApp))) {
    if (Date.now() > deadline) {
      throw new Error("The Present window never went fullscreen.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const closed = presented.waitForEvent("close", { timeout: 15_000 });
  // Through Electron's input pipeline, as a key press arrives; Playwright's own key events skip
  // `before-input-event`.
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const each of BrowserWindow.getAllWindows()) {
      if (each.isFullScreen()) {
        each.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        each.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      }
    }
  });
  await closed;
  return url.href;
}

/** Type `DRAFT` into the first slide's source, unsaved, and go back to the preview. */
async function typeDraft(window: Page): Promise<void> {
  await window.getByRole("tab", { name: "Source" }).click();
  const editor = window.getByRole("textbox", { name: SOURCE_EDITOR });
  await editor.waitFor({ timeout: 30_000 });
  await editor.fill(DRAFT);
  await window.getByText("Unsaved changes").waitFor({ timeout: 10_000 });
  await window.getByRole("tab", { name: "Preview" }).click();
}

/**
 * Ask main, through the page's own bridge, to present a page on the deck host's next port. Main
 * must refuse it and open no window.
 *
 * @param deckUrl - The open deck's address.
 * @returns The address main refused.
 */
async function presentAnotherPort(
  electronApp: ElectronApplication,
  window: Page,
  deckUrl: string
): Promise<string> {
  const other = new URL(deckUrl);
  other.port = String(Number(other.port) + 1);
  const outcome = await window.evaluate(
    `window.fuseDeckStudio.present(${JSON.stringify(other.href)}).then(() => "opened", () => "refused")`
  );
  // Long enough for a window main had opened to register.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const windows = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  if (outcome !== "refused" || windows !== 1) {
    throw new Error(`Present of ${other.href} ended ${String(outcome)}, with ${String(windows)} windows.`);
  }
  return other.href;
}

/**
 * Close the window, then quit, while the draft is unsaved. The page asks each time. Cancel keeps the
 * window and the app; a second quit answered with Save writes the draft and quits.
 */
async function quitWithDraft(
  electronApp: ElectronApplication,
  window: Page,
  main: NodeChildProcess
): Promise<void> {
  const dialog = window.getByRole("dialog", { name: "Save your changes to slides/intro.mdx?" });
  // Closing the window asks too, and Cancel keeps it.
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const each of BrowserWindow.getAllWindows()) {
      each.close();
    }
  });
  await dialog.waitFor({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached", timeout: 10_000 });
  const open = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  if (open !== 1) {
    throw new Error(`Cancel on the window's close left ${String(open)} windows open.`);
  }
  await electronApp.evaluate(({ app }) => {
    app.quit();
  });
  await dialog.waitFor({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached", timeout: 10_000 });
  // Long enough for a quit that went on anyway to end the process.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  if (main.exitCode !== null || main.signalCode !== null) {
    throw new Error("The app quit although the user cancelled.");
  }
  await electronApp.evaluate(({ app }) => {
    app.quit();
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click({ timeout: 30_000 });
}

/** Whether a window other than the main one is fullscreen. */
async function presentedIsFullScreen(electronApp: ElectronApplication): Promise<boolean> {
  const fullscreen = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((each) => each.isFullScreen())
  );
  return fullscreen.filter(Boolean).length === 1;
}

smoke.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
