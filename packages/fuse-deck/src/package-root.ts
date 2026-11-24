/**
 * The files fuse-deck ships beside its code: the skill and the built deck runtime. The CLI runs
 * from `src/` in this checkout and from `dist/` in the packed package, so the lookup walks up from
 * the running module to the `package.json` that names the package rather than counting levels.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@elmeragroup/fuse-deck";

const decodeName = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ name: Schema.String })));

/** The nearest directory at or above `start` whose `package.json` names fuse-deck. */
function packageRootAbove(start: string): Option.Option<string> {
  for (let directory = start; ; directory = path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    const found = existsSync(manifest) ? decodeName(readFileSync(manifest, "utf8")) : Option.none();
    if (Option.isSome(found) && found.value.name === PACKAGE_NAME) {
      return Option.some(directory);
    }
    if (path.dirname(directory) === directory) {
      return Option.none();
    }
  }
}

/**
 * The directory of the fuse-deck package that holds the running module.
 *
 * @throws When no ancestor holds fuse-deck's `package.json`, which only a broken install causes.
 */
function fuseDeckPackageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return Option.getOrThrowWith(
    packageRootAbove(path.dirname(here)),
    () => new Error(`No ${PACKAGE_NAME} package.json above ${here}.`)
  );
}

/**
 * The skill that ships in the package, for an agent to open.
 *
 * @returns The absolute path of `skill/SKILL.md`.
 */
export function shippedSkillPath(): string {
  return path.join(fuseDeckPackageRoot(), "skill", "SKILL.md");
}

/**
 * The deck runtime that ships in the package. The build copies it from deck-core.
 *
 * @returns The absolute path of `dist/runtime`, which holds `main.js` and `deck.css`.
 */
export function runtimeRoot(): string {
  return path.join(fuseDeckPackageRoot(), "dist", "runtime");
}
