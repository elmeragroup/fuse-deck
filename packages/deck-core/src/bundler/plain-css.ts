/**
 * Decks style slides with plain CSS, and deck-core owns how a deck's CSS reaches Vite. Vite 8.3
 * compiles a Sass, Less, Stylus or SugarSS stylesheet with a compiler it resolves from the deck
 * directory, which would run code the deck ships in Node, and its `@import` inliner resolves and
 * reads targets through its own callbacks, past every plugin hook. So this plugin:
 *
 * - Refuses to load any module whose id Vite would read as a preprocessed stylesheet, under any
 *   query. Vite picks the language from the whole id, query included (`x.txt?lang.scss` is Sass),
 *   so the test does too.
 * - Parses each deck stylesheet with PostCSS and inlines every `@import` itself. A target is
 *   either an `http:` or `https:` URL, kept for the browser, or a relative `.css` path whose real
 *   path is a regular `.css` file inside the deck; anything else fails the build. Vite receives
 *   CSS whose only `@import`s are remote, and its inliner leaves those to the browser.
 * - Checks every relative `url()` and `image-set()` target the same way when it exists, and
 *   rewrites the ones in an inlined stylesheet so they still name the same file from the importer.
 *
 * Stylesheets under the trusted roots (the runtime's and the dependencies fuse-deck installs) ship
 * built and pass through untouched.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import type { AtRule, ChildNode, Root } from "postcss";
import type { Plugin } from "vite";

import { containedFile, describeRefusal, isInside } from "../deck/contained-file.ts";

/** Vite 8.3's own test of a stylesheet's language, `CSS_LANGS_RE`, applied to the whole id. */
const CSS_LANG = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

/** The languages Vite compiles with a preprocessor resolved from the deck. */
const PREPROCESSORS: ReadonlySet<string> = new Set(["less", "sass", "scss", "styl", "stylus", "sss"]);

/** Queries under which Vite serves a stylesheet as something other than CSS. */
const NOT_CSS_QUERY = /[?&](?:worker|sharedworker|raw|url)\b/;

/** A remote stylesheet the browser fetches. */
const REMOTE = /^https?:\/\//i;

/** A URL with a scheme, or a protocol-relative one: never a deck file. */
const SCHEMED = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

const REFUSED_MESSAGE =
  "fuse-deck decks style slides with plain CSS. Sass, Less, Stylus and SugarSS stylesheets do not load, because their compilers would run from the deck in Node.";

/** Why a deck stylesheet was refused, as the sentence the build fails with. */
type CssRefused = { readonly _tag: "CssRefused"; readonly message: string };

const refused = (file: string, reason: string): CssRefused => ({
  _tag: "CssRefused",
  message: `${file}: ${reason} A deck stylesheet imports only relative .css files inside the deck and http(s) URLs.`,
});

/** The language Vite's test gives an id's file, whatever its query, or none. */
function langOf(id: string): string | undefined {
  return CSS_LANG.exec(id)?.[1];
}

/** The language of an id Vite serves as a stylesheet, or none when it is not one. */
function cssLang(id: string): string | undefined {
  return NOT_CSS_QUERY.test(id) ? undefined : langOf(id);
}

/** The file an id names, without its query or hash. */
function fileOf(id: string): string {
  return id.replace(/[?#].*$/, "");
}

/** An `@import`'s target and the conditions it applies under. */
type ImportRule = {
  readonly target: string;
  readonly layer: string | undefined;
  readonly supports: string | undefined;
  readonly media: string | undefined;
};

/** The quoted string at the start of `text`, and the rest. No escapes: a deck path needs none. */
function quoted(text: string): { readonly value: string; readonly rest: string } | undefined {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }
  const end = text.indexOf(quote, 1);
  const value = text.slice(1, end);
  return end === -1 || value.includes("\\") ? undefined : { value, rest: text.slice(end + 1) };
}

/** The parenthesized text at the start of `text` (which starts with `(`), and the rest. */
function parenthesized(text: string): { readonly inner: string; readonly rest: string } | undefined {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "(") {
      depth += 1;
    } else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return { inner: text.slice(1, index), rest: text.slice(index + 1) };
      }
    }
  }
  return undefined;
}

/**
 * Parse an `@import`'s params, as PostCSS gives them with comments removed: a quoted string or a
 * `url()`, then an optional `layer` or `layer(name)`, an optional `supports(...)` and a media
 * query list. Anything else is refused rather than guessed at.
 */
function parseImport(params: string): ImportRule | undefined {
  let rest = params.trim();
  let target: string;
  const string = quoted(rest);
  if (string !== undefined) {
    target = string.value;
    rest = string.rest;
  } else if (/^url\(/i.test(rest)) {
    const argument = parenthesized(rest.slice(3));
    if (argument === undefined) {
      return undefined;
    }
    const inner = argument.inner.trim();
    const quotedInner = quoted(inner);
    if (quotedInner?.rest.trim() === "") {
      target = quotedInner.value;
    } else if (/^[^\s"'()\\]+$/.test(inner)) {
      target = inner;
    } else {
      return undefined;
    }
    rest = argument.rest;
  } else {
    return undefined;
  }
  rest = rest.trim();
  let layer: string | undefined;
  const layerMatch = /^layer(?![\w-])/i.exec(rest);
  if (layerMatch !== null) {
    rest = rest.slice(layerMatch[0].length);
    if (rest.startsWith("(")) {
      const name = parenthesized(rest);
      if (name === undefined) {
        return undefined;
      }
      layer = name.inner.trim();
      rest = name.rest;
    } else {
      layer = "";
    }
    rest = rest.trim();
  }
  let supports: string | undefined;
  if (/^supports\(/i.test(rest)) {
    const condition = parenthesized(rest.slice("supports".length));
    if (condition === undefined) {
      return undefined;
    }
    supports = condition.inner.trim();
    rest = condition.rest.trim();
  }
  const media = rest === "" ? undefined : rest;
  if ([target, layer, supports, media].some((part) => part !== undefined && /[;{}]/.test(part))) {
    return undefined;
  }
  return { target, layer, supports, media };
}

/** A value a check let through. */
type Checked = { readonly _tag: "Checked"; readonly value: string };

const checked = (value: string): Checked => ({ _tag: "Checked", value });

/** The stylesheet a relative `@import` target names, checked, or why it is refused. */
function importedFile(root: string, importer: string, target: string): Checked | CssRefused {
  if (target.startsWith("/") || /[?#\\]/.test(target) || SCHEMED.test(target) || !target.endsWith(".css")) {
    return refused(importer, `It imports ${target}.`);
  }
  const contained = containedFile(root, path.resolve(path.dirname(importer), target));
  if (contained._tag !== "ContainedFile") {
    return refused(importer, `It imports ${target}: ${describeRefusal(contained)}`);
  }
  return contained.real.endsWith(".css")
    ? checked(contained.real)
    : refused(importer, `It imports ${target}, which is ${contained.real}, not a .css file.`);
}

/** A `url()` or `image-set()` target in a declaration's value, by its position. */
type UrlToken = {
  readonly start: number;
  readonly end: number;
  readonly url: string;
  readonly quote: string;
};

/**
 * The URL targets in a declaration value: each `url()` argument, and each string inside an
 * `image-set()`, which Vite resolves as a URL too.
 */
function urlTokens(value: string): ReadonlyArray<UrlToken> {
  const tokens: UrlToken[] = [];
  const functions: string[] = [];
  let index = 0;
  while (index < value.length) {
    const character = value[index] ?? "";
    if (character === '"' || character === "'") {
      const end = value.indexOf(character, index + 1);
      const stop = end === -1 ? value.length : end + 1;
      if (functions.some((name) => /image-set$/i.test(name))) {
        tokens.push({
          start: index + 1,
          end: stop - 1,
          url: value.slice(index + 1, stop - 1),
          quote: character,
        });
      }
      index = stop;
      continue;
    }
    const url = /^url\(\s*/i.exec(value.slice(index));
    if (url !== null && !/[\w-]/.test(value[index - 1] ?? "")) {
      const open = index + url[0].length;
      const first = value[open];
      if (first === '"' || first === "'") {
        const end = value.indexOf(first, open + 1);
        const stop = end === -1 ? value.length : end;
        tokens.push({ start: open + 1, end: stop, url: value.slice(open + 1, stop), quote: first });
        const close = value.indexOf(")", stop);
        index = close === -1 ? value.length : close + 1;
      } else {
        const close = value.indexOf(")", open);
        const stop = close === -1 ? value.length : close;
        const raw = value.slice(open, stop).trimEnd();
        tokens.push({ start: open, end: open + raw.length, url: raw, quote: "" });
        index = stop + 1;
      }
      continue;
    }
    const name = /^[\w-]+\(/.exec(value.slice(index));
    if (name !== null) {
      functions.push(name[0].slice(0, -1));
      index += name[0].length;
      continue;
    }
    if (character === "(") {
      functions.push("");
    } else if (character === ")") {
      functions.pop();
    }
    index += 1;
  }
  return tokens;
}

/**
 * The URL a target should have in the stylesheet Vite receives, or why it is refused. A target
 * that names a deck file is checked when the file exists (Vite reports a missing one itself), and
 * one in an inlined stylesheet is rewritten relative to the entry stylesheet's directory.
 */
function checkedUrl(root: string, file: string, entryDirectory: string, url: string): Checked | CssRefused {
  if (url === "" || url.startsWith("#") || /^data:/i.test(url) || REMOTE.test(url) || url.startsWith("//")) {
    return checked(url);
  }
  if (SCHEMED.test(url) || url.includes("\\")) {
    return refused(file, `It names ${url}.`);
  }
  const suffixStart = url.search(/[?#]/);
  const pathPart = suffixStart === -1 ? url : url.slice(0, suffixStart);
  const suffix = suffixStart === -1 ? "" : url.slice(suffixStart);
  // A root-relative URL names a file in the deck or in its `public` directory.
  const candidates = pathPart.startsWith("/")
    ? [path.join(root, pathPart), path.join(root, "public", pathPart)]
    : [path.resolve(path.dirname(file), pathPart)];
  for (const candidate of candidates) {
    const contained = containedFile(root, candidate);
    if (contained._tag === "OutsideDeck" || contained._tag === "NotAFile") {
      return refused(file, `It names ${url}: ${describeRefusal(contained)}`);
    }
  }
  const [target] = candidates;
  if (pathPart.startsWith("/") || target === undefined || path.dirname(file) === entryDirectory) {
    return checked(url);
  }
  const relative = path.relative(entryDirectory, target).split(path.sep).join("/");
  return checked(`${relative.startsWith(".") ? relative : `./${relative}`}${suffix}`);
}

/** Check, and where needed rewrite, every URL in `root`'s declarations. */
function rewriteUrls(
  deckRoot: string,
  file: string,
  entryDirectory: string,
  sheet: Root
): CssRefused | undefined {
  let failure: CssRefused | undefined;
  sheet.walkDecls((declaration) => {
    if (failure !== undefined) {
      return false;
    }
    const tokens = urlTokens(declaration.value);
    let value = declaration.value;
    // Replace from the end, so earlier positions stay valid.
    for (const token of [...tokens].reverse()) {
      const url = checkedUrl(deckRoot, file, entryDirectory, token.url);
      if (url._tag === "CssRefused") {
        failure = url;
        return false;
      }
      value = `${value.slice(0, token.start)}${url.value}${value.slice(token.end)}`;
    }
    declaration.value = value;
    return undefined;
  });
  return failure;
}

/** `nodes` inside the at-rules an `@import`'s conditions name, outermost first. */
function wrapped(rule: ImportRule, nodes: ReadonlyArray<ChildNode>): ReadonlyArray<ChildNode> {
  const layers: Array<{ readonly name: string; readonly params: string | undefined }> = [
    { name: "layer", params: rule.layer },
    { name: "supports", params: rule.supports === undefined ? undefined : `(${rule.supports})` },
    { name: "media", params: rule.media },
  ];
  return layers.reduceRight<ReadonlyArray<ChildNode>>((inner, { name, params }) => {
    if (params === undefined) {
      return inner;
    }
    const atRule = postcss.atRule({ name, params });
    atRule.append(...inner);
    return [atRule];
  }, nodes);
}

/** A deck stylesheet with its `@import`s inlined, and the stylesheets it read to do so. */
type Inlined = { readonly _tag: "Inlined"; readonly root: Root; readonly files: ReadonlyArray<string> };

/**
 * Parse `code` as `file`, check its URLs, and replace each local `@import` with the imported
 * stylesheet, inlined the same way. `chain` holds the stylesheets importing this one, to refuse a
 * cycle; `remote` collects the remote `@import`s, which only the entry stylesheet may have.
 */
function inline(
  deckRoot: string,
  file: string,
  code: string,
  entryDirectory: string,
  chain: ReadonlyArray<string>
): Inlined | CssRefused {
  let sheet: Root;
  try {
    sheet = postcss.parse(code, { from: file });
  } catch (error) {
    return refused(file, `It does not parse: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const urls = rewriteUrls(deckRoot, file, entryDirectory, sheet);
  if (urls !== undefined) {
    return urls;
  }
  const imports: AtRule[] = [];
  sheet.walkAtRules((atRule) => {
    if (atRule.name.toLowerCase() === "import") {
      imports.push(atRule);
    }
  });
  const files: string[] = [];
  const isEntry = chain.length === 0;
  for (const atRule of imports) {
    const rule = parseImport(atRule.params);
    if (rule === undefined || atRule.parent?.type !== "root" || atRule.nodes !== undefined) {
      return refused(file, `It has an @import this check cannot read: @${atRule.name} ${atRule.params}.`);
    }
    if (REMOTE.test(rule.target)) {
      if (!isEntry) {
        return refused(
          file,
          `It imports ${rule.target} from an imported stylesheet; import it from the stylesheet a slide loads.`
        );
      }
      // Keep it for the browser, in Vite's canonical spelling, with the imports at the top.
      atRule.name = "import";
      continue;
    }
    const imported = importedFile(deckRoot, file, rule.target);
    if (imported._tag === "CssRefused") {
      return imported;
    }
    if (imported.value === file || chain.includes(imported.value)) {
      return refused(file, `It imports ${rule.target}, which imports it back.`);
    }
    const child = inline(deckRoot, imported.value, readFileSync(imported.value, "utf8"), entryDirectory, [
      ...chain,
      file,
    ]);
    if (child._tag === "CssRefused") {
      return child;
    }
    files.push(imported.value, ...child.files);
    child.root.walkAtRules("charset", (charset) => {
      charset.remove();
    });
    atRule.replaceWith(...wrapped(rule, child.root.nodes));
  }
  if (isEntry) {
    // A remote `@import` must stay ahead of every rule, inlined ones included.
    const remote = imports.filter((atRule) => atRule.parent !== undefined && atRule.name === "import");
    for (const atRule of remote.reverse()) {
      sheet.prepend(atRule.remove());
    }
    sheet.walkAtRules("charset", (charset) => {
      sheet.prepend(charset.remove());
    });
  }
  return { _tag: "Inlined", root: sheet, files };
}

/**
 * The plugin that keeps preprocessors from running and inlines a deck's own `@import`s.
 *
 * @param options - The deck's root, and the directories whose stylesheets pass through untouched:
 *   the runtime's and the dependencies fuse-deck installs, whose CSS ships built.
 * @returns The plugin.
 */
export function plainCssPlugin(options: {
  readonly deckRoot: string;
  readonly trustedRoots: ReadonlyArray<string>;
}): Plugin {
  const trusted = (file: string) => options.trustedRoots.some((root) => isInside(root, file));
  return {
    name: "fuse-deck:plain-css",
    enforce: "pre",
    load(id) {
      // Refused under every query, `?raw` and `?url` included: a deck has no use for its text.
      const lang = langOf(id);
      if (lang !== undefined && PREPROCESSORS.has(lang)) {
        this.error(`${REFUSED_MESSAGE} (${id})`);
      }
      return null;
    },
    transform(code, id) {
      const lang = cssLang(id);
      if (lang === undefined) {
        return null;
      }
      if (PREPROCESSORS.has(lang)) {
        this.error(`${REFUSED_MESSAGE} (${id})`);
      }
      const file = fileOf(id);
      if (trusted(file)) {
        return null;
      }
      const contained = containedFile(options.deckRoot, file);
      if (contained._tag !== "ContainedFile") {
        this.error(`A deck stylesheet must be a file inside the deck. ${describeRefusal(contained)}`);
      }
      const result = inline(options.deckRoot, contained.real, code, path.dirname(contained.real), []);
      if (result._tag === "CssRefused") {
        this.error(result.message);
      }
      for (const imported of result.files) {
        this.addWatchFile(imported);
      }
      const output = result.root.toResult({ map: { inline: false, annotation: false } });
      return { code: output.css, map: output.map.toString() };
    },
  };
}
