import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Bundler } from "../src/bundler/bundler.ts";
import { DeckFiles } from "../src/deck/deck-files.ts";
import { saveSlide } from "../src/deck/save-slide.ts";
import { scaffoldDeck } from "../src/deck/scaffold.ts";
import { SlideRevision } from "../src/deck/slide-edit.ts";
import { SlideId } from "../src/deck/slide-id.ts";

const intro = SlideId.make("intro");

/** A lock record naming this test's own process, which is alive, so no edit takes it over. */
const LIVE_LOCK = JSON.stringify({ pid: process.pid, token: "the-test-holds-it" });

/** The revision the save contract promises: the SHA-256 of the file's bytes, in hex. */
const sha256 = (text: string) => SlideRevision.make(createHash("sha256").update(text, "utf8").digest("hex"));

const tempDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), "fuse-deck-save-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
);

/** The real file system, except that every rename fails, as a full or read-only disk can. */
const failingRename = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (real) =>
    FileSystem.make({
      ...real,
      rename: (from) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "rename",
            description: "input/output error",
            pathOrDescriptor: from,
          })
        ),
    })
  )
).pipe(Layer.provide(NodeServices.layer));

/**
 * Run `body` on a new deck from `create` with one more slide, `intro`, holding `# Intro`, through
 * the deck's files and bundler over `fileSystem`.
 */
const withDeck = Effect.fnUntraced(
  function* <A, E>(
    body: (root: string) => Effect.Effect<A, E, DeckFiles | Bundler | Scope.Scope>,
    fileSystem: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer
  ) {
    const root = path.join(yield* tempDir, "deck");
    yield* scaffoldDeck({ directory: root, brief: Option.none(), theme: "neutral-elma-private" });
    const created = yield* Effect.service(DeckFiles).pipe(Effect.provide(DeckFiles.layerFrom(root)));
    yield* created.addSlide(intro, { _tag: "End" }, "# Intro\n");
    // The runtime is never served here: a save only compiles.
    const layer = Bundler.layer({
      runtimeRoot: path.join(root, "no-runtime"),
      cacheRoot: path.join(root, "..", "cache"),
    }).pipe(Layer.provideMerge(DeckFiles.layerFrom(root)), Layer.provide(fileSystem));
    return yield* body(root).pipe(Effect.provide(layer));
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer)
);

const slideFile = (root: string) => path.join(root, "slides", "intro.mdx");
const readSlide = (root: string) => Effect.promise(() => readFile(slideFile(root), "utf8"));
const slideNames = (root: string) =>
  Effect.promise(() => readdir(path.join(root, "slides"))).pipe(Effect.map((names) => [...names].sort()));

describe("saveSlide", () => {
  it.effect("saves over the revision it opened and returns the revision of the bytes it wrote", () =>
    withDeck((root) =>
      Effect.gen(function* () {
        const files = yield* DeckFiles;
        const opened = yield* files.openSlide(intro);
        assert.deepStrictEqual(opened, { source: "# Intro\n", revision: sha256("# Intro\n") });
        const saved = yield* saveSlide(intro, opened.revision, "# Intro, saved\n");
        assert.deepStrictEqual(saved, { revision: sha256("# Intro, saved\n"), problem: null });
        assert.strictEqual(yield* readSlide(root), "# Intro, saved\n");
        assert.deepStrictEqual(yield* slideNames(root), ["cover.mdx", "intro.mdx"]);
      })
    )
  );

  it.effect("replaces the file by rename, so a reader never sees it half written", () =>
    withDeck((root) =>
      Effect.gen(function* () {
        const files = yield* DeckFiles;
        const before = yield* Effect.promise(() => stat(slideFile(root)));
        yield* saveSlide(intro, (yield* files.openSlide(intro)).revision, "# Renamed into place\n");
        const after = yield* Effect.promise(() => stat(slideFile(root)));
        // A write in place keeps the inode; a rename puts a new file at the path.
        assert.notStrictEqual(after.ino, before.ino);
      })
    )
  );

  it.effect("fails with the disk's text when the slide changed, and writes nothing", () =>
    withDeck((root) =>
      Effect.gen(function* () {
        const files = yield* DeckFiles;
        const opened = yield* files.openSlide(intro);
        yield* Effect.promise(() => writeFile(slideFile(root), "# Changed by an agent\n"));
        const error = yield* Effect.flip(saveSlide(intro, opened.revision, "# My draft\n"));
        assert.strictEqual(error._tag, "SlideConflict");
        assert.deepStrictEqual(error._tag === "SlideConflict" ? error.disk : null, {
          _tag: "Present",
          source: "# Changed by an agent\n",
          revision: sha256("# Changed by an agent\n"),
        });
        assert.strictEqual(yield* readSlide(root), "# Changed by an agent\n");
      })
    )
  );

  it.effect("fails with Missing when the slide file was deleted, and recreates it only when told to", () =>
    withDeck((root) =>
      Effect.gen(function* () {
        const files = yield* DeckFiles;
        const opened = yield* files.openSlide(intro);
        yield* Effect.promise(() => unlink(slideFile(root)));
        const error = yield* Effect.flip(saveSlide(intro, opened.revision, "# My draft\n"));
        assert.deepStrictEqual(error._tag === "SlideConflict" ? error.disk : error._tag, { _tag: "Missing" });
        assert.deepStrictEqual(yield* slideNames(root), ["cover.mdx"]);
        // Expecting no file is how the editor writes its draft back after the conflict.
        const saved = yield* saveSlide(intro, null, "# My draft\n");
        assert.strictEqual(saved.revision, sha256("# My draft\n"));
        assert.strictEqual(yield* readSlide(root), "# My draft\n");
      })
    )
  );

  it.effect("refuses a slide the order no longer names", () =>
    withDeck((root) =>
      Effect.gen(function* () {
        const files = yield* DeckFiles;
        const opened = yield* files.openSlide(intro);
        yield* files.removeSlide(intro);
        const error = yield* Effect.flip(saveSlide(intro, opened.revision, "# My draft\n"));
        assert.strictEqual(error._tag, "SlideNotInDeck");
        assert.deepStrictEqual(yield* slideNames(root), ["cover.mdx"]);
      })
    )
  );

  it.effect("saves invalid MDX and reports where its compile failed", () =>
    withDeck((root) =>
      Effect.gen(function* () {
        const files = yield* DeckFiles;
        const text = "# Intro\n\n{1 +}\n\nText\n";
        const saved = yield* saveSlide(intro, (yield* files.openSlide(intro)).revision, text);
        assert.strictEqual(yield* readSlide(root), text);
        // The expression on line 3 ends early, at its fifth column.
        const where =
          saved.problem?._tag === "SlideCompileFailed" ? [saved.problem.line, saved.problem.column] : null;
        assert.deepStrictEqual(where, [3, 5]);
      })
    )
  );

  it.effect("saves invalid frontmatter and reports it without a line", () =>
    withDeck((root) =>
      Effect.gen(function* () {
        const files = yield* DeckFiles;
        const text = "---\nlayout: nowhere\n---\n\n# Intro\n";
        const saved = yield* saveSlide(intro, (yield* files.openSlide(intro)).revision, text);
        assert.strictEqual(yield* readSlide(root), text);
        assert.strictEqual(saved.problem?._tag, "InvalidFrontmatter");
      })
    )
  );

  it.effect("removes its temporary file when the rename fails, and leaves the slide as it was", () =>
    withDeck(
      (root) =>
        Effect.gen(function* () {
          const files = yield* DeckFiles;
          const opened = yield* files.openSlide(intro);
          const error = yield* Effect.flip(saveSlide(intro, opened.revision, "# Never lands\n"));
          assert.strictEqual(error._tag, "DeckIoFailed");
          assert.strictEqual(yield* readSlide(root), "# Intro\n");
          assert.deepStrictEqual(yield* slideNames(root), ["cover.mdx", "intro.mdx"]);
        }),
      failingRename
    )
  );

  it.live("fails with LockHeld while another live command holds the deck's lock, and writes nothing", () =>
    withDeck((root) =>
      Effect.gen(function* () {
        const files = yield* DeckFiles;
        const opened = yield* files.openSlide(intro);
        yield* Effect.promise(() => writeFile(path.join(root, ".fuse-deck.lock"), LIVE_LOCK));
        const error = yield* Effect.flip(saveSlide(intro, opened.revision, "# Waited too long\n"));
        assert.strictEqual(error._tag, "LockHeld");
        assert.strictEqual(yield* readSlide(root), "# Intro\n");
        assert.deepStrictEqual(yield* slideNames(root), ["cover.mdx", "intro.mdx"]);
      })
    )
  );
});

describe("the editor's boundary", () => {
  const secret = "outside-the-deck-7f3a";

  it.effect("opens and saves no slide that a symlinked file or directory takes outside the deck", () =>
    withDeck((root) =>
      Effect.gen(function* () {
        const files = yield* DeckFiles;
        const outside = path.join(path.dirname(root), "outside");
        // A symlinked slide file.
        yield* Effect.promise(async () => {
          await mkdir(outside);
          await writeFile(path.join(outside, "intro.mdx"), `# ${secret}\n`);
          await unlink(slideFile(root));
          await symlink(path.join(outside, "intro.mdx"), slideFile(root));
        });
        const openedFile = yield* Effect.result(files.openSlide(intro));
        const savedFile = yield* Effect.result(saveSlide(intro, sha256(`# ${secret}\n`), "# Overwritten\n"));
        // A symlinked slides directory.
        yield* Effect.promise(async () => {
          await rm(path.join(root, "slides"), { recursive: true });
          await symlink(outside, path.join(root, "slides"));
        });
        const openedDirectory = yield* Effect.result(files.openSlide(intro));
        const savedDirectory = yield* Effect.result(
          saveSlide(intro, sha256(`# ${secret}\n`), "# Overwritten\n")
        );
        const tag = (result: Result.Result<unknown, { readonly _tag: string }>) =>
          Result.isFailure(result) ? result.failure._tag : "Succeeded";
        assert.deepStrictEqual([openedFile, savedFile, openedDirectory, savedDirectory].map(tag), [
          "DeckIoFailed",
          "DeckIoFailed",
          "DeckIoFailed",
          "DeckIoFailed",
        ]);
        // Nothing outside the deck was written.
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(outside)), ["intro.mdx"]);
        assert.strictEqual(
          yield* Effect.promise(() => readFile(path.join(outside, "intro.mdx"), "utf8")),
          `# ${secret}\n`
        );
      })
    )
  );
});
