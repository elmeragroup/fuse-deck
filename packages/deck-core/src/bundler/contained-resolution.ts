/**
 * A deck is self-contained: every module and asset it imports is a file inside the deck, or a file
 * of a package fuse-deck provides. Vite follows a relative, absolute or symlinked import anywhere on
 * disk, under every query (`?raw`, `?url`) and for a plain asset, and both `build` and `dev` then
 * read the file: the build copies it into the output, and the dev server serves it, because Vite
 * serves every module it has resolved past `server.fs.allow`.
 *
 * This plugin checks each import at resolution, in every mode. An import from a deck module, a
 * virtual module or a request with no importer must resolve to a real path inside the deck or
 * under a trusted root: the runtime's, React's, React DOM's, Fuse's, the optimizer cache's and Vite's own, for its dev
 * client. The plugin leaves a trusted file's own imports unchecked, so their dependencies resolve
 * wherever the install put them. Any other import fails with its specifier, its importer and the
 * file it reached.
 *
 * Vite's build resolves a `new URL("./file", import.meta.url)` asset itself, past every plugin's
 * `resolveId`, and emits the file. So the build also checks each asset it emits by the file it
 * came from; the bundler turns inlining off, so every asset is emitted. A deck module's literal
 * `new URL()` targets are checked before that, as the module is transformed, so Vite never reads
 * an outside file to emit it.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

import { deckEntrySync, describeRefusal, isInside } from "../deck/contained-file.ts";

/**
 * Vite 8.3's own `assetImportMetaUrlRE`: a `new URL(<literal>, import.meta.url)` whose asset Vite
 * reads itself, inlining it under `?inline` whatever `assetsInlineLimit` says. Its first group is the
 * quoted target.
 */
const NEW_URL = /\bnew\s+URL\s*\(\s*('[^']+'|"[^"]+"|`[^`]+`)\s*,\s*import\.meta\.url\s*(?:,\s*)?\)/dg;

/** A URL with a scheme, or a protocol-relative one: never a deck file. */
const SCHEMED = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** The file an id names, without its query or hash. */
function fileOf(id: string): string {
  return id.replace(/[?#].*$/, "");
}

/** The canonical path of `file`, or none when it does not exist. */
function realPath(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

/**
 * The plugin that keeps a deck's imports inside the deck.
 *
 * @param options - The deck's root, and the directories whose files a deck may import: the
 *   runtime's and the packages fuse-deck provides.
 * @returns The plugin.
 */
export function containedResolutionPlugin(options: {
  readonly deckRoot: string;
  readonly trustedRoots: ReadonlyArray<string>;
}): Plugin {
  const root = path.resolve(options.deckRoot);
  const realRoot = realpathSync(root);
  // A trusted root that does not exist yet, such as the optimizer cache before its first run, is
  // canonicalized once it does: its real path may differ from its spelling (macOS's `/var`).
  const canonical = new Map<string, string>();
  const trusted = () =>
    options.trustedRoots.map((each) => {
      const known = canonical.get(each);
      if (known !== undefined) {
        return known;
      }
      const real = realPath(each);
      if (real !== undefined) {
        canonical.set(each, real);
      }
      return real ?? path.resolve(each);
    });
  const inDeck = (file: string) => isInside(realRoot, file) || isInside(root, file);

  /** Whether the importer's own imports are checked: a deck file, a virtual module or none. */
  const checksImports = (importer: string | undefined): boolean => {
    if (importer === undefined || importer.startsWith("\0")) {
      return true;
    }
    const file = fileOf(importer);
    return !path.isAbsolute(file) || inDeck(realPath(file) ?? file);
  };

  /** Where an id leads outside the deck and the trusted roots, or none when it stays inside. */
  const escape = (id: string): string | undefined => {
    const file = fileOf(id);
    if (id.startsWith("\0") || !path.isAbsolute(file)) {
      return undefined;
    }
    // A path that does not exist reads nothing; Vite answers it as missing.
    const real = realPath(file);
    if (real === undefined || inDeck(real) || trusted().some((each) => isInside(each, real))) {
      return undefined;
    }
    return real;
  };

  return {
    name: "fuse-deck:contained-resolution",
    enforce: "pre",
    async resolveId(source, importer, resolveOptions) {
      if (!checksImports(importer)) {
        return null;
      }
      const resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });
      if (resolved === null || Boolean(resolved.external)) {
        return resolved;
      }
      const real = escape(resolved.id);
      if (real !== undefined) {
        this.error(
          `${importer === undefined ? "A request" : fileOf(importer)} imports "${source}", which resolves to ${real}, outside the deck. A deck imports only its own files and the packages fuse-deck provides.`
        );
      }
      return resolved;
    },
    transform(code, id) {
      // Before Vite's own plugin reads the file: the literal `new URL()` assets of a deck module.
      if (!checksImports(id) || id.startsWith("\0")) {
        return null;
      }
      for (const [, quoted = ""] of code.matchAll(NEW_URL)) {
        const target = quoted.slice(1, -1);
        // A template with an expression is a glob, which Vite resolves through `resolveId`.
        if (SCHEMED.test(target) || target.includes("${")) {
          continue;
        }
        const file = target.startsWith("/")
          ? path.join(root, target)
          : path.resolve(path.dirname(fileOf(id)), fileOf(target));
        const entry = deckEntrySync(root, file, ["File"]);
        const real = entry._tag === "OutsideDeck" ? escape(file) : undefined;
        const reason =
          real !== undefined
            ? `which resolves to ${real}, outside the deck.`
            : entry._tag === "Link" || entry._tag === "WrongKind"
              ? describeRefusal(entry)
              : undefined;
        if (reason !== undefined) {
          this.error(
            `${fileOf(id)} names the asset "${target}", ${reason} A deck imports only its own files and the packages fuse-deck provides.`
          );
        }
      }
      return null;
    },
    generateBundle(_output, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "asset") {
          continue;
        }
        for (const original of output.originalFileNames) {
          const real = escape(path.resolve(root, original));
          if (real !== undefined) {
            this.error(
              `The build emits ${output.fileName} from ${real}, outside the deck. A deck imports only its own files and the packages fuse-deck provides.`
            );
          }
        }
      }
    },
  };
}
