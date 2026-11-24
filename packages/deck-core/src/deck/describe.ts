/**
 * The `describe` document: the whole vocabulary a deck author can write, and where the skill sits.
 * The skill ships with the host, so the host passes its path.
 */

import * as Vocabulary from "./vocabulary.ts";

/** The `DeckVocabulary` document `describe` prints. */
export type DeckVocabularyDocument = {
  readonly _tag: "DeckVocabulary";
  /** The absolute path of the skill the host ships. */
  readonly skill: string;
  readonly layouts: ReadonlyArray<{ readonly name: string; readonly summary: string }>;
  readonly defaultLayout: Vocabulary.LayoutName;
  readonly frontmatter: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly summary: string;
  }>;
  readonly components: ReadonlyArray<{
    readonly name: string;
    readonly usage: string;
    readonly summary: string;
  }>;
  readonly deck: ReadonlyArray<{ readonly name: string; readonly type: string; readonly summary: string }>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly summary: string }>;
  readonly commands: ReadonlyArray<{ readonly usage: string; readonly summary: string }>;
};

/**
 * Describe the deck vocabulary.
 *
 * @param skill - The absolute path of the skill the host ships.
 * @returns The `DeckVocabulary` document.
 */
export function describeDeck(skill: string): DeckVocabularyDocument {
  return {
    _tag: "DeckVocabulary",
    skill,
    layouts: Vocabulary.LAYOUTS.map(({ name, summary }) => ({ name, summary })),
    defaultLayout: Vocabulary.DEFAULT_LAYOUT,
    frontmatter: Vocabulary.FRONTMATTER_FIELDS.map(({ name, type, summary }) => ({ name, type, summary })),
    components: Vocabulary.COMPONENTS.map(({ name, usage, summary }) => ({ name, usage, summary })),
    deck: Vocabulary.DECK_FIELDS.map(({ name, type, summary }) => ({ name, type, summary })),
    files: Vocabulary.FILES.map(({ path, summary }) => ({ path, summary })),
    commands: Vocabulary.VERBS.map(({ usage, summary }) => ({ usage, summary })),
  };
}
