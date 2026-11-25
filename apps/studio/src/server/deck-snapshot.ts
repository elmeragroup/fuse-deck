/**
 * The deck files a turn can change, read whole: `deck.json` and every `slides/*.mdx`. The chat
 * snapshots them when a turn starts, and the Changes tab compares that snapshot with the disk.
 * A deck is untrusted and holds no symbolic links: a file is read only when its path passes
 * deck-core's deck-path check, a regular file with no link in it, so a link made after the deck
 * opened reads nothing, inside the deck or out.
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { deckEntry } from "@elmeragroup/deck-core/deck/contained-file";

import type { ObservedChange } from "../contract/agent-chat.ts";

/** The deck's text files, by path relative to the deck directory. */
export type DeckSnapshot = ReadonlyMap<string, string>;

/**
 * Read `deck.json` and every `slides/*.mdx` under `root`; a file that cannot be read, or that is
 * no regular file inside the deck, is left out.
 */
export const readDeckSnapshot = Effect.fn("readDeckSnapshot")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  /** The text of `relative`, read through its checked path once that is a regular file. */
  const readContained = Effect.fnUntraced(function* (relative: string) {
    const entry = yield* deckEntry(fs, root, relative, ["File"]);
    return entry._tag === "DeckEntry"
      ? Option.some(yield* fs.readFileString(entry.real))
      : Option.none<string>();
  });
  const slidesDirectory = yield* deckEntry(fs, root, "slides", ["Directory"]).pipe(
    Effect.orElseSucceed(() => ({ _tag: "Missing", file: "slides" }) as const)
  );
  const slides =
    slidesDirectory._tag === "DeckEntry"
      ? yield* fs
          .readDirectory(slidesDirectory.real)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
      : [];
  const paths = [
    "deck.json",
    ...slides.filter((name) => name.endsWith(".mdx")).map((name) => `slides/${name}`),
  ];
  const read = yield* Effect.forEach(
    paths,
    (relative) =>
      readContained(relative).pipe(
        Effect.map((text): ReadonlyArray<readonly [string, string]> =>
          Option.match(text, { onNone: () => [], onSome: (value) => [[relative, value]] })
        ),
        Effect.orElseSucceed((): ReadonlyArray<readonly [string, string]> => [])
      ),
    { concurrency: 8 }
  );
  const snapshot: DeckSnapshot = new Map(read.flat());
  return snapshot;
});

/** The files whose text differs between `before` and `after`, in path order. */
export function diffSnapshots(before: DeckSnapshot, after: DeckSnapshot): ReadonlyArray<ObservedChange> {
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted((a, b) => a.localeCompare(b));
  return paths.flatMap((relative) => {
    const old = before.get(relative) ?? null;
    const current = after.get(relative) ?? null;
    return old === current ? [] : [{ path: relative, before: old, after: current }];
  });
}
