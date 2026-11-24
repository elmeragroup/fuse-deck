/**
 * The dev server's watcher: a poll of the deck directory that deck-core runs itself.
 *
 * Vite's chokidar, with `usePolling`, watches each file through `fs.watchFile`, whose first stat
 * runs on libuv's thread pool after chokidar's `ready`. A write that lands before that stat
 * becomes the baseline and is never reported. On a busy pool, the gap lasted past 50 ms in 5 of 5
 * runs. Nothing tells JavaScript when the stat has run, so no wait on chokidar closes the gap.
 * This poll takes its baseline itself and returns only once it holds every file's stat.
 *
 * A deck holds a few dozen files, so a scan every 100 ms costs little. Native events are no
 * option: on a busy Mac, FSEvents delivered slide edits 10 s late or not within a minute.
 */

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import path from "node:path";

import { isInside } from "../deck/contained-file.ts";
import { BUILD_MARKER, DEFAULT_OUT } from "./build-output.ts";

/** What happened to a file between two scans, named as chokidar and Vite name it. */
export type DeckFileEvent = "add" | "change" | "unlink";

/** How often the poll scans the deck. An edit reaches the page within about this long. */
const POLL_INTERVAL = Duration.millis(100);

/**
 * Directories the poll skips, by name, at any depth: what Vite's own watcher ignores, and
 * `.fuse-deck`, which holds the optimizer cache. The scan also skips the deck's `dist`, where
 * `build` writes by default, and any directory holding a build's marker, so a build during `dev`
 * reports nothing.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".fuse-deck",
  "test-results",
]);

/** How many directory reads and stats one scan runs at once. */
const SCAN_CONCURRENCY = 16;

/** Each file's absolute path and what its stat said, as one comparable string. */
type Snapshot = ReadonlyMap<string, string>;

/**
 * Poll the deck directory until the scope closes, and call `report` for each file added, changed
 * or removed since the scan before.
 *
 * It returns once its first scan has a stat of every file, so a write made after it returns is
 * reported. A file counts as changed when its size, modification time or inode differs, as an
 * editor's save through a rename does.
 *
 * @param root - The deck directory.
 * @param report - Called with each event and the file's absolute path.
 * @returns Once the first scan has finished; the poll runs on in the scope.
 */
export const pollDeck = Effect.fn("pollDeck")(function* (
  root: string,
  report: (event: DeckFileEvent, file: string) => void
): Effect.fn.Return<void, never, FileSystem.FileSystem | Scope.Scope> {
  const fs = yield* FileSystem.FileSystem;
  let last = yield* scan(fs, root);
  yield* Effect.sleep(POLL_INTERVAL).pipe(
    Effect.andThen(scan(fs, root)),
    Effect.tap((next) =>
      Effect.sync(() => {
        for (const [event, file] of difference(last, next)) {
          report(event, file);
        }
        last = next;
      })
    ),
    Effect.forever,
    Effect.forkScoped
  );
});

/** Every file under `root`, outside the skipped directories, with its stat's signature. */
function scan(fs: FileSystem.FileSystem, root: string): Effect.Effect<Snapshot> {
  // A file or directory that goes away mid-scan counts as absent until the next scan.
  const buildOutput = path.join(root, DEFAULT_OUT);
  const walk = (
    realRoot: string,
    directory: string
  ): Effect.Effect<ReadonlyArray<readonly [string, string]>> =>
    fs.readDirectoryEntries(directory).pipe(
      Effect.orElseSucceed((): ReadonlyArray<FileSystem.DirectoryEntry> => []),
      Effect.flatMap((entries) =>
        entries.some((entry) => entry.name === BUILD_MARKER)
          ? Effect.succeed([])
          : Effect.forEach(
              entries,
              (entry) => {
                const file = path.join(directory, entry.name);
                if (entry.type === "Directory") {
                  return SKIPPED_DIRECTORIES.has(entry.name) || file === buildOutput
                    ? Effect.succeed([])
                    : walk(realRoot, file);
                }
                // A symbolic link counts when its real path is a file inside the deck, which is
                // all the studio and Vite read through it. A linked directory is not followed, so
                // a link cycle cannot hold the scan.
                return fs.realPath(file).pipe(
                  Effect.filterOrFail((real) => isInside(realRoot, real)),
                  Effect.flatMap((real) => fs.stat(real)),
                  Effect.map((info) => (info.type === "File" ? [[file, signature(info)] as const] : [])),
                  Effect.orElseSucceed(() => [])
                );
              },
              { concurrency: SCAN_CONCURRENCY }
            ).pipe(Effect.map((files) => files.flat()))
      )
    );
  return fs.realPath(root).pipe(
    Effect.orElseSucceed(() => root),
    Effect.flatMap((realRoot) => walk(realRoot, root)),
    Effect.map((files) => new Map(files))
  );
}

/** What the poll compares between scans. */
function signature(info: FileSystem.File.Info): string {
  const mtime = Option.match(info.mtime, { onNone: () => "", onSome: (date) => String(date.getTime()) });
  const ino = Option.match(info.ino, { onNone: () => "", onSome: String });
  return `${String(info.size)}:${mtime}:${ino}`;
}

/** The events that take `before` to `after`. */
function difference(before: Snapshot, after: Snapshot): ReadonlyArray<readonly [DeckFileEvent, string]> {
  const events: Array<readonly [DeckFileEvent, string]> = [];
  for (const [file, now] of after) {
    const then = before.get(file);
    if (then === undefined) {
      events.push(["add", file]);
    } else if (then !== now) {
      events.push(["change", file]);
    }
  }
  for (const file of before.keys()) {
    if (!after.has(file)) {
      events.push(["unlink", file]);
    }
  }
  return events;
}
