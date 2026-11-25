/**
 * The shell's configuration, parsed once at startup from Electron's app metadata and the
 * environment. Nothing else reads `process.env`.
 */

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import path from "node:path";

/** The environment variable that names the deck the shell opens. */
export const DECK_VARIABLE = "FUSE_DECK_STUDIO_DECK";

/** The shell started without a deck to open. */
export class DeckDirectoryMissing extends Schema.TaggedError<DeckDirectoryMissing>()("DeckDirectoryMissing", {
  variable: Schema.String,
}) {
  override get message(): string {
    return `Set ${this.variable} to the directory of the deck to open.`;
  }
}

/** Where the shell's files are and what it runs. */
export type DesktopConfig = {
  /** The deck the backend serves, absolute. */
  readonly deckDirectory: string;
  /** The stub page's files, served through the app scheme. */
  readonly rendererDirectory: string;
  readonly preloadPath: string;
  /** The staged install's `fuse-deck` entry, which the backend runs. */
  readonly backendEntry: string;
};

/** What the configuration is read from. */
export type DesktopConfigSource = {
  /** `app.getAppPath()`: the app's root, inside `app.asar` when packaged. */
  readonly appPath: string;
  /** `process.resourcesPath`, which holds the staged backend when packaged. */
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  /** The working directory a relative deck path resolves against. */
  readonly cwd: string;
  readonly deck: string | undefined;
};

/**
 * Parse the shell's configuration.
 *
 * @param source - Electron's app metadata and the deck variable's value.
 * @returns The configuration, or `DeckDirectoryMissing` when no deck is named.
 */
export function parseDesktopConfig(
  source: DesktopConfigSource
): Result.Result<DesktopConfig, DeckDirectoryMissing> {
  const deck = source.deck?.trim() ?? "";
  if (deck === "") {
    return Result.fail(new DeckDirectoryMissing({ variable: DECK_VARIABLE }));
  }
  // Packaged, the staged install sits beside app.asar under Resources, outside the archive, so
  // Node resolves and Vite serves its files from the real file system. Unpackaged, `package`
  // stages the same tree in the package's .artifacts.
  const backendRoot = source.isPackaged
    ? path.join(source.resourcesPath, "backend")
    : path.join(source.appPath, ".artifacts", "backend");
  return Result.succeed({
    deckDirectory: path.resolve(source.cwd, deck),
    rendererDirectory: path.join(source.appPath, "dist", "renderer"),
    preloadPath: path.join(source.appPath, "dist", "electron", "preload.cjs"),
    backendEntry: path.join(backendRoot, "node_modules", "@elmeragroup", "fuse-deck", "dist", "bin.mjs"),
  });
}
