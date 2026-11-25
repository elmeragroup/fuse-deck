/**
 * The deck commands every host runs: list, add, move and remove slides, and check the deck. The
 * CLI prints their documents with `--json`, and the deck tools return the same documents to an
 * agent over MCP, so each operation and its result schema live here once.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { compileSlide } from "../bundler/mdx.ts";
import { checkDeck } from "./check.ts";
import { DeckFiles } from "./deck-files.ts";
import type { OrderPosition } from "./deck-manifest.ts";
import { mdxText } from "./mdx-text.ts";
import { SlideId, slidePath } from "./slide-id.ts";
import * as Vocabulary from "./vocabulary.ts";
import type { LayoutName } from "./vocabulary.ts";

/** A layout name a slide can use. */
const Layout = Schema.Literals(Vocabulary.LAYOUT_NAMES);

/** The slide order after an edit. */
const Order = Schema.Array(SlideId);

/** `slides list`: the slides in order, each with its title and layout, or null when it does not compile. */
export const SlideList = Schema.TaggedStruct("SlideList", {
  slides: Schema.Array(
    Schema.Struct({
      id: SlideId,
      path: Schema.String,
      title: Schema.NullOr(Schema.String),
      layout: Schema.NullOr(Layout),
    })
  ),
});

/** `slides add`: the new slide's id and file, and the order that now holds it. */
export const SlideAdded = Schema.TaggedStruct("SlideAdded", {
  id: SlideId,
  path: Schema.String,
  order: Order,
});

/** `slides move`: the moved slide and the new order. */
export const SlideMoved = Schema.TaggedStruct("SlideMoved", {
  id: SlideId,
  order: Order,
});

/** `slides remove`: the removed slide, the file it deleted and the order without it. */
export const SlideRemoved = Schema.TaggedStruct("SlideRemoved", {
  id: SlideId,
  path: Schema.String,
  order: Order,
});

/** `check` found nothing wrong: the slide and step counts and the theme Fuse accepted. */
export const DeckChecked = Schema.TaggedStruct("DeckChecked", {
  slides: Schema.Finite,
  steps: Schema.Finite,
  theme: Schema.String,
});

/** What `slides add` creates. */
export type NewSlide = {
  /** The new slide's id. */
  readonly id: SlideId;
  /** The slide to put it after. None puts it at the end. */
  readonly after: Option.Option<SlideId>;
  /** Its layout. None leaves the default, which needs no frontmatter. */
  readonly layout: Option.Option<LayoutName>;
  /** Its first heading. None takes the id in words. */
  readonly title: Option.Option<string>;
};

/**
 * List the slides in order. A slide whose file is missing or does not compile is listed with a
 * null title and layout, so one broken slide does not hide the others.
 *
 * @returns The `SlideList` document.
 */
export const listSlides = Effect.fn("listSlides")(function* () {
  const deck = yield* DeckFiles;
  const loaded = yield* deck.load;
  const slides: Array<(typeof SlideList.Type)["slides"][number]> = [];
  for (const { id, file } of loaded.slides) {
    const metadata = loaded.dangling.includes(id)
      ? Option.none()
      : Option.map(
          Result.getSuccess(
            yield* Effect.result(compileSlide(id, file, yield* deck.readSlide(id), "production"))
          ),
          (slide) => slide.metadata
        );
    slides.push({
      id,
      path: slidePath(id),
      title: Option.getOrNull(Option.flatMap(metadata, (each) => each.title)),
      layout: Option.getOrNull(Option.map(metadata, (each) => each.layout)),
    });
  }
  return SlideList.make({ slides });
});

/**
 * Create `slides/<id>.mdx` with a first heading, and a layout in its frontmatter when one is
 * given, and add the slide to the order.
 *
 * @param slide - The slide to create.
 * @returns The `SlideAdded` document.
 */
export const addSlide = Effect.fn("addSlide")(function* (slide: NewSlide) {
  const deck = yield* DeckFiles;
  const position: OrderPosition = Option.match(slide.after, {
    onNone: () => ({ _tag: "End" }),
    onSome: (anchor) => ({ _tag: "After", anchor }),
  });
  const manifest = yield* deck.addSlide(slide.id, position, newSlideText(slide));
  return SlideAdded.make({ id: slide.id, path: slidePath(slide.id), order: manifest.order });
});

/**
 * Move a slide in the order.
 *
 * @param id - The slide to move.
 * @param position - The slide to put it after or before.
 * @returns The `SlideMoved` document.
 */
export const moveSlide = Effect.fn("moveSlide")(function* (
  id: SlideId,
  position: Exclude<OrderPosition, { readonly _tag: "End" }>
) {
  const deck = yield* DeckFiles;
  const manifest = yield* deck.moveSlide(id, position);
  return SlideMoved.make({ id, order: manifest.order });
});

/**
 * Take a slide out of the order, then delete its file.
 *
 * @param id - The slide to remove.
 * @returns The `SlideRemoved` document.
 */
export const removeSlide = Effect.fn("removeSlide")(function* (id: SlideId) {
  const deck = yield* DeckFiles;
  const manifest = yield* deck.removeSlide(id);
  return SlideRemoved.make({ id, path: slidePath(id), order: manifest.order });
});

/**
 * Check the deck, as `checkDeck` does, and report a clean deck as a document.
 *
 * @returns The `DeckChecked` document, or `DeckCheckFailed` listing every problem.
 */
export const checkDeckDocument = Effect.fn("checkDeckDocument")(function* () {
  const report = yield* checkDeck();
  return DeckChecked.make({ slides: report.slides, steps: report.steps, theme: report.theme });
});

/** A new slide's text: the layout's frontmatter when one is given, then its first heading. */
function newSlideText(slide: NewSlide): string {
  const heading = Option.getOrElse(slide.title, () => {
    const words = slide.id.split("-").join(" ");
    return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  });
  const frontmatter = Option.match(slide.layout, {
    onNone: () => "",
    onSome: (name) => `---\nlayout: ${name}\n---\n\n`,
  });
  return `${frontmatter}# ${mdxText(heading)}\n`;
}
