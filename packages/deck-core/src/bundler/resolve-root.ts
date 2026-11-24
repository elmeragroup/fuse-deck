/**
 * Where the bundler resolves its packages from: the running module's own file. fuse-deck's build
 * inlines this module, so inside an install the file is fuse-deck's `dist/bin.mjs`, and in a
 * checkout run from source it is this file. Vite's resolve anchor, the theme runner's root, the
 * optimizer's lockfile lookup, and React, React DOM and Fuse all start here, so they agree on one
 * install without the host naming it.
 */

import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The running module's file, absolute. Vite resolves the deck's bare imports as if this file imported them. */
export const RESOLVE_ANCHOR = fileURLToPath(import.meta.url);

/** The running module's directory, absolute. */
export const RESOLVE_ROOT = path.dirname(RESOLVE_ANCHOR);

const decodeName = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ name: Schema.String })));

/** The nearest directory at or above `start` whose `package.json` names `name`. */
function packageRootAbove(start: string, name: string): Option.Option<string> {
  for (let directory = start; ; directory = path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    const found = existsSync(manifest) ? decodeName(readFileSync(manifest, "utf8")) : Option.none();
    if (Option.isSome(found) && found.value.name === name) {
      return Option.some(directory);
    }
    if (path.dirname(directory) === directory) {
      return Option.none();
    }
  }
}

/** A package the bundler resolves, as the install placed it. */
export type DependencyPackage = {
  /** The package directory, with symlinks resolved. */
  readonly root: string;
  /** The file the package's main entry resolves to, with symlinks resolved. */
  readonly entry: string;
};

/**
 * Find a package from the running module. It resolves the package's main entry, because not every
 * package exports its `package.json`, then walks up to the `package.json` that names the package,
 * because an install may put it at any depth.
 *
 * @param name - The package's name.
 * @returns The package's directory and entry, or none when the running module cannot resolve it.
 */
export function dependencyPackage(name: string): Option.Option<DependencyPackage> {
  return Option.flatMap(
    Result.getSuccess(Result.try(() => realpathSync(fileURLToPath(import.meta.resolve(name))))),
    (entry) => Option.map(packageRootAbove(path.dirname(entry), name), (root) => ({ root, entry }))
  );
}
