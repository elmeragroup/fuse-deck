/**
 * What an editor reads and writes when it edits one slide's source: the revision that names the
 * bytes it opened, the conflict a save reports when those bytes changed, and the problem a saved
 * slide's compile found. Schemas only, with no Node API, so the studio's renderer can decode them.
 */

import * as Schema from "effect/Schema";

/** A slide file's bytes, hashed: two reads with the same revision read the same bytes. */
export const SlideRevision = Schema.String.pipe(Schema.brand("SlideRevision"));

/** A slide file's bytes, hashed. */
export type SlideRevision = typeof SlideRevision.Type;

/** A slide's source as an editor opened it. */
export const OpenedSlide = Schema.Struct({
  /** The file's text. */
  source: Schema.String,
  /** The revision of the bytes that text was decoded from. */
  revision: SlideRevision,
});

/** A slide's source as an editor opened it. */
export type OpenedSlide = typeof OpenedSlide.Type;

/** What a slide file holds on disk: its source and revision, or no file. */
export const DiskSlide = Schema.Union([
  Schema.TaggedStruct("Present", { source: Schema.String, revision: SlideRevision }),
  Schema.TaggedStruct("Missing", {}),
]);

/** What a slide file holds on disk. */
export type DiskSlide = typeof DiskSlide.Type;

/**
 * Why a saved slide does not render. A compile error that MDX located has a line; a frontmatter
 * problem has none.
 */
export const SlideProblem = Schema.Union([
  Schema.TaggedStruct("SlideCompileFailed", {
    message: Schema.String,
    hint: Schema.String,
    line: Schema.NullOr(Schema.Finite),
    column: Schema.NullOr(Schema.Finite),
  }),
  Schema.TaggedStruct("InvalidFrontmatter", { message: Schema.String, hint: Schema.String }),
]);

/** Why a saved slide does not render. */
export type SlideProblem = typeof SlideProblem.Type;

/** A saved slide: the revision of the bytes written, and the problem its compile found, if any. */
export const SavedSlide = Schema.Struct({
  revision: SlideRevision,
  problem: Schema.NullOr(SlideProblem),
});

/** A saved slide. */
export type SavedSlide = typeof SavedSlide.Type;

/**
 * A save found the slide file changed since the editor opened it, or gone, and wrote nothing.
 * `disk` is what the file holds now, so the editor can show it beside the draft.
 */
export class SlideConflict extends Schema.TaggedError<SlideConflict>()("SlideConflict", {
  message: Schema.String,
  id: Schema.String,
  disk: DiskSlide,
}) {}

/** The order names the slide, but its file does not exist. */
export class SlideFileMissing extends Schema.TaggedError<SlideFileMissing>()("SlideFileMissing", {
  message: Schema.String,
  hint: Schema.String,
  id: Schema.String,
}) {}
