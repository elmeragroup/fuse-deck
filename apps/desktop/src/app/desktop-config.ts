/**
 * The shell's configuration, parsed once at startup from Electron's app metadata and the
 * environment. Nothing else reads `process.env`.
 */

import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import path from "node:path";

/** The environment variable that names a deck to open at start. */
export const DECK_VARIABLE = "FUSE_DECK_STUDIO_DECK";

/**
 * The environment variable that names the renderer's dev server. When it is set, main serves the
 * renderer through the dev scheme's proxy instead of from the built files.
 */
export const RENDERER_DEV_URL_VARIABLE = "FUSE_DECK_STUDIO_RENDERER_URL";

/** `FUSE_DECK_STUDIO_RENDERER_URL` is not an http address on 127.0.0.1. */
export class RendererDevUrlInvalid extends Schema.TaggedError<RendererDevUrlInvalid>()(
  "RendererDevUrlInvalid",
  {
    value: Schema.String,
  }
) {
  override get message(): string {
    return `${RENDERER_DEV_URL_VARIABLE} must be an http address on 127.0.0.1, such as http://127.0.0.1:5733/, not ${this.value}.`;
  }
}

/** Where the renderer comes from. */
export type RendererSource =
  /** The built renderer's files, served on the app scheme. */
  | { readonly _tag: "Files"; readonly directory: string }
  /** The renderer's Vite dev server, proxied on the dev scheme. */
  | { readonly _tag: "DevServer"; readonly url: URL };

/** Where the shell's files are and what it runs. */
export type DesktopConfig = {
  /** A deck to open at start, absolute. */
  readonly initialDeck: Option.Option<string>;
  readonly renderer: RendererSource;
  readonly preloadPath: string;
  /** The studio backend's entry, which the backend process runs. */
  readonly backendEntry: string;
  /** The working directory the backend runs in. */
  readonly backendDirectory: string;
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
  readonly rendererDevUrl: string | undefined;
};

/**
 * Parse the shell's configuration.
 *
 * @param source - Electron's app metadata and the environment's values.
 * @returns The configuration, or `RendererDevUrlInvalid` for a dev server address main would not proxy.
 */
export function parseDesktopConfig(
  source: DesktopConfigSource
): Result.Result<DesktopConfig, RendererDevUrlInvalid> {
  const deck = source.deck?.trim() ?? "";
  const devUrl = source.rendererDevUrl?.trim() ?? "";
  let renderer: RendererSource = { _tag: "Files", directory: path.join(source.appPath, "dist", "renderer") };
  if (devUrl !== "") {
    const url = URL.parse(devUrl);
    if (url?.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      return Result.fail(new RendererDevUrlInvalid({ value: devUrl }));
    }
    renderer = { _tag: "DevServer", url };
  }
  // Packaged, the staged install sits beside app.asar under Resources, outside the archive, so
  // Node resolves and Vite serves its files from the real file system. Unpackaged, the backend is
  // the workspace's own build of apps/studio.
  const backendPackage = source.isPackaged
    ? path.join(source.resourcesPath, "backend", "node_modules", "@elmeragroup", "fuse-deck-studio")
    : path.join(source.appPath, "..", "studio");
  return Result.succeed({
    initialDeck: deck === "" ? Option.none() : Option.some(path.resolve(source.cwd, deck)),
    renderer,
    preloadPath: path.join(source.appPath, "dist", "electron", "preload.cjs"),
    backendEntry: path.join(backendPackage, "dist", "server", "bin.mjs"),
    backendDirectory: source.isPackaged ? source.resourcesPath : backendPackage,
  });
}
