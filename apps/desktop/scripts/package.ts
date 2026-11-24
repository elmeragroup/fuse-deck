/**
 * Package the shell as an unsigned macOS arm64 app in `.artifacts/release`.
 *
 * It stages the backend first: a production install of the packed studio backend
 * (`@elmeragroup/fuse-deck-studio`) with React, React DOM and the Fuse release this workspace
 * pins, made by npm in `.artifacts/backend`, with its
 * `package-lock.json` at the root (the deck's optimizer cache is keyed by it). electron-builder
 * copies that tree under `Contents/Resources/backend`, outside `app.asar`, so the backend's Node
 * and Vite read it from the real file system. The script then checks that the packaged tree holds
 * every staged file.
 *
 * Usage: node scripts/package.ts (after `build` here and `pack` in apps/studio)
 */

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Arch, build, Platform } from "electron-builder";
import path from "node:path";

/** A packaging step failed. */
class PackageFailed extends Schema.TaggedError<PackageFailed>()("PackageFailed", {
  message: Schema.String,
}) {}

const desktopRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(desktopRoot, "..", "..");
const studioRoot = path.join(workspaceRoot, "apps", "studio");
const artifacts = path.join(desktopRoot, ".artifacts");
const stage = path.join(artifacts, "backend");
const tarballs = path.join(artifacts, "tarballs");
const release = path.join(artifacts, "release");

/** The packaged app's bundle id and name. */
const APP_ID = "no.elmeragroup.fuse-deck.studio";
const PRODUCT_NAME = "fuse-deck studio";

/** Mirrors `minimumReleaseAge` in pnpm-workspace.yaml, so npm resolves what the lockfile could. */
const RELEASE_AGE = Duration.minutes(4320);

const Manifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The version of a package installed for `root`. */
const installedVersion = Effect.fn("installedVersion")(function* (root: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const manifest = yield* fs.readFileString(path.join(root, "node_modules", name, "package.json"));
  return (yield* Schema.decodeEffect(Manifest)(manifest)).version;
});

/** Run a command to completion, with its output passed through; a non-zero exit fails. */
const run = Effect.fn("run")(function* (command: string, args: readonly string[], cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const label = `${command} ${args.join(" ")}`;
  yield* Console.log(`$ ${label}  (in ${cwd})`);
  const output = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], { cwd, stdin: "ignore", extendEnv: true })
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [text(handle.stdout), text(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" }
      );
      if (exitCode !== 0) {
        return yield* new PackageFailed({ message: `${label} exited ${String(exitCode)}:\n${stderr}` });
      }
      return stdout;
    })
  );
  return output;
});

function text<E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> {
  return stream.pipe(Stream.decodeText(), Stream.mkString);
}

/** The one tarball `pack` left in the studio's `.artifacts`. */
const studioTarball = Effect.fn("studioTarball")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = path.join(studioRoot, ".artifacts");
  const names = (yield* fs
    .readDirectory(directory)
    .pipe(
      Effect.mapError(
        () => new PackageFailed({ message: `No ${directory}. Run the studio's pack task first.` })
      )
    )).filter((name) => name.endsWith(".tgz"));
  const [only] = names;
  if (only === undefined || names.length !== 1) {
    return yield* new PackageFailed({
      message: `Expected one tarball in ${directory}, found ${String(names.length)}.`,
    });
  }
  return path.join(directory, only);
});

/** Stage the backend's production install. */
const stageBackend = Effect.fn("stageBackend")(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(stage, { recursive: true, force: true });
  yield* fs.remove(tarballs, { recursive: true, force: true });
  yield* fs.makeDirectory(stage, { recursive: true });
  yield* fs.makeDirectory(tarballs, { recursive: true });

  const backendTarball = path.join(tarballs, "fuse-deck-studio.tgz");
  yield* fs.copyFile(yield* studioTarball(), backendTarball);
  // The pinned Fuse canary, fetched as a tarball first: pnpm-workspace.yaml exempts in-house
  // canaries from the release age, and the install's `--before` would not.
  const fuseVersion = yield* installedVersion(studioRoot, "@elmeragroup/fuse");
  const packed = yield* run(
    "npm",
    ["pack", `@elmeragroup/fuse@${fuseVersion}`, "--pack-destination", tarballs, "--silent"],
    tarballs
  );
  const fuseTarball = path.join(tarballs, packed.trim());
  const react = yield* installedVersion(studioRoot, "react");

  yield* fs.writeFileString(
    path.join(stage, "package.json"),
    yield* encodeJson({
      name: "fuse-deck-studio-backend",
      private: true,
      type: "module",
      dependencies: {
        "@elmeragroup/fuse": `file:${path.relative(stage, fuseTarball)}`,
        "@elmeragroup/fuse-deck-studio": `file:${path.relative(stage, backendTarball)}`,
        react,
        "react-dom": react,
      },
    })
  );
  const cutoff = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, RELEASE_AGE));
  yield* run(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", `--before=${cutoff}`],
    stage
  );
});

/** Every file under `root`, relative to it, sorted. */
const fileList = Effect.fn("fileList")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(root, { recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    const info = yield* fs.stat(path.join(root, entry));
    if (info.type !== "Directory") {
      files.push(entry);
    }
  }
  return files.toSorted();
});

const packageApp = Effect.gen(function* () {
  yield* stageBackend();
  const electronVersion = yield* installedVersion(desktopRoot, "electron");
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(release, { recursive: true, force: true });
  yield* Effect.tryPromise({
    try: () =>
      build({
        projectDir: desktopRoot,
        targets: Platform.MAC.createTarget(["dir"], Arch.arm64),
        publish: "never",
        config: {
          appId: APP_ID,
          productName: PRODUCT_NAME,
          electronVersion,
          directories: { output: release },
          // The bundles carry their dependencies, so the app ships no node_modules.
          // Bundling drops the source headers, so the notice for the t3code-derived code ships as
          // a file.
          files: ["package.json", "dist/**", "THIRD_PARTY_NOTICES.md"],
          // electron-builder drops a `node_modules` at the root of a copy's source
          // (app-builder-lib's createFilter), so the copy starts one level up, at .artifacts.
          extraResources: [{ from: artifacts, to: ".", filter: ["backend/**/*"] }],
          npmRebuild: false,
          mac: {
            category: "public.app-category.developer-tools",
            // Unsigned until S6.
            identity: null,
          },
        },
      }),
    catch: (cause) => new PackageFailed({ message: `electron-builder failed: ${String(cause)}` }),
  });

  const packaged = path.join(release, "mac-arm64", `${PRODUCT_NAME}.app`, "Contents", "Resources", "backend");
  const [staged, shipped] = yield* Effect.all([fileList(stage), fileList(packaged)], {
    concurrency: "unbounded",
  });
  const missing = staged.filter((file) => !shipped.includes(file));
  if (missing.length > 0) {
    return yield* new PackageFailed({
      message: `The packaged backend lacks ${String(missing.length)} staged files, among them:\n${missing.slice(0, 20).join("\n")}`,
    });
  }
  yield* Console.log(
    `Packaged ${path.relative(desktopRoot, path.dirname(path.dirname(path.dirname(packaged))))} with ${String(shipped.length)} backend files, every staged file included.`
  );
});

packageApp.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
