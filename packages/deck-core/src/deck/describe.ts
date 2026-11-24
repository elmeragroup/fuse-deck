/**
 * The `describe` document: the whole vocabulary a deck author can write, and where the skill sits.
 * The skill ships with the host, so the host passes its path.
 */

import * as Schema from "effect/Schema";

import * as Vocabulary from "./vocabulary.ts";

/** The `DeckVocabulary` document `describe` prints. */
export const DeckVocabulary = Schema.TaggedStruct("DeckVocabulary", {
  /** The absolute path of the skill the host ships. */
  skill: Schema.String,
  layouts: Schema.Array(Schema.Struct({ name: Schema.String, summary: Schema.String })),
  defaultLayout: Schema.Literals(Vocabulary.LAYOUT_NAMES),
  frontmatter: Schema.Array(
    Schema.Struct({ name: Schema.String, type: Schema.String, summary: Schema.String })
  ),
  components: Schema.Array(
    Schema.Struct({ name: Schema.String, usage: Schema.String, summary: Schema.String })
  ),
  deck: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String, summary: Schema.String })),
  files: Schema.Array(Schema.Struct({ path: Schema.String, summary: Schema.String })),
  commands: Schema.Array(Schema.Struct({ usage: Schema.String, summary: Schema.String })),
});

/** The `DeckVocabulary` document `describe` prints. */
export type DeckVocabularyDocument = typeof DeckVocabulary.Type;

/**
 * Describe the deck vocabulary.
 *
 * @param skill - The absolute path of the skill the host ships.
 * @returns The `DeckVocabulary` document.
 */
export function describeDeck(skill: string): DeckVocabularyDocument {
  return DeckVocabulary.make({
    skill,
    layouts: Vocabulary.LAYOUTS.map(({ name, summary }) => ({ name, summary })),
    defaultLayout: Vocabulary.DEFAULT_LAYOUT,
    frontmatter: Vocabulary.FRONTMATTER_FIELDS.map(({ name, type, summary }) => ({ name, type, summary })),
    components: Vocabulary.COMPONENTS.map(({ name, usage, summary }) => ({ name, usage, summary })),
    deck: Vocabulary.DECK_FIELDS.map(({ name, type, summary }) => ({ name, type, summary })),
    files: Vocabulary.FILES.map(({ path, summary }) => ({ path, summary })),
    commands: Vocabulary.VERBS.map(({ usage, summary }) => ({ usage, summary })),
  });
}
