/**
 * The deck tools: the CLI's commands as MCP tools, one to one, for an agent that edits a deck.
 * Each tool runs the same operation as its command and returns the same JSON document, and a
 * failure returns the command's failure document (`_tag`, `message`, usually `hint`) as an error
 * result.
 *
 * The tools read the deck per request: `DeckFiles` and `Bundler` are request-level dependencies,
 * so a host decides which deck each call reaches. `fuse-deck mcp` serves one deck with
 * `servingDeck`; the studio resolves the deck a session opened.
 */

import * as McpServer from "effect/ai/McpServer";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Bundler, BundlerFailed } from "../bundler/bundler.ts";
import { FuseThemeUnavailable, InvalidTheme } from "../bundler/fuse-theme.ts";
import { DeckCheckFailed } from "../deck/check.ts";
import { DeckFiles, DeckIoFailed, SlideFileExists } from "../deck/deck-files.ts";
import {
  DeckManifestInvalid,
  SlideAnchoredToItself,
  SlideIdTaken,
  SlideNotInDeck,
} from "../deck/deck-manifest.ts";
import {
  addSlide,
  checkDeckDocument,
  DeckChecked,
  listSlides,
  moveSlide,
  removeSlide,
  SlideAdded,
  SlideList,
  SlideMoved,
  SlideRemoved,
} from "../deck/deck-operations.ts";
import { DeckVocabulary, describeDeck } from "../deck/describe.ts";
import { LockFailed, LockHeld, LockNeedsRecovery } from "../deck/file-lock.ts";
import { SlideId } from "../deck/slide-id.ts";
import * as Vocabulary from "../deck/vocabulary.ts";

/** What a deck tool can fail with: the domain failures of the commands it mirrors. */
const DeckToolFailure = Schema.Union([
  DeckManifestInvalid,
  DeckIoFailed,
  LockHeld,
  LockNeedsRecovery,
  LockFailed,
  SlideIdTaken,
  SlideNotInDeck,
  SlideFileExists,
  SlideAnchoredToItself,
  DeckCheckFailed,
  InvalidTheme,
  FuseThemeUnavailable,
  BundlerFailed,
]);

const slideId = (description: string) => SlideId.annotate({ description });

const Describe = Tool.make("describe", {
  description:
    "Get the deck vocabulary: every layout, the components a slide can use without an import, the frontmatter keys, the deck.json settings and the commands, plus the path of the skill that explains how to write a deck. Call it once before writing the first slide. Returns a DeckVocabulary document.",
  success: DeckVocabulary,
})
  .annotate(Tool.Title, "Describe the deck vocabulary")
  .annotate(Tool.Readonly, true);

const SlidesList = Tool.make("slides_list", {
  description:
    "List the deck's slides in order, each with its id, its file (slides/<id>.mdx, relative to the deck), its title and its layout. A slide that does not compile has a null title and layout; run check to see why. Returns a SlideList document.",
  success: SlideList,
  failure: DeckToolFailure,
  failureMode: "return",
  dependencies: [DeckFiles],
})
  .annotate(Tool.Title, "List the slides")
  .annotate(Tool.Readonly, true);

const SlidesAdd = Tool.make("slides_add", {
  description:
    "Create slides/<id>.mdx with a first heading and add the slide to deck.json's order. Use it for every new slide, then write the slide's content in its file. Returns a SlideAdded document with the file and the new order.",
  parameters: Schema.Struct({
    id: slideId("The new slide's id: lowercase letters, digits and dashes, such as how-it-works."),
    after: Schema.optionalKey(slideId("Put the new slide after this one. Default: at the end.")),
    layout: Schema.optionalKey(
      Schema.Literals(Vocabulary.LAYOUT_NAMES).annotate({
        description: `The slide's layout. Default: ${Vocabulary.DEFAULT_LAYOUT}.`,
      })
    ),
    title: Schema.optionalKey(
      Schema.String.annotate({ description: "The slide's first heading. Default: the id in words." })
    ),
  }),
  success: SlideAdded,
  failure: DeckToolFailure,
  failureMode: "return",
  dependencies: [DeckFiles],
})
  .annotate(Tool.Title, "Add a slide")
  .annotate(Tool.Destructive, false);

const SlidesMove = Tool.make("slides_move", {
  description:
    "Move a slide in deck.json's order, after or before another slide. Pass exactly one of after and before. Returns a SlideMoved document with the new order.",
  parameters: Schema.Struct({
    id: slideId("The slide to move."),
    after: Schema.optionalKey(slideId("Move it after this slide.")),
    before: Schema.optionalKey(slideId("Move it before this slide.")),
  }).check(
    Schema.makeFilter((move) =>
      (move.after === undefined) !== (move.before === undefined)
        ? undefined
        : "Pass exactly one of after and before."
    )
  ),
  success: SlideMoved,
  failure: DeckToolFailure,
  failureMode: "return",
  dependencies: [DeckFiles],
})
  .annotate(Tool.Title, "Move a slide")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const SlidesRemove = Tool.make("slides_remove", {
  description:
    "Take a slide out of deck.json's order and delete its file. The slide's content is gone afterwards. Returns a SlideRemoved document with the deleted file and the new order.",
  parameters: Schema.Struct({ id: slideId("The slide to remove.") }),
  success: SlideRemoved,
  failure: DeckToolFailure,
  failureMode: "return",
  dependencies: [DeckFiles],
}).annotate(Tool.Title, "Remove a slide");

const Check = Tool.make("check", {
  description:
    "Check the deck: ids in the order without a file, slide files the order does not name, invalid frontmatter, slides that do not compile, and a theme Fuse does not know. Run it after each round of edits. Returns a DeckChecked document, or an error result whose DeckCheckFailed document lists every problem with a hint.",
  success: DeckChecked,
  failure: DeckToolFailure,
  failureMode: "return",
  dependencies: [DeckFiles, Bundler],
})
  .annotate(Tool.Title, "Check the deck")
  .annotate(Tool.Readonly, true);

/** The six deck tools. */
export const DeckTools = Toolkit.make(Describe, SlidesList, SlidesAdd, SlidesMove, SlidesRemove, Check);

/**
 * The deck tools' handlers.
 *
 * @param skill - The absolute path of the skill the host ships, which `describe` names.
 * @returns A layer of every tool's handler. Each handler reads `DeckFiles`, and `check` also
 *   `Bundler`, from the request.
 */
export function deckToolHandlers(skill: string) {
  return DeckTools.toLayer({
    describe: () => Effect.succeed(describeDeck(skill)),
    slides_list: () => listSlides(),
    slides_add: ({ id, after, layout, title }) =>
      addSlide({
        id,
        after: Option.fromUndefinedOr(after),
        layout: Option.fromUndefinedOr(layout),
        title: Option.fromUndefinedOr(title),
      }),
    slides_move: ({ id, after, before }) =>
      after !== undefined
        ? moveSlide(id, { _tag: "After", anchor: after })
        : before !== undefined
          ? moveSlide(id, { _tag: "Before", anchor: before })
          : Effect.die("The parameters' check lets only a move with one anchor through."),
    slides_remove: ({ id }) => removeSlide(id),
    check: () => checkDeckDocument(),
  });
}

/**
 * MCP middleware that gives every deck tool call the one deck the host serves: the `DeckFiles`
 * and `Bundler` its layer was built with.
 */
export const servingDeck = McpServer.middleware<{ provides: DeckFiles | Bundler }>()(
  Effect.gen(function* () {
    const deck = yield* DeckFiles;
    const bundler = yield* Bundler;
    return (effect) =>
      effect.pipe(Effect.provideService(DeckFiles, deck), Effect.provideService(Bundler, bundler));
  })
);

/**
 * The deck tools registered with an `McpServer`, every call reaching the deck the layer is built
 * with.
 *
 * @param skill - The absolute path of the skill the host ships.
 * @returns A registration layer that needs `DeckFiles` and `Bundler`.
 */
export function deckToolsForDeck(skill: string) {
  return McpServer.toolkit(DeckTools).pipe(
    Layer.provide(servingDeck.layer),
    Layer.provide(deckToolHandlers(skill))
  );
}
