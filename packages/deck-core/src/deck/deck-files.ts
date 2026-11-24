/**
 * A deck on disk: `deck.json` and `slides/<id>.mdx`. Every command reads the deck through this
 * service, and every edit of the order goes through it, so the files and the order stay
 * consistent.
 *
 * An edit holds the deck's lock from the read of `deck.json` through its last filesystem change.
 * `add` writes the slide file before `deck.json`, and `remove` writes `deck.json` before it
 * deletes the file, so a crash can leave an orphan file, which `check` reports, but never an id
 * without a file. `deck.json` is written to a temporary file and renamed into place.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { isInside } from "./contained-file.ts";
import * as DeckManifest from "./deck-manifest.ts";
import type { OrderPosition } from "./deck-manifest.ts";
import { holdLock } from "./file-lock.ts";
import type { LockFailed, LockHeld, LockNeedsRecovery } from "./file-lock.ts";
import { SlideId, slidePath } from "./slide-id.ts";

/** The manifest's file name in a deck directory. */
export const MANIFEST_FILE = "deck.json";

/** The directory that holds the slides. */
export const SLIDES_DIR = "slides";

const LOCK_FILE = ".fuse-deck.lock";

/** No `deck.json` in the directory or any directory above it. */
export class DeckNotFound extends Schema.TaggedError<DeckNotFound>()("DeckNotFound", {
  message: Schema.String,
  hint: Schema.String,
}) {}

/** A deck file could not be read or written. */
export class DeckIoFailed extends Schema.TaggedError<DeckIoFailed>()("DeckIoFailed", {
  message: Schema.String,
  path: Schema.String,
}) {}

/** `add` found a file for the new slide that the order does not hold. */
export class SlideFileExists extends Schema.TaggedError<SlideFileExists>()("SlideFileExists", {
  message: Schema.String,
  hint: Schema.String,
  id: Schema.String,
}) {}

/** One slide the order names. */
export type DeckSlide = {
  /** The slide's id. */
  readonly id: SlideId;
  /** The slide file's absolute path. */
  readonly file: string;
};

/** A deck as it stands on disk. */
export type LoadedDeck = {
  /** The deck directory. */
  readonly root: string;
  /** `deck.json`, decoded. */
  readonly manifest: DeckManifest.DeckManifest;
  /** The slides in order, each with the file it should have. */
  readonly slides: readonly DeckSlide[];
  /** Ids in the order whose file is missing. */
  readonly dangling: readonly SlideId[];
  /** `.mdx` files in `slides/`, relative to the deck, that the order does not name. */
  readonly orphans: readonly string[];
};

/** What an edit of a deck can fail with. */
export type DeckEditError =
  | DeckManifest.DeckManifestInvalid
  | DeckIoFailed
  | LockHeld
  | LockNeedsRecovery
  | LockFailed;

/** Reads a deck and edits its order and slide files. */
export class DeckFiles extends Context.Service<
  DeckFiles,
  {
    /** The deck directory. */
    readonly root: string;

    /** Read the manifest and list the slide files. */
    readonly load: Effect.Effect<LoadedDeck, DeckManifest.DeckManifestInvalid | DeckIoFailed>;

    /** Read a slide file's text. */
    readonly readSlide: (id: SlideId) => Effect.Effect<string, DeckIoFailed>;

    /**
     * Create a slide file with `text` and add the slide to the order. The file is created
     * exclusively, so an orphan file with the same id stays as it is and fails the add.
     */
    readonly addSlide: (
      id: SlideId,
      position: OrderPosition,
      text: string
    ) => Effect.Effect<
      DeckManifest.DeckManifest,
      DeckEditError | DeckManifest.SlideIdTaken | DeckManifest.SlideNotInDeck | SlideFileExists
    >;

    /** Move a slide in the order. */
    readonly moveSlide: (
      id: SlideId,
      position: Exclude<OrderPosition, { readonly _tag: "End" }>
    ) => Effect.Effect<
      DeckManifest.DeckManifest,
      DeckEditError | DeckManifest.SlideNotInDeck | DeckManifest.SlideAnchoredToItself
    >;

    /** Take a slide out of the order, then delete its file. */
    readonly removeSlide: (
      id: SlideId
    ) => Effect.Effect<DeckManifest.DeckManifest, DeckEditError | DeckManifest.SlideNotInDeck>;
  }
>()("@elmeragroup/deck-core/DeckFiles") {
  /**
   * The deck in `start` or the nearest directory above it that holds a `deck.json`.
   *
   * @param start - The directory to search from, usually the working directory.
   * @returns A layer that fails with `DeckNotFound` when no directory up to the root holds a deck.
   */
  static readonly layerFrom = (start: string) =>
    Layer.effect(
      DeckFiles,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* findDeckRoot(fs, path.resolve(start));
        return makeDeckFiles(fs, root);
      })
    );
}

function findDeckRoot(
  fs: FileSystem.FileSystem,
  start: string
): Effect.Effect<string, DeckNotFound | DeckIoFailed> {
  return Effect.gen(function* () {
    for (let directory = start; ; directory = path.dirname(directory)) {
      const manifest = path.join(directory, MANIFEST_FILE);
      if (yield* fs.exists(manifest).pipe(Effect.mapError(ioFailed(manifest)))) {
        return directory;
      }
      if (path.dirname(directory) === directory) {
        return yield* new DeckNotFound({
          message: `No ${MANIFEST_FILE} in ${start} or any directory above it.`,
          hint: "Run the command inside a deck, or create one with `fuse-deck create <dir>`.",
        });
      }
    }
  });
}

function ioFailed(file: string) {
  return (error: PlatformError.PlatformError) =>
    new DeckIoFailed({ message: `Could not access ${file}: ${error.message}`, path: file });
}

const isSlideId = Schema.is(SlideId);

function makeDeckFiles(fs: FileSystem.FileSystem, root: string): DeckFiles["Service"] {
  const manifestFile = path.join(root, MANIFEST_FILE);
  const slidesDir = path.join(root, SLIDES_DIR);
  const slideFile = (id: SlideId) => path.join(root, slidePath(id));

  /**
   * The real path of `file` once it is an entry of `type` inside the deck. A deck is untrusted,
   * and a symlinked slide, manifest or slides directory must not reach a file outside it. Callers
   * read and write through the path this returns, the one that was checked.
   */
  const containedPath = Effect.fnUntraced(function* (file: string, type: "File" | "Directory") {
    const realRoot = yield* fs.realPath(root);
    const real = yield* fs.realPath(file);
    const info = yield* fs.stat(real);
    if (!isInside(realRoot, real) || info.type !== type) {
      return yield* new DeckIoFailed({
        message: `${file} resolves to ${real}, which is not a ${type === "File" ? "file" : "directory"} inside the deck.`,
        path: file,
      });
    }
    return real;
  });

  /** The text of `file`, read through its contained real path. */
  const readContained = (file: string) =>
    containedPath(file, "File").pipe(
      Effect.flatMap((real) => fs.readFileString(real)),
      Effect.mapError((error) => (error._tag === "PlatformError" ? ioFailed(file)(error) : error))
    );

  /** The slides directory's real path, once it is a directory inside the deck. */
  const containedSlidesDir = containedPath(slidesDir, "Directory").pipe(
    Effect.mapError((error) => (error._tag === "PlatformError" ? ioFailed(slidesDir)(error) : error))
  );

  /**
   * The entry `removeSlide` deletes: the slide's name in the slides directory's real path, once
   * the slides directory is inside the deck and the name, if it resolves at all, resolves to a
   * regular file inside it. None when there is no slides directory. The name itself is deleted,
   * never what it resolves to, so a link to another slide leaves that slide.
   */
  const removableSlide = Effect.fnUntraced(function* (id: SlideId) {
    if (!(yield* fs.exists(slidesDir).pipe(Effect.mapError(ioFailed(slidesDir))))) {
      return Option.none<string>();
    }
    const entry = path.join(yield* containedSlidesDir, path.basename(slideFile(id)));
    yield* containedPath(entry, "File").pipe(
      Effect.catchIf(
        (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
        () => Effect.void
      ),
      Effect.mapError((error) => (error._tag === "PlatformError" ? ioFailed(entry)(error) : error))
    );
    return Option.some(entry);
  });

  const readManifest = Effect.gen(function* () {
    const text = yield* readContained(manifestFile);
    return yield* Effect.fromResult(DeckManifest.parseManifest(text));
  });

  const writeManifest = (manifest: DeckManifest.DeckManifest) => {
    const temporary = `${manifestFile}.${randomUUID()}.tmp`;
    return Effect.gen(function* () {
      yield* fs.writeFileString(temporary, DeckManifest.formatManifest(manifest));
      yield* fs.rename(temporary, manifestFile);
    }).pipe(
      Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(ioFailed(manifestFile))
    );
  };

  const slideFileNames = fs.readDirectory(slidesDir).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([])
    ),
    Effect.mapBoth({
      onFailure: ioFailed(slidesDir),
      onSuccess: (names) => names.filter((name) => name.endsWith(".mdx")).sort(),
    })
  );

  /** Run an edit with the deck's lock held from the read through the last write. */
  const locked = <A, E>(edit: Effect.Effect<A, E>) =>
    Effect.scoped(Effect.andThen(holdLock(path.join(root, LOCK_FILE)), edit)).pipe(
      Effect.provideService(FileSystem.FileSystem, fs)
    );

  return DeckFiles.of({
    root,

    load: Effect.gen(function* () {
      const manifest = yield* readManifest;
      const names = yield* slideFileNames;
      const ids = new Set<string>(manifest.order);
      const present = new Set(names.map((name) => name.slice(0, -".mdx".length)));
      return {
        root,
        manifest,
        slides: manifest.order.map((id) => ({ id, file: slideFile(id) })),
        dangling: manifest.order.filter((id) => !present.has(id)),
        orphans: names
          .filter((name) => {
            const id = name.slice(0, -".mdx".length);
            return !isSlideId(id) || !ids.has(id);
          })
          .map((name) => `${SLIDES_DIR}/${name}`),
      } satisfies LoadedDeck;
    }).pipe(Effect.withSpan("DeckFiles.load")),

    readSlide: (id) => readContained(slideFile(id)),

    addSlide: Effect.fn("DeckFiles.addSlide")(function* (id, position, text) {
      return yield* locked(
        Effect.gen(function* () {
          const next = yield* Effect.fromResult(DeckManifest.addSlide(yield* readManifest, id, position));
          yield* fs.makeDirectory(slidesDir, { recursive: true }).pipe(Effect.mapError(ioFailed(slidesDir)));
          // Create the file through the slides directory's real path, once it is inside the deck.
          const file = path.join(yield* containedSlidesDir, path.basename(slideFile(id)));
          yield* fs.writeFileString(file, text, { flag: "wx" }).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "AlreadyExists",
              () =>
                Effect.fail(
                  new SlideFileExists({
                    message: `${slidePath(id)} exists, but the deck's order does not name it.`,
                    hint: `It is an orphan. Delete it, or pick another id. \`fuse-deck check\` lists every orphan.`,
                    id,
                  })
                )
            ),
            Effect.mapError((error) => (error._tag === "PlatformError" ? ioFailed(file)(error) : error))
          );
          yield* writeManifest(next);
          return next;
        })
      );
    }),

    moveSlide: Effect.fn("DeckFiles.moveSlide")(function* (id, position) {
      return yield* locked(
        Effect.gen(function* () {
          const next = yield* Effect.fromResult(DeckManifest.moveSlide(yield* readManifest, id, position));
          yield* writeManifest(next);
          return next;
        })
      );
    }),

    removeSlide: Effect.fn("DeckFiles.removeSlide")(function* (id) {
      return yield* locked(
        Effect.gen(function* () {
          const next = yield* Effect.fromResult(DeckManifest.removeSlide(yield* readManifest, id));
          const file = yield* removableSlide(id);
          yield* writeManifest(next);
          yield* Option.match(file, {
            onNone: () => Effect.void,
            onSome: (entry) => fs.remove(entry, { force: true }).pipe(Effect.mapError(ioFailed(entry))),
          });
          return next;
        })
      );
    }),
  });
}
