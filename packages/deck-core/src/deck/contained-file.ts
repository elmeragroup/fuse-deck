/**
 * A deck is untrusted input, and it is self-contained, so it holds no symbolic links: a link has no
 * use in a deck, and each one is a way out of it. A deck path is accepted only when it resolves to
 * itself, with no link in any of its components below the deck's root, and names the expected kind
 * of entry, a regular file or a directory. A path lexically under the root, or one whose real path
 * lies inside it, is not enough.
 *
 * `findDeckLink` checks a whole deck when it opens. `deckEntry` checks one path at each use, so a
 * link made after the deck opened is refused too. Both forms exist: a synchronous one for Vite's
 * hooks and middleware, and one through the `FileSystem` service for the deck's services. They
 * share `deckComponents` and `refusal`, so they decide alike.
 */

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { lstatSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

/** The kinds of entry a deck holds. */
export type DeckEntryKind = "File" | "Directory";

/** An accepted deck path. Read and write through `real`, the path that was checked. */
export type DeckEntry = {
  readonly _tag: "DeckEntry";
  /** The path under the deck's real root. With no link in it, it is the entry's real path. */
  readonly real: string;
  readonly kind: DeckEntryKind;
};

/** Why a deck path was refused. */
export type DeckPathRefused =
  | { readonly _tag: "Missing"; readonly file: string }
  | { readonly _tag: "OutsideDeck"; readonly file: string }
  | { readonly _tag: "Link"; readonly file: string; readonly link: string }
  | { readonly _tag: "WrongKind"; readonly file: string; readonly expected: ReadonlyArray<DeckEntryKind> };

/** Directories a whole-deck check skips, by name: version control and installed packages. */
export const UNCHECKED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

/**
 * Whether `real` is `root` or lies under it. Both must be canonical paths.
 *
 * @param root - The canonical directory.
 * @param real - The canonical path to test.
 * @returns Whether `real` is inside `root`.
 */
export function isInside(root: string, real: string): boolean {
  const relative = path.relative(root, real);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The components of `file` below the deck's root, when it lies under the root as given or under its
 * real path. Vite names a deck file in either spelling, so both count.
 *
 * @param root - The deck's root as given, absolute.
 * @param realRoot - The root's real path.
 * @param file - An absolute path, or one relative to the root.
 * @returns The components, none for the root itself, or none at all when the path is outside.
 */
export function deckComponents(
  root: string,
  realRoot: string,
  file: string
): Option.Option<ReadonlyArray<string>> {
  const absolute = path.resolve(root, file);
  for (const base of [realRoot, path.resolve(root)]) {
    if (isInside(base, absolute)) {
      return Option.some(
        path
          .relative(base, absolute)
          .split(path.sep)
          .filter((part) => part !== "")
      );
    }
  }
  return Option.none();
}

/** What an entry's link-free stat says it is. */
type EntryType = DeckEntryKind | "Link" | "Other";

function entryTypeOf(stats: Stats): EntryType {
  if (stats.isSymbolicLink()) {
    return "Link";
  }
  if (stats.isFile()) {
    return "File";
  }
  return stats.isDirectory() ? "Directory" : "Other";
}

function entryTypeOfInfo(info: FileSystem.File.Info): EntryType {
  switch (info.type) {
    case "SymbolicLink":
      return "Link";
    case "File":
    case "Directory":
      return info.type;
    default:
      return "Other";
  }
}

/**
 * The verdict on a path from the types of its components, walked from the root. `types` holds one
 * type per component for as long as they exist; a shorter list means the rest are missing.
 */
function verdict(
  file: string,
  realRoot: string,
  parts: ReadonlyArray<string>,
  types: ReadonlyArray<EntryType>,
  accept: ReadonlyArray<DeckEntryKind>
): DeckEntry | DeckPathRefused {
  for (const [index, type] of types.entries()) {
    if (type === "Link") {
      return { _tag: "Link", file, link: path.join(realRoot, ...parts.slice(0, index + 1)) };
    }
    if (index < parts.length - 1 && type !== "Directory") {
      return { _tag: "WrongKind", file, expected: ["Directory"] };
    }
  }
  if (types.length < parts.length) {
    return { _tag: "Missing", file };
  }
  const kind: EntryType = types.at(-1) ?? "Directory";
  return kind === "File" || kind === "Directory"
    ? accept.includes(kind)
      ? { _tag: "DeckEntry", real: path.join(realRoot, ...parts), kind }
      : { _tag: "WrongKind", file, expected: accept }
    : { _tag: "WrongKind", file, expected: accept };
}

/**
 * Check `file` as a deck path, synchronously.
 *
 * @param root - The deck's root.
 * @param file - An absolute path, or one relative to the root.
 * @param accept - The kinds of entry the caller takes.
 * @returns The entry, or why the path is refused.
 */
export function deckEntrySync(
  root: string,
  file: string,
  accept: ReadonlyArray<DeckEntryKind>
): DeckEntry | DeckPathRefused {
  const absolute = path.resolve(root, file);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { _tag: "Missing", file: absolute };
  }
  const parts = deckComponents(root, realRoot, absolute);
  if (Option.isNone(parts)) {
    return { _tag: "OutsideDeck", file: absolute };
  }
  const types: EntryType[] = [];
  let current = realRoot;
  for (const part of parts.value) {
    current = path.join(current, part);
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch {
      break;
    }
    const type = entryTypeOf(stats);
    types.push(type);
    if (type !== "Directory") {
      break;
    }
  }
  return verdict(absolute, realRoot, parts.value, types, accept);
}

/**
 * Check `file` as a deck path through the `FileSystem` service.
 *
 * @param fs - The file system.
 * @param root - The deck's root.
 * @param file - An absolute path, or one relative to the root.
 * @param accept - The kinds of entry the caller takes.
 * @returns The entry, or why the path is refused. A failed stat other than a missing entry fails.
 */
export const deckEntry = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  root: string,
  file: string,
  accept: ReadonlyArray<DeckEntryKind>
) {
  const absolute = path.resolve(root, file);
  const realRoot = yield* fs.realPath(root);
  const parts = deckComponents(root, realRoot, absolute);
  if (Option.isNone(parts)) {
    return { _tag: "OutsideDeck", file: absolute } satisfies DeckPathRefused;
  }
  const types: EntryType[] = [];
  let current = realRoot;
  for (const part of parts.value) {
    current = path.join(current, part);
    const info = yield* fs.lstat(current).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone
      )
    );
    if (Option.isNone(info)) {
      break;
    }
    const type = entryTypeOfInfo(info.value);
    types.push(type);
    if (type !== "Directory") {
      break;
    }
  }
  return verdict(absolute, realRoot, parts.value, types, accept);
});

/** A link or special file a whole-deck check found. */
export type DeckLink = { readonly _tag: "Link" | "SpecialFile"; readonly file: string };

/**
 * The first link or special file in the deck, outside `UNCHECKED_DIRECTORIES`, in a depth-first walk
 * in name order; none when every entry is a regular file or a directory.
 *
 * @param fs - The file system.
 * @param root - The deck's root.
 * @returns The entry, by its path under the root as given.
 */
export const findDeckLink = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, root: string) {
  const walk = (directory: string): Effect.Effect<Option.Option<DeckLink>, never> =>
    fs.readDirectoryEntries(directory).pipe(
      Effect.orElseSucceed((): ReadonlyArray<FileSystem.DirectoryEntry> => []),
      Effect.flatMap((entries) =>
        Effect.gen(function* () {
          for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(directory, entry.name);
            switch (entry.type) {
              case "SymbolicLink":
                return Option.some<DeckLink>({ _tag: "Link", file });
              case "File":
                continue;
              case "Directory": {
                if (UNCHECKED_DIRECTORIES.has(entry.name)) {
                  continue;
                }
                const found = yield* walk(file);
                if (Option.isSome(found)) {
                  return found;
                }
                continue;
              }
              default:
                return Option.some<DeckLink>({ _tag: "SpecialFile", file });
            }
          }
          return Option.none<DeckLink>();
        })
      )
    );
  return yield* walk(path.resolve(root));
});

/**
 * A sentence that says why a path was refused, for a log or an error document.
 *
 * @param refused - The refusal.
 * @returns The sentence.
 */
export function describeRefusal(refused: DeckPathRefused): string {
  switch (refused._tag) {
    case "Missing":
      return `${refused.file} does not exist.`;
    case "OutsideDeck":
      return `${refused.file} is outside the deck.`;
    case "Link":
      return `${refused.link} is a symbolic link, and a deck holds none.`;
    case "WrongKind":
      return `${refused.file} is not ${refused.expected.map((kind) => (kind === "File" ? "a regular file" : "a directory")).join(" or ")}.`;
  }
}
