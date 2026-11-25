import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as fc from "fast-check";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DeckFiles } from "../src/deck/deck-files.ts";
import { formatManifest, parseManifest } from "../src/deck/deck-manifest.ts";
import type { DeckManifest, OrderPosition } from "../src/deck/deck-manifest.ts";
import { scaffoldDeck } from "../src/deck/scaffold.ts";
import { SlideId } from "../src/deck/slide-id.ts";

const id = (text: string) => SlideId.make(text);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const tempDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), "fuse-deck-files-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
);

/**
 * The real file system, except that a write to a path ending in `failing`, through `writeFile` or an
 * open handle, puts the first half of the bytes on disk and then fails, as a full disk does.
 */
function failingWriteTo(failing: string) {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) => {
      const full = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "write",
        description: "no space left on device",
        pathOrDescriptor: failing,
      });
      const half = (data: Uint8Array) => data.subarray(0, Math.ceil(data.length / 2));
      return FileSystem.make({
        ...real,
        writeFile: (target, data, options) =>
          target.endsWith(failing)
            ? Effect.andThen(real.writeFile(target, half(data), options), Effect.fail(full))
            : real.writeFile(target, data, options),
        open: (target, options) =>
          target.endsWith(failing)
            ? Effect.map(real.open(target, options), (file): FileSystem.File => ({
                ...file,
                writeAll: (data) => Effect.andThen(file.writeAll(half(data)), Effect.fail(full)),
              }))
            : real.open(target, options),
      });
    })
  ).pipe(Layer.provide(NodeServices.layer));
}

/** A new deck from `create`, with the given slides added after its cover, in order. */
const deckWith = Effect.fnUntraced(function* (ids: readonly string[]) {
  const root = path.join(yield* tempDir, "deck");
  yield* scaffoldDeck({ directory: root, brief: Option.none(), theme: "neutral-elma-private" });
  const deck = yield* Effect.service(DeckFiles).pipe(Effect.provide(DeckFiles.layerFrom(root)));
  for (const each of ids) {
    yield* deck.addSlide(id(each), { _tag: "End" }, `# ${each}\n`);
  }
  return deck;
});

/** The order in `deck.json` on disk, as plain strings to compare with the expected order. */
function orderOnDisk(root: string) {
  return manifestOnDisk(root).pipe(Effect.map((manifest): string[] => [...manifest.order]));
}

/** `deck.json` as it is on disk, decoded. */
function manifestOnDisk(root: string) {
  return Effect.promise(() => readFile(path.join(root, "deck.json"), "utf8")).pipe(
    Effect.map((text) => Result.getOrThrow(parseManifest(text)))
  );
}

function slideFiles(root: string) {
  return Effect.promise(() => readdir(path.join(root, "slides"))).pipe(
    Effect.map((names) => [...names].sort())
  );
}

describe("DeckFiles", () => {
  type AddCase = {
    readonly name: string;
    readonly position: OrderPosition;
    readonly expected: readonly string[];
  };
  const addCases: readonly AddCase[] = [
    { name: "add c at the end of [a, b]", position: { _tag: "End" }, expected: ["cover", "a", "b", "c"] },
    {
      name: "add c after a in [a, b]",
      position: { _tag: "After", anchor: id("a") },
      expected: ["cover", "a", "c", "b"],
    },
    {
      name: "add c after b in [a, b]",
      position: { _tag: "After", anchor: id("b") },
      expected: ["cover", "a", "b", "c"],
    },
  ];
  for (const { name, position, expected } of addCases) {
    it.effect(`${name} writes the slide file and the order`, () =>
      Effect.gen(function* () {
        const deck = yield* deckWith(["a", "b"]);
        yield* deck.addSlide(id("c"), position, "# c\n");
        assert.deepStrictEqual(yield* orderOnDisk(deck.root), expected);
        assert.strictEqual(
          yield* Effect.promise(() => readFile(path.join(deck.root, "slides", "c.mdx"), "utf8")),
          "# c\n"
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  }

  type MoveCase = {
    readonly move: string;
    readonly position: Exclude<OrderPosition, { readonly _tag: "End" }>;
    readonly expected: readonly string[];
  };
  const moveCases: readonly MoveCase[] = [
    { move: "c", position: { _tag: "After", anchor: id("a") }, expected: ["a", "c", "b"] },
    { move: "a", position: { _tag: "After", anchor: id("c") }, expected: ["b", "c", "a"] },
    { move: "c", position: { _tag: "Before", anchor: id("a") }, expected: ["c", "a", "b"] },
    { move: "a", position: { _tag: "Before", anchor: id("c") }, expected: ["b", "a", "c"] },
    { move: "b", position: { _tag: "After", anchor: id("a") }, expected: ["a", "b", "c"] },
  ];
  for (const { move, position, expected } of moveCases) {
    it.effect(
      `move ${move} ${position._tag.toLowerCase()} ${position.anchor} in [a, b, c] gives [${expected.join(", ")}]`,
      () =>
        Effect.gen(function* () {
          const deck = yield* deckWith(["a", "b", "c"]);
          yield* deck.removeSlide(id("cover"));
          yield* deck.moveSlide(id(move), position);
          assert.deepStrictEqual(yield* orderOnDisk(deck.root), expected);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  }

  it.effect("remove takes the slide out of the order and deletes its file", () =>
    Effect.gen(function* () {
      const deck = yield* deckWith(["a", "b"]);
      yield* deck.removeSlide(id("a"));
      assert.deepStrictEqual(yield* orderOnDisk(deck.root), ["cover", "b"]);
      assert.deepStrictEqual(yield* slideFiles(deck.root), ["b.mdx", "cover.mdx"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("refuses edits that name the wrong slides, and leaves the deck as it was", () =>
    Effect.gen(function* () {
      const deck = yield* deckWith(["a", "b"]);
      const failures = [
        yield* Effect.flip(deck.addSlide(id("a"), { _tag: "End" }, "# a\n")),
        yield* Effect.flip(deck.addSlide(id("c"), { _tag: "After", anchor: id("zz") }, "# c\n")),
        yield* Effect.flip(deck.moveSlide(id("zz"), { _tag: "After", anchor: id("a") })),
        yield* Effect.flip(deck.moveSlide(id("a"), { _tag: "Before", anchor: id("a") })),
        yield* Effect.flip(deck.removeSlide(id("zz"))),
      ];
      assert.deepStrictEqual(
        failures.map((failure) => failure._tag),
        ["SlideIdTaken", "SlideNotInDeck", "SlideNotInDeck", "SlideAnchoredToItself", "SlideNotInDeck"]
      );
      assert.deepStrictEqual(yield* orderOnDisk(deck.root), ["cover", "a", "b"]);
      assert.deepStrictEqual(yield* slideFiles(deck.root), ["a.mdx", "b.mdx", "cover.mdx"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("add refuses to overwrite an orphan file and leaves the order alone", () =>
    Effect.gen(function* () {
      const deck = yield* deckWith([]);
      const orphan = path.join(deck.root, "slides", "notes.mdx");
      yield* Effect.promise(() => writeFile(orphan, "# Kept\n"));
      const failure = yield* Effect.flip(deck.addSlide(id("notes"), { _tag: "End" }, "# New\n"));
      assert.strictEqual(failure._tag, "SlideFileExists");
      assert.strictEqual(yield* Effect.promise(() => readFile(orphan, "utf8")), "# Kept\n");
      assert.deepStrictEqual(yield* orderOnDisk(deck.root), ["cover"]);
      assert.deepStrictEqual((yield* deck.load).orphans, ["slides/notes.mdx"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("keeps every edit when many run at once", () =>
    Effect.gen(function* () {
      const deck = yield* deckWith([]);
      const ids = Array.from({ length: 12 }, (_, index) => `s${String(index)}`);
      yield* Effect.forEach(ids, (each) => deck.addSlide(id(each), { _tag: "End" }, `# ${each}\n`), {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual((yield* orderOnDisk(deck.root)).sort(), ["cover", ...ids].sort());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("takes over a lock a crashed command left behind", () =>
    Effect.gen(function* () {
      const deck = yield* deckWith([]);
      const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
      const stale = yield* encodeJson({ pid: deadPid, token: "crashed" });
      yield* Effect.promise(() => writeFile(path.join(deck.root, ".fuse-deck.lock"), stale));
      yield* deck.addSlide(id("after-crash"), { _tag: "End" }, "# After\n");
      assert.deepStrictEqual(yield* orderOnDisk(deck.root), ["cover", "after-crash"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("add then remove gives back the manifest it started from", () =>
    Effect.gen(function* () {
      const deck = yield* deckWith([]);
      const pool = ["a", "b", "c", "d", "e", "f"];
      const scenario = fc.record({
        existing: fc.uniqueArray(fc.constantFrom(...pool), { maxLength: 5 }),
        added: fc.constantFrom(...pool, "g"),
        anchor: fc.option(fc.constantFrom(...pool, "cover"), { nil: undefined }),
      });
      const runPromise = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem>());
      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(scenario, async ({ existing, added, anchor }) => {
            fc.pre(!existing.includes(added));
            fc.pre(anchor === undefined || anchor === "cover" || existing.includes(anchor));
            const run = Effect.gen(function* () {
              const start: DeckManifest = {
                ...(yield* manifestOnDisk(deck.root)),
                order: [id("cover"), ...existing.map(id)],
              };
              yield* Effect.promise(() =>
                writeFile(path.join(deck.root, "deck.json"), formatManifest(start))
              );
              const position: OrderPosition =
                anchor === undefined ? { _tag: "End" } : { _tag: "After", anchor: id(anchor) };
              yield* deck.addSlide(id(added), position, "# x\n");
              yield* deck.removeSlide(id(added));
              assert.deepStrictEqual(yield* manifestOnDisk(deck.root), start);
            });
            await runPromise(run);
          }),
          { numRuns: 60 }
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});

describe("scaffoldDeck", () => {
  it.live.each([
    { name: "a new directory", existing: false },
    { name: "an existing empty directory", existing: true },
  ])("puts one whole deck in $name when several creates race for it", ({ existing }) =>
    Effect.gen(function* () {
      const parent = yield* tempDir;
      const root = path.join(parent, "talk");
      if (existing) {
        yield* Effect.promise(() => mkdir(root));
      }
      const briefs = ["First brief", "Second brief", "Third brief", "Fourth brief"];
      const results = yield* Effect.forEach(
        briefs,
        (brief) =>
          Effect.result(
            scaffoldDeck({ directory: root, brief: Option.some(brief), theme: "neutral-elma-private" })
          ),
        { concurrency: "unbounded" }
      );
      const winner = results.findIndex(Result.isSuccess);
      const won = results[winner];
      assert.strictEqual(results.filter(Result.isSuccess).length, 1);
      assert.deepStrictEqual(
        results.filter(Result.isFailure).map((result) => result.failure._tag),
        ["DeckDirectoryNotEmpty", "DeckDirectoryNotEmpty", "DeckDirectoryNotEmpty"]
      );
      // Every file the winner reported is on disk, from the winner's brief, and nothing else is.
      const files = won !== undefined && Result.isSuccess(won) ? won.success.files : [];
      const onDisk = yield* Effect.promise(() => readdir(root, { recursive: true }));
      assert.sameMembers(onDisk, [...files, "slides"]);
      const brief = yield* Effect.promise(() => readFile(path.join(root, "BRIEF.md"), "utf8"));
      const cover = yield* Effect.promise(() => readFile(path.join(root, "slides", "cover.mdx"), "utf8"));
      assert.strictEqual(brief, briefs[winner]);
      assert.include(cover, brief);
      assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), ["talk"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("keeps the brief byte for byte", () =>
    Effect.gen(function* () {
      const root = path.join(yield* tempDir, "talk");
      const brief = "Line one\r\n\r\nNo newline at the end";
      yield* scaffoldDeck({ directory: root, brief: Option.some(brief), theme: "neutral-elma-private" });
      assert.strictEqual(yield* Effect.promise(() => readFile(path.join(root, "BRIEF.md"), "utf8")), brief);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect(
    "leaves an empty directory empty when a write fails partway through a file, so a retry succeeds",
    () =>
      Effect.gen(function* () {
        // Oracle: a failed create removes what it wrote, and `create` accepts an empty directory.
        const root = path.join(yield* tempDir, "talk");
        yield* Effect.promise(() => mkdir(root));
        const input = { directory: root, brief: Option.none(), theme: "neutral-elma-private" };
        const failed = yield* Effect.result(
          scaffoldDeck(input).pipe(Effect.provide(failingWriteTo(path.join("slides", "cover.mdx"))))
        );
        assert.strictEqual(Result.isFailure(failed) && failed.failure._tag, "ScaffoldFailed");
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(root)), []);
        yield* scaffoldDeck(input);
        assert.include(yield* Effect.promise(() => readdir(root)), "deck.json");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});

describe("DeckFiles reads", () => {
  it.effect("refuse a slide that a symlinked file or directory takes outside the deck", () =>
    Effect.gen(function* () {
      const deck = yield* deckWith(["a"]);
      const outside = path.join(path.dirname(deck.root), "outside");
      const secret = "outside-the-deck-7f3a";
      yield* Effect.promise(async () => {
        await mkdir(outside);
        await writeFile(path.join(outside, "a.mdx"), `# ${secret}\n`);
        await writeFile(path.join(outside, "cover.mdx"), `# ${secret}\n`);
        // A symlinked slide file.
        await rm(path.join(deck.root, "slides", "a.mdx"));
        await symlink(path.join(outside, "a.mdx"), path.join(deck.root, "slides", "a.mdx"));
      });
      const linkedFile = yield* Effect.result(deck.readSlide(id("a")));
      // A symlinked slides directory.
      yield* Effect.promise(async () => {
        await rm(path.join(deck.root, "slides"), { recursive: true });
        await symlink(outside, path.join(deck.root, "slides"));
      });
      const linkedDirectory = yield* Effect.result(deck.readSlide(id("cover")));
      const outcome = (result: typeof linkedFile) =>
        Result.isFailure(result) ? result.failure._tag : `read ${result.success}`;
      assert.deepStrictEqual(
        [outcome(linkedFile), outcome(linkedDirectory)],
        ["DeckIoFailed", "DeckIoFailed"]
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});

describe("DeckFiles writes", () => {
  type WriteCase = {
    readonly name: string;
    /** Where the symlink goes: the slides directory, or slide `a`'s file. */
    readonly link: "directory" | "file";
    readonly edit: (deck: DeckFiles["Service"]) => Effect.Effect<unknown, { readonly _tag: string }>;
    readonly refusal: string;
  };
  const writeCases: readonly WriteCase[] = [
    {
      name: "add a slide through a symlinked slides directory",
      link: "directory",
      edit: (deck) => deck.addSlide(id("b"), { _tag: "End" }, "# b\n"),
      refusal: "DeckIoFailed",
    },
    {
      name: "remove a slide through a symlinked slides directory",
      link: "directory",
      edit: (deck) => deck.removeSlide(id("a")),
      refusal: "DeckIoFailed",
    },
    {
      name: "remove a slide whose file is a symlink",
      link: "file",
      edit: (deck) => deck.removeSlide(id("a")),
      refusal: "DeckIoFailed",
    },
    {
      // The exclusive create already refuses any existing entry, a symlink included.
      name: "add a slide whose file is a symlink",
      link: "file",
      edit: (deck) => deck.addSlide(id("b"), { _tag: "End" }, "# b\n"),
      refusal: "SlideFileExists",
    },
  ];

  it.effect.each(writeCases)(
    "refuse to $name that leaves the deck, and change nothing",
    ({ link, edit, refusal }) =>
      Effect.gen(function* () {
        // Oracle: the outside directory as the test wrote it, and the order before the edit.
        const deck = yield* deckWith(["a"]);
        const outside = path.join(path.dirname(deck.root), "outside");
        const secret = "# outside-the-deck-7f3a\n";
        yield* Effect.promise(async () => {
          await mkdir(outside);
          await writeFile(path.join(outside, "a.mdx"), secret);
          if (link === "directory") {
            await rm(path.join(deck.root, "slides"), { recursive: true });
            await symlink(outside, path.join(deck.root, "slides"));
          } else {
            await rm(path.join(deck.root, "slides", "a.mdx"));
            await symlink(path.join(outside, "a.mdx"), path.join(deck.root, "slides", "a.mdx"));
            await symlink(path.join(outside, "a.mdx"), path.join(deck.root, "slides", "b.mdx"));
          }
        });
        const result = yield* Effect.result(edit(deck));
        assert.deepStrictEqual(
          {
            outcome: Result.isFailure(result) ? result.failure._tag : "succeeded",
            outside: yield* Effect.promise(() => readdir(outside)),
            secret: yield* Effect.promise(() => readFile(path.join(outside, "a.mdx"), "utf8")),
            order: yield* orderOnDisk(deck.root),
          },
          { outcome: refusal, outside: ["a.mdx"], secret, order: ["cover", "a"] }
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});

describe("A deck holds no symbolic links", () => {
  /** A deck with slides `cover` and `a`, and a deck-relative entry made by `make` before it opens. */
  const openWith = Effect.fnUntraced(function* (make: (root: string) => Promise<void>) {
    const root = path.join(yield* tempDir, "deck");
    yield* scaffoldDeck({ directory: root, brief: Option.none(), theme: "neutral-elma-private" });
    yield* Effect.promise(() => make(root));
    return yield* Effect.result(Effect.service(DeckFiles).pipe(Effect.provide(DeckFiles.layerFrom(root))));
  });

  it.effect.each([
    {
      name: "a link to a file inside the deck",
      make: async (root: string) => {
        await mkdir(path.join(root, "assets"));
        await symlink(path.join(root, "slides", "cover.mdx"), path.join(root, "assets", "copy.mdx"));
      },
      named: "assets/copy.mdx",
    },
    {
      name: "a link to a directory inside the deck",
      make: (root: string) => symlink(path.join(root, "slides"), path.join(root, "pages")),
      named: "pages",
    },
    {
      name: "a named pipe",
      make: (root: string) => {
        spawnSync("mkfifo", [path.join(root, "slides", "pipe.mdx")]);
        return Promise.resolve();
      },
      named: "slides/pipe.mdx",
    },
  ])("refuses to open a deck holding $name, and names it", ({ make, named }) =>
    Effect.gen(function* () {
      const opened = yield* openWith(make);
      const failure = Result.isFailure(opened) ? opened.failure : undefined;
      assert.deepStrictEqual(
        {
          tag: failure?._tag,
          named: failure !== undefined && "path" in failure && failure.path.endsWith(named),
        },
        { tag: "DeckEntryRefused", named: true }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("opens a deck whose node_modules and .git hold links", () =>
    Effect.gen(function* () {
      const opened = yield* openWith(async (root) => {
        await mkdir(path.join(root, "node_modules"));
        await symlink(path.join(root, "slides"), path.join(root, "node_modules", "linked"));
        await mkdir(path.join(root, ".git"));
        await symlink(path.join(root, "slides"), path.join(root, ".git", "linked"));
      });
      assert.strictEqual(Result.isSuccess(opened), true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  type LinkCase = {
    readonly name: string;
    /** Makes a link, after the deck opened, to a file inside the deck. */
    readonly link: (root: string) => Promise<void>;
    readonly use: (deck: DeckFiles["Service"]) => Effect.Effect<unknown, { readonly _tag: string }>;
  };
  const linkCases: readonly LinkCase[] = [
    {
      name: "read a slide whose file links to another slide",
      link: async (root) => {
        await rm(path.join(root, "slides", "a.mdx"));
        await symlink(path.join(root, "slides", "cover.mdx"), path.join(root, "slides", "a.mdx"));
      },
      use: (deck) => deck.readSlide(id("a")),
    },
    {
      name: "list slides beside a linked orphan",
      link: (root) =>
        symlink(path.join(root, "slides", "cover.mdx"), path.join(root, "slides", "orphan.mdx")),
      use: (deck) => deck.load,
    },
    {
      name: "read a deck.json that links to a copy inside the deck",
      link: async (root) => {
        await writeFile(path.join(root, "copy.json"), await readFile(path.join(root, "deck.json")));
        await rm(path.join(root, "deck.json"));
        await symlink(path.join(root, "copy.json"), path.join(root, "deck.json"));
      },
      use: (deck) => deck.load,
    },
    {
      name: "remove a slide whose file links to another slide",
      link: async (root) => {
        await rm(path.join(root, "slides", "a.mdx"));
        await symlink(path.join(root, "slides", "cover.mdx"), path.join(root, "slides", "a.mdx"));
      },
      use: (deck) => deck.removeSlide(id("a")),
    },
  ];

  it.effect.each(linkCases)("refuses to $name made after the deck opened", ({ link, use }) =>
    Effect.gen(function* () {
      const deck = yield* deckWith(["a"]);
      yield* Effect.promise(() => link(deck.root));
      const order = yield* orderOnDisk(deck.root).pipe(Effect.orElseSucceed(() => []));
      const result = yield* Effect.result(use(deck));
      assert.deepStrictEqual(
        {
          outcome: Result.isFailure(result) ? result.failure._tag : "succeeded",
          order: yield* orderOnDisk(deck.root).pipe(Effect.orElseSucceed(() => [])),
          cover: yield* Effect.promise(() => readFile(path.join(deck.root, "slides", "cover.mdx"), "utf8")),
        },
        {
          outcome: "DeckIoFailed",
          order,
          cover: yield* Effect.promise(() => readFile(path.join(deck.root, "slides", "cover.mdx"), "utf8")),
        }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("refuses a lock file that is not a regular file, without waiting on it", () =>
    Effect.gen(function* () {
      const deck = yield* deckWith([]);
      spawnSync("mkfifo", [path.join(deck.root, ".fuse-deck.lock")]);
      const result = yield* Effect.result(
        deck.addSlide(id("b"), { _tag: "End" }, "# b\n").pipe(Effect.timeout("3 seconds"))
      );
      assert.deepStrictEqual(
        {
          outcome: Result.isFailure(result) ? result.failure._tag : "succeeded",
          order: yield* orderOnDisk(deck.root),
        },
        { outcome: "LockFailed", order: ["cover"] }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});

describe("An interrupted edit", () => {
  /**
   * The real file system, except that the first call `matches` picks waits for `release` once it
   * has signalled `reached`, as a slow disk would hold it at that point.
   */
  const latched = (
    matches: (method: "rename" | "remove", target: string) => boolean,
    reached: Deferred.Deferred<void>,
    release: Deferred.Deferred<void>
  ) =>
    Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (real) => {
        let held = false;
        const hold = <A, E>(method: "rename" | "remove", target: string, call: Effect.Effect<A, E>) => {
          if (held || !matches(method, target)) {
            return call;
          }
          held = true;
          return Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(call)
          );
        };
        return FileSystem.make({
          ...real,
          rename: (from, to) => hold("rename", to, real.rename(from, to)),
          remove: (target, options) => hold("remove", target, real.remove(target, options)),
        });
      })
    ).pipe(Layer.provide(NodeServices.layer));

  /** A deck with `cover` and `a`, opened through the latched file system. */
  const latchedDeck = Effect.fnUntraced(function* (
    matches: (method: "rename" | "remove", target: string) => boolean
  ) {
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const created = yield* deckWith(["a"]);
    const deck = yield* Effect.service(DeckFiles).pipe(
      Effect.provide(
        DeckFiles.layerFrom(created.root).pipe(Layer.provide(latched(matches, reached, release)))
      )
    );
    return { deck, reached, release };
  });

  /** The order on disk and the slide files, as the test compares them. */
  const onDisk = (root: string) =>
    Effect.all({ order: orderOnDisk(root), files: slideFiles(root) }, { concurrency: 1 });

  it.effect.each([
    {
      name: "an add interrupted after its file, before deck.json",
      matches: (method: string, target: string) => method === "rename" && target.endsWith("deck.json"),
      edit: (deck: DeckFiles["Service"]) => deck.addSlide(id("b"), { _tag: "End" }, "# b\n"),
      // Oracle: the add as a whole, or nothing of it.
      allowed: [
        { order: ["cover", "a", "b"], files: ["a.mdx", "b.mdx", "cover.mdx"] },
        { order: ["cover", "a"], files: ["a.mdx", "cover.mdx"] },
      ],
    },
    {
      name: "a remove interrupted after deck.json, before the file goes",
      matches: (method: string, target: string) => method === "remove" && target.endsWith("a.mdx"),
      edit: (deck: DeckFiles["Service"]) => deck.removeSlide(id("a")),
      allowed: [
        { order: ["cover"], files: ["cover.mdx"] },
        { order: ["cover", "a"], files: ["a.mdx", "cover.mdx"] },
      ],
    },
  ])("leaves no half of $name", ({ matches, edit, allowed }) =>
    Effect.gen(function* () {
      const { deck, reached, release } = yield* latchedDeck(matches);
      const fiber = yield* Effect.forkChild(edit(deck));
      yield* Deferred.await(reached);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);
      const state = yield* onDisk(deck.root);
      assert.isTrue(
        allowed.some(
          (each) =>
            each.order.join(",") === state.order.join(",") && each.files.join(",") === state.files.join(",")
        ),
        `order ${state.order.join(",")}; files ${state.files.join(",")}`
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  /** The real file system, except that removing a path ending in `failing` fails, as a busy file does. */
  const failingRemoveOf = (failing: string) =>
    Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (real) =>
        FileSystem.make({
          ...real,
          remove: (target, options) =>
            target.endsWith(failing)
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: target,
                  })
                )
              : real.remove(target, options),
        })
      )
    ).pipe(Layer.provide(NodeServices.layer));

  it.effect("takes the new file back out when deck.json cannot be written, so a retry succeeds", () =>
    Effect.gen(function* () {
      const created = yield* deckWith(["a"]);
      // deck.json is written to a temporary file first, `deck.json.<uuid>.tmp`; that write fails.
      const failingManifest = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (real) =>
          FileSystem.make({
            ...real,
            writeFile: (target, data, options) =>
              path.basename(target).startsWith("deck.json.")
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "writeFile",
                      description: "no space left on device",
                      pathOrDescriptor: target,
                    })
                  )
                : real.writeFile(target, data, options),
          })
        )
      ).pipe(Layer.provide(NodeServices.layer));
      const failing = yield* Effect.service(DeckFiles).pipe(
        Effect.provide(DeckFiles.layerFrom(created.root).pipe(Layer.provide(failingManifest)))
      );
      const result = yield* Effect.result(failing.addSlide(id("b"), { _tag: "End" }, "# b\n"));
      const after = yield* onDisk(created.root);
      const retried = yield* created
        .addSlide(id("b"), { _tag: "End" }, "# b\n")
        .pipe(Effect.map((manifest): string[] => [...manifest.order]));
      assert.deepStrictEqual(
        { outcome: Result.isFailure(result) ? result.failure._tag : "succeeded", after, retried },
        {
          outcome: "DeckIoFailed",
          after: { order: ["cover", "a"], files: ["a.mdx", "cover.mdx"] },
          retried: ["cover", "a", "b"],
        }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("puts the order back when the slide's file cannot be deleted", () =>
    Effect.gen(function* () {
      const created = yield* deckWith(["a"]);
      const failing = yield* Effect.service(DeckFiles).pipe(
        Effect.provide(DeckFiles.layerFrom(created.root).pipe(Layer.provide(failingRemoveOf("a.mdx"))))
      );
      const result = yield* Effect.result(failing.removeSlide(id("a")));
      assert.deepStrictEqual(
        {
          outcome: Result.isFailure(result) ? result.failure._tag : "succeeded",
          after: yield* onDisk(created.root),
        },
        { outcome: "DeckIoFailed", after: { order: ["cover", "a"], files: ["a.mdx", "cover.mdx"] } }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("stops waiting for the lock when interrupted, and a retry with the same id then succeeds", () =>
    Effect.gen(function* () {
      const created = yield* deckWith([]);
      const lock = path.join(created.root, ".fuse-deck.lock");
      // A live holder: this process, under another edit's token.
      yield* Effect.promise(() => writeFile(lock, `{"pid":${String(process.pid)},"token":"another-edit"}`));
      // The edit has found the live holder once it reads the lock's record.
      const waiting = yield* Deferred.make<void>();
      const watching = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (real) =>
          FileSystem.make({
            ...real,
            readFile: (file) =>
              file === lock
                ? Effect.andThen(Deferred.succeed(waiting, undefined), real.readFile(file))
                : real.readFile(file),
          })
        )
      ).pipe(Layer.provide(NodeServices.layer));
      const deck = yield* Effect.service(DeckFiles).pipe(
        Effect.provide(DeckFiles.layerFrom(created.root).pipe(Layer.provide(watching)))
      );
      const fiber = yield* Effect.forkChild(deck.addSlide(id("b"), { _tag: "End" }, "# b\n"));
      yield* Deferred.await(waiting);
      const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.timeoutOption("1 second"));
      yield* Effect.promise(() => rm(lock));
      const retried = yield* deck
        .addSlide(id("b"), { _tag: "End" }, "# b\n")
        .pipe(Effect.map((manifest): string[] => [...manifest.order]));
      assert.deepStrictEqual(
        { stopped: Option.isSome(interrupted), retried },
        { stopped: true, retried: ["cover", "b"] }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
