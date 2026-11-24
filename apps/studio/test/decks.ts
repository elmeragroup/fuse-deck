/**
 * Fixture decks for the studio's tests, written fresh into a directory each test owns. Each slide
 * is a heading only, so a deck opens without any optimizer work beyond React.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/** A deck to write: its title and its slides' ids in order. */
export type FixtureDeck = {
  readonly title: string;
  readonly slides: ReadonlyArray<string>;
};

/** Deck A, three slides. */
export const DECK_A: FixtureDeck = { title: "Deck A", slides: ["a-one", "a-two", "a-three"] };

/** Deck B, three slides. */
export const DECK_B: FixtureDeck = { title: "Deck B", slides: ["b-one", "b-two", "b-three"] };

/** The slide heading a fixture slide renders: its id, with dashes as spaces, capitalized. */
export function slideTitle(id: string): string {
  const words = id.replaceAll("-", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * Write `deck` into `directory`.
 *
 * @returns The deck directory.
 */
export async function writeDeck(directory: string, deck: FixtureDeck): Promise<string> {
  await mkdir(path.join(directory, "slides"), { recursive: true });
  await writeFile(
    path.join(directory, "deck.json"),
    `${JSON.stringify({ title: deck.title, theme: "neutral-elma-private", density: "comfortable", aspect: "16:9", order: deck.slides }, null, 2)}\n`
  );
  for (const id of deck.slides) {
    await writeFile(path.join(directory, "slides", `${id}.mdx`), `# ${slideTitle(id)}\n`);
  }
  return directory;
}

/** deck-core's built runtime, which turbo builds before these tests. */
export const DECK_RUNTIME = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@elmeragroup/deck-core/package.json")),
  "dist",
  "runtime"
);
