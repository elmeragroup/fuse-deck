/**
 * Run the studio in development: the renderer's Vite dev server, then Electron, whose main
 * proxies the dev scheme to that server, so an edit to a studio component reaches the window
 * through Vite's HMR. The backend is the workspace's build of apps/studio. t3code's
 * `scripts/dev-electron.mjs` also builds a dev app bundle and watches main's sources; the studio
 * needs neither yet, so this script starts the two processes and stops both when either ends.
 *
 * Usage: pnpm exec turbo run dev --filter=@elmeragroup/fuse-deck-studio-desktop
 *        (FUSE_DECK_STUDIO_DECK names a deck to open at start)
 */

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { createRequire } from "node:module";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const studioRoot = path.resolve(desktopRoot, "..", "studio");
const require = createRequire(import.meta.url);

/** The renderer's dev server; apps/studio/vite.config.ts serves it on this port. */
const RENDERER_URL = "http://127.0.0.1:5733/";

/** The `electron` package's main export is the path of its executable. */
const electronExecutable = Schema.decodeUnknownSync(Schema.String)(require("electron"));
const viteBin = path.join(
  path.dirname(require.resolve("vite/package.json", { paths: [studioRoot] })),
  "bin",
  "vite.js"
);

/** Pass a child's output lines through, prefixed. */
function relay<E>(label: string, stream: Stream.Stream<Uint8Array, E>) {
  return stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Console.error(`[${label}] ${line}`)),
    Effect.ignore
  );
}

const dev = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const vite = yield* spawner.spawn(
    ChildProcess.make(process.execPath, [viteBin], { cwd: studioRoot, stdin: "ignore", extendEnv: true })
  );
  const listening = yield* Deferred.make<void>();
  yield* relay("vite", vite.stderr).pipe(Effect.forkScoped);
  yield* vite.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Console.error(`[vite] ${line}`).pipe(
        Effect.andThen(line.includes("127.0.0.1:5733") ? Deferred.succeed(listening, undefined) : Effect.void)
      )
    ),
    Effect.ignore,
    Effect.forkScoped
  );
  yield* Deferred.await(listening).pipe(Effect.raceFirst(vite.exitCode.pipe(Effect.ignore)));
  const electron = yield* spawner.spawn(
    ChildProcess.make(electronExecutable, [desktopRoot], {
      cwd: desktopRoot,
      stdin: "ignore",
      extendEnv: true,
      env: { FUSE_DECK_STUDIO_RENDERER_URL: RENDERER_URL },
    })
  );
  yield* relay("electron", electron.stdout).pipe(Effect.forkScoped);
  yield* relay("electron", electron.stderr).pipe(Effect.forkScoped);
  // Whichever ends first ends the session; the scope stops the other.
  yield* Effect.raceFirst(electron.exitCode, vite.exitCode);
}).pipe(Effect.scoped);

dev.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
