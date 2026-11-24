/**
 * A deck is untrusted input, and it is self-contained: every file the studio or the bundler reads
 * on its behalf is a regular file whose real path lies inside the deck's real root. A path lexically
 * under the root is not enough, because a symlinked file or directory in the deck can point anywhere.
 * This module is that one check, in a synchronous form for Vite's hooks and middleware.
 */

import { realpathSync, statSync } from "node:fs";
import path from "node:path";

/** A regular file whose real path lies inside the deck. Read through `real`, the path that was checked. */
export type ContainedFile = {
  readonly _tag: "ContainedFile";
  /** The canonical path of the file. */
  readonly real: string;
};

/** Why a path does not name a contained file. */
export type FileNotContained =
  | { readonly _tag: "Missing"; readonly file: string }
  | { readonly _tag: "OutsideDeck"; readonly file: string; readonly real: string }
  | { readonly _tag: "NotAFile"; readonly file: string; readonly real: string };

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
 * Resolve `file` to a regular file inside `root`, following every symlink first.
 *
 * @param root - The deck's root, canonical or not.
 * @param file - An absolute path, or one relative to `root`.
 * @returns The contained file, or why the path is refused.
 */
export function containedFile(root: string, file: string): ContainedFile | FileNotContained {
  const absolute = path.resolve(root, file);
  let real: string;
  let realRoot: string;
  let regular: boolean;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(absolute);
    regular = statSync(real).isFile();
  } catch {
    return { _tag: "Missing", file: absolute };
  }
  if (!isInside(realRoot, real)) {
    return { _tag: "OutsideDeck", file: absolute, real };
  }
  if (!regular) {
    return { _tag: "NotAFile", file: absolute, real };
  }
  return { _tag: "ContainedFile", real };
}

/**
 * A sentence that says why a path was refused, for a log or an error document.
 *
 * @param refused - The refusal.
 * @returns The sentence.
 */
export function describeRefusal(refused: FileNotContained): string {
  switch (refused._tag) {
    case "Missing":
      return `${refused.file} does not exist.`;
    case "OutsideDeck":
      return `${refused.file} resolves to ${refused.real}, outside the deck.`;
    case "NotAFile":
      return `${refused.file} resolves to ${refused.real}, which is not a regular file.`;
  }
}
