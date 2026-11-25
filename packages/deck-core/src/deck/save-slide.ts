/**
 * `saveSlide`: an editor's save of one slide's source, with optimistic conflict detection and an
 * atomic replace, then a compile of the saved text that reports its problem.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { Bundler } from "../bundler/bundler.ts";
import type { CompiledSlide, SlideCompileFailed } from "../bundler/mdx.ts";
import { DeckFiles } from "./deck-files.ts";
import type { SavedSlide, SlideProblem, SlideRevision } from "./slide-edit.ts";
import type { SlideId } from "./slide-id.ts";
import type { SlideFrontmatterInvalid } from "./slide-source.ts";

/**
 * Save a slide's source over the revision the editor opened.
 *
 * The guarantee: it detects an external change already on disk when the check runs, and it never
 * leaves a half-written slide. A direct write landing between the check and the rename is not
 * detected; agents write directly and take no lock.
 *
 * Under the deck lock it checks that the order names the slide and that its bytes still hash to
 * `expected` (or that there is no file, when `expected` is null), then writes a unique temporary
 * file beside the slide and renames it over the slide. A lock it cannot take within the usual wait
 * fails with `LockHeld`; a changed or deleted file fails with `SlideConflict` and writes nothing.
 * After the write, outside the lock, it compiles the saved text. Invalid MDX still saves: the
 * compile's failure comes back as the `problem`.
 *
 * @param id - The slide.
 * @param expected - The revision the editor opened, or null to expect no file.
 * @param source - The text to save.
 * @returns The revision written and the compile's problem, or null when the slide compiles.
 */
export const saveSlide = Effect.fn("saveSlide")(function* (
  id: SlideId,
  expected: SlideRevision | null,
  source: string
) {
  const files = yield* DeckFiles;
  const bundler = yield* Bundler;
  const revision = yield* files.replaceSlide(id, expected, source);
  const compiled = yield* Effect.result(bundler.compile(id, source));
  return { revision, problem: problemOf(compiled) } satisfies SavedSlide;
});

function problemOf(
  compiled: Result.Result<CompiledSlide, SlideCompileFailed | SlideFrontmatterInvalid>
): SlideProblem | null {
  if (Result.isSuccess(compiled)) {
    return null;
  }
  const { failure } = compiled;
  if (failure._tag === "SlideFrontmatterInvalid") {
    return { _tag: "InvalidFrontmatter", message: failure.message, hint: failure.hint };
  }
  return {
    _tag: "SlideCompileFailed",
    message: failure.message,
    hint: failure.hint,
    line: failure.line ?? null,
    column: failure.column ?? null,
  };
}
