import * as Schema from "effect/Schema";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** The built bin, the file the packed tarball ships. Turbo builds it before this suite runs. */
const BIN = fileURLToPath(new URL("../dist/bin.mjs", import.meta.url));

/** The runtime entry `dev` serves from the package directory. */
const RUNTIME_ENTRY = fileURLToPath(new URL("../dist/runtime/main.js", import.meta.url));

/** A file in the checkout outside the deck, the package and its dependencies. */
const CHECKOUT_MANIFEST = fileURLToPath(new URL("../../../package.json", import.meta.url));

/** What one run of the bin printed and how it exited. */
type Run = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

function fuseDeck(cwd: string, args: readonly string[]): Run {
  if (!existsSync(BIN)) {
    throw new Error(
      `${BIN} is missing. Run \`pnpm turbo run build --filter=@elmeragroup/fuse-deck\` first, which builds deck-core too.`
    );
  }
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A document's tag and message, the fields every failure document carries. */
const Tagged = Schema.Struct({ _tag: Schema.String, message: Schema.optionalKey(Schema.String) });

/**
 * The run's stdout decoded as exactly one JSON document of `schema`. `JSON.parse` fails on a second
 * document or any other text.
 */
function oneDocument<S extends Schema.Decoder<unknown>>(run: Run, schema: S): S["Type"] {
  return Schema.decodeSync(Schema.fromJsonString(schema))(run.stdout);
}

const Problem = Schema.Struct({
  _tag: Schema.String,
  id: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Finite),
  theme: Schema.optionalKey(Schema.String),
});

const CheckFailed = Schema.TaggedStruct("DeckCheckFailed", { problems: Schema.Array(Problem) });

const SlideList = Schema.TaggedStruct("SlideList", {
  slides: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      title: Schema.NullOr(Schema.String),
      layout: Schema.NullOr(Schema.String),
    })
  ),
});

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "fuse-deck-cli-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function createDeck(): string {
  const run = fuseDeck(workspace, ["create", "talk", "--brief", "Show Fuse.", "--json"]);
  expect(run.status, run.stderr).toBe(0);
  return path.join(workspace, "talk");
}

/** A `fuse-deck dev` run in `deck`, once it printed its readiness document. */
async function startDev(deck: string): Promise<{ readonly url: string; readonly stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [BIN, "dev", "--json"], {
    cwd: deck,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => {
      resolve();
    });
  });
  let stdout = "";
  const firstLine = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const end = stdout.indexOf("\n");
      if (end !== -1) {
        resolve(stdout.slice(0, end));
      }
    });
    child.on("exit", () => {
      reject(new Error(`dev exited before it was ready: ${stdout}`));
    });
  });
  const ready = Schema.decodeSync(
    Schema.fromJsonString(Schema.TaggedStruct("DevServerReady", { url: Schema.String }))
  )(firstLine);
  return {
    url: ready.url,
    stop: () => {
      child.kill("SIGKILL");
      return exited;
    },
  };
}

/**
 * Files that make Vite run code from the deck in Node, each writing `marker` when it runs: the
 * PostCSS config Vite searches the root for, a PostCSS plugin named in `package.json`, and a CSS
 * preprocessor resolved from the deck's own `node_modules`, reached from a slide and from CSS.
 */
function deckCodeVariants(marker: string): ReadonlyArray<{
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  /** Symlinks to write, each to its target relative to its own directory. */
  readonly links?: Readonly<Record<string, string>>;
}> {
  const writeMarker = `writeFileSync(${JSON.stringify(marker)}, "ran");`;
  const esm = `import { writeFileSync } from "node:fs";\n${writeMarker}\nexport default {};\n`;
  const cjs = `const { writeFileSync } = require("node:fs");\n${writeMarker}\nmodule.exports = {};\n`;
  const fakeSass = {
    "node_modules/sass/package.json": JSON.stringify({ name: "sass", version: "1.0.0", main: "index.js" }),
    "node_modules/sass/index.js": cjs,
    "styles/theme.scss": "$accent: red;\n.accent { color: $accent; }\n",
  };
  return [
    { name: "postcss.config.js", files: { "postcss.config.js": esm } },
    { name: "postcss.config.cjs", files: { "postcss.config.cjs": cjs } },
    { name: "postcss.config.mjs", files: { "postcss.config.mjs": esm } },
    {
      name: "a PostCSS plugin in package.json",
      files: {
        "package.json": JSON.stringify({ name: "talk", postcss: { plugins: { "./plugin.cjs": {} } } }),
        "plugin.cjs": cjs,
      },
    },
    {
      name: "a Sass package imported from a slide",
      files: { ...fakeSass, "slides/cover.mdx": 'import "../styles/theme.scss";\n\n# Talk\n' },
    },
    {
      name: "a package whose entry is Sass, imported from a slide",
      files: {
        ...fakeSass,
        "node_modules/theme/package.json": JSON.stringify({ name: "theme", main: "index.scss" }),
        "node_modules/theme/index.scss": "$accent: red;\n.accent { color: $accent; }\n",
        "slides/cover.mdx": 'import "theme";\n\n# Talk\n',
      },
    },
    {
      name: "a package whose style is Sass, imported from CSS",
      files: {
        ...fakeSass,
        "node_modules/theme/package.json": JSON.stringify({ name: "theme", style: "index.scss" }),
        "node_modules/theme/index.scss": "$accent: red;\n.accent { color: $accent; }\n",
        "styles/deck.css": '@import "theme";\n',
        "slides/cover.mdx": 'import "../styles/deck.css";\n\n# Talk\n',
      },
    },
    {
      name: "a chain of CSS imports that ends in a package whose style is Sass",
      files: {
        ...fakeSass,
        "node_modules/theme/package.json": JSON.stringify({ name: "theme", style: "index.scss" }),
        "node_modules/theme/index.scss": "$accent: red;\n.accent { color: $accent; }\n",
        "styles/deck.css": '@import "./base.css";\n',
        "styles/base.css": '@import "theme";\n',
        "slides/cover.mdx": 'import "../styles/deck.css";\n\n# Talk\n',
      },
    },
    {
      name: "a CSS file that links to Sass, imported from a slide and from CSS",
      files: {
        ...fakeSass,
        "styles/deck.css": '@import "./linked.css";\n',
        "slides/cover.mdx": 'import "../styles/linked.css";\nimport "../styles/deck.css";\n\n# Talk\n',
      },
      links: { "styles/linked.css": "theme.scss" },
    },
    {
      name: "a Sass file imported from a worker",
      files: {
        ...fakeSass,
        "assets/worker.js": 'import "../styles/theme.scss";\npostMessage("ready");\n',
        "slides/cover.mdx":
          'export const start = () => new Worker(new URL("../assets/worker.js", import.meta.url), { type: "module" });\n\n# Talk\n\n<button onClick={start}>Start</button>\n',
      },
    },
    {
      name: "a Sass package imported from CSS",
      files: {
        ...fakeSass,
        "styles/deck.css": '@import "./theme.scss";\n',
        "slides/cover.mdx": 'import "../styles/deck.css";\n\n# Talk\n',
      },
    },
    {
      name: "a file Vite reads as Sass from its query",
      files: {
        ...fakeSass,
        "styles/theme.txt": "$accent: red;\n.accent { color: $accent; }\n",
        "slides/cover.mdx": 'import "../styles/theme.txt?lang.scss";\n\n# Talk\n',
      },
    },
    ...["?url", "?raw", "?inline"].map((query) => ({
      name: `a Sass file imported from a slide with ${query}`,
      files: { ...fakeSass, "slides/cover.mdx": `import "../styles/theme.scss${query}";\n\n# Talk\n` },
    })),
    // Every form of `@import` that PostCSS reads, each reaching the Sass file.
    ...[
      '@import"./theme.scss";',
      "@import'./theme.scss';",
      '@import url("./theme.scss");',
      "@import url(./theme.scss) screen;",
      '@import "./theme.scss" layer(base);',
      '@import "./theme.scss" supports(display: grid) print;',
      '@import/* a comment */"./theme.scss";',
      '@IMPORT "./theme.scss";',
    ].map((rule) => ({
      name: `the CSS rule ${rule}`,
      files: {
        ...fakeSass,
        "styles/deck.css": `${rule}\n`,
        "slides/cover.mdx": 'import "../styles/deck.css";\n\n# Talk\n',
      },
    })),
    {
      name: "a chain of CSS imports without spaces that ends in Sass",
      files: {
        ...fakeSass,
        "styles/deck.css": '@import"./base.css";\n',
        "styles/base.css": '@import"./theme.scss";\n',
        "slides/cover.mdx": 'import "../styles/deck.css";\n\n# Talk\n',
      },
    },
  ];
}

/** A stylesheet outside the deck, and the text in it that must never reach a page or a build. */
const OUTSIDE_SECRET = "outside-the-deck-7f3a";

/** Every file's text under `directory`, joined; empty when there is no directory. */
async function builtText(directory: string): Promise<string> {
  if (!existsSync(directory)) {
    return "";
  }
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(path.join(entry.parentPath, entry.name), "utf8"))
  );
  return texts.join("\n");
}

describe("fuse-deck --json", () => {
  it.each([
    { name: "an unknown flag", args: ["describe", "--bogus", "--json"], where: "deck" },
    { name: "a command without its subcommand, outside a deck", args: ["slides", "--json"], where: "empty" },
    { name: "an invalid slide id", args: ["--json", "slides", "add", "Not/Safe"], where: "deck" },
    { name: "a move without an anchor", args: ["slides", "move", "cover", "--json"], where: "deck" },
  ])("answers $name with one InvalidInvocation document and exit 2", ({ args, where }) => {
    const run = fuseDeck(where === "deck" ? createDeck() : workspace, args);
    expect(run.status).toBe(2);
    const document = oneDocument(run, Schema.Struct({ _tag: Schema.String, message: Schema.NonEmptyString }));
    expect(document._tag).toBe("InvalidInvocation");
  });

  it("answers a broken deck with one DeckCheckFailed document naming each problem, and exit 1", async () => {
    const deck = createDeck();
    expect(fuseDeck(deck, ["slides", "add", "intro", "--json"]).status).toBe(0);
    await unlink(path.join(deck, "slides", "intro.mdx"));
    await writeFile(path.join(deck, "slides", "stray.mdx"), "# Stray\n");
    await writeFile(path.join(deck, "slides", "cover.mdx"), "---\ntransition: fade\n---\n# Talk\n");
    expect(fuseDeck(deck, ["slides", "add", "broken", "--json"]).status).toBe(0);
    await writeFile(path.join(deck, "slides", "broken.mdx"), "# Broken\n\nText\n\n<Step>never closed\n");
    // Telinet (fkse) spans the private segment only.
    const manifest = path.join(deck, "deck.json");
    await writeFile(
      manifest,
      (await readFile(manifest, "utf8")).replace("neutral-elma-private", "branded-fkse-company")
    );

    const run = fuseDeck(deck, ["check", "--json"]);
    expect(run.status).toBe(1);
    expect(oneDocument(run, CheckFailed).problems).toEqual([
      { _tag: "InvalidTheme", theme: "branded-fkse-company" },
      { _tag: "DanglingSlide", id: "intro" },
      { _tag: "OrphanSlide", path: "slides/stray.mdx" },
      { _tag: "InvalidFrontmatter", id: "cover" },
      { _tag: "SlideCompileFailed", id: "broken", line: 5 },
    ]);
  });

  it("answers a domain failure outside a deck with one document and exit 1", () => {
    const run = fuseDeck(workspace, ["slides", "list", "--json"]);
    expect(run.status).toBe(1);
    const document = oneDocument(
      run,
      Schema.Struct({ _tag: Schema.String, message: Schema.NonEmptyString, hint: Schema.NonEmptyString })
    );
    expect(document._tag).toBe("DeckNotFound");
  });

  it("answers each edit with one document and exit 0, and the order reflects every edit", () => {
    const deck = createDeck();
    const runs = [
      fuseDeck(deck, ["slides", "add", "intro", "--title", "Why Fuse", "--json"]),
      fuseDeck(deck, ["slides", "add", "tools", "--after", "cover", "--layout", "section", "--json"]),
      fuseDeck(deck, ["slides", "move", "intro", "--before", "tools", "--json"]),
      fuseDeck(deck, ["slides", "remove", "tools", "--json"]),
      fuseDeck(deck, ["check", "--json"]),
    ];
    expect(runs.map((run) => run.status)).toEqual([0, 0, 0, 0, 0]);
    expect(runs.map((run) => oneDocument(run, Tagged)._tag)).toEqual([
      "SlideAdded",
      "SlideAdded",
      "SlideMoved",
      "SlideRemoved",
      "DeckChecked",
    ]);
    // The second add and the move, each with the order it left.
    const Ordered = Schema.Struct({ order: Schema.Array(Schema.String) });
    expect(runs.slice(1, 3).map((run) => oneDocument(run, Ordered).order)).toEqual([
      ["cover", "tools", "intro"],
      ["cover", "intro", "tools"],
    ]);
    expect(oneDocument(fuseDeck(deck, ["slides", "list", "--json"]), SlideList).slides).toEqual([
      { id: "cover", path: "slides/cover.mdx", title: "Talk", layout: "cover" },
      { id: "intro", path: "slides/intro.mdx", title: "Why Fuse", layout: "content" },
    ]);
  });

  it("writes a brief line and titles that MDX would read as code as the text the author typed", () => {
    const brief = "import { x } from <y> & {z}\nSecond line";
    const created = fuseDeck(workspace, ["create", "a-{b}-<c>", "--brief", brief, "--json"]);
    expect(created.status, created.stderr).toBe(0);
    const deck = path.join(workspace, "a-{b}-<c>");
    expect(
      fuseDeck(deck, ["slides", "add", "why", "--title", "Why {Fuse} <now> *really*", "--json"]).status
    ).toBe(0);
    expect(oneDocument(fuseDeck(deck, ["check", "--json"]), Tagged)._tag).toBe("DeckChecked");
    expect(
      oneDocument(fuseDeck(deck, ["slides", "list", "--json"]), SlideList).slides.map((slide) => slide.title)
    ).toEqual(["A {b} <c>", "Why {Fuse} <now> *really*"]);
  });

  it("describes every layout that a slide can then use", () => {
    // Unit under test: `describe --json`. Oracle: the layout parser `slides add --layout` and `check` apply.
    const deck = createDeck();
    const vocabulary = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.TaggedStruct("DeckVocabulary", {
          layouts: Schema.Array(Schema.Struct({ name: Schema.String, summary: Schema.String })),
        })
      )
    )(fuseDeck(deck, ["describe", "--json"]).stdout);
    expect(vocabulary.layouts.length).toBeGreaterThan(0);
    for (const { name } of vocabulary.layouts) {
      expect(fuseDeck(deck, ["slides", "add", `uses-${name}`, "--layout", name, "--json"]).status).toBe(0);
    }
    expect(fuseDeck(deck, ["slides", "add", "uses-unknown", "--layout", "hero", "--json"]).status).toBe(2);
    expect(oneDocument(fuseDeck(deck, ["check", "--json"]), Tagged)._tag).toBe("DeckChecked");
  });

  it("dev prints one readiness document once the server listens on 127.0.0.1, and stops serving on SIGINT", async () => {
    const deck = createDeck();
    const child = spawn(process.execPath, [BIN, "dev", "--json"], {
      cwd: deck,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const firstLine = new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const end = stdout.indexOf("\n");
        if (end !== -1) {
          resolve(stdout.slice(0, end));
        }
      });
      child.on("exit", () => {
        reject(new Error(`dev exited before it was ready: ${stdout}`));
      });
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", resolve);
    });
    try {
      const ready = Schema.decodeSync(
        Schema.fromJsonString(Schema.TaggedStruct("DevServerReady", { url: Schema.String }))
      )(await firstLine);
      expect(new URL(ready.url).hostname).toBe("127.0.0.1");
      const page = await fetch(ready.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('data-theme-brand="elma"');
      // Vite serves the runtime from the package, and nothing else in the checkout around it.
      const served = async (file: string) => (await fetch(`${ready.url}@fs${file}`)).status;
      expect([await served(RUNTIME_ENTRY), await served(CHECKOUT_MANIFEST)]).toEqual([200, 403]);

      child.kill("SIGINT");
      expect(await exited).toBe(130);
      expect(stdout.trimEnd().split("\n")).toHaveLength(1);
      await expect(fetch(ready.url)).rejects.toThrow();
    } finally {
      child.kill("SIGKILL");
    }
  });

  it.each(deckCodeVariants("MARKER").map(({ name }) => ({ name })))(
    "runs no code from the deck in Node, through $name, in dev or build",
    async ({ name }) => {
      const deck = createDeck();
      const marker = path.join(workspace, "marker");
      const variant = deckCodeVariants(marker).find((candidate) => candidate.name === name);
      for (const [file, text] of Object.entries(variant?.files ?? {})) {
        await mkdir(path.dirname(path.join(deck, file)), { recursive: true });
        await writeFile(path.join(deck, file), text);
      }
      for (const [file, target] of Object.entries(variant?.links ?? {})) {
        await symlink(target, path.join(deck, file));
      }
      fuseDeck(deck, ["build", "--json"]);
      const ranInBuild = existsSync(marker);
      await rm(marker, { force: true });

      const dev = await startDev(deck);
      try {
        // The page, every stylesheet and script it links, the slide and the stylesheets the slide
        // imports: each request that would make Vite load the deck's code.
        const page = await (await fetch(dev.url)).text();
        const linked = [...page.matchAll(/(?:href|src)="([^"]+)"/g)].flatMap(([, href]) =>
          href === undefined ? [] : [href]
        );
        for (const href of [...linked, "slides/cover.mdx", "styles/theme.scss", "styles/deck.css"]) {
          await fetch(new URL(href, dev.url));
        }
      } finally {
        await dev.stop();
      }
      expect({ build: ranInBuild, dev: existsSync(marker) }).toEqual({ build: false, dev: false });
    }
  );

  it.each([
    { name: "a relative import that leaves the deck", css: '@import "../../outside.css";\n' },
    { name: "an import without a space that leaves the deck", css: '@import"../../outside.css";\n' },
    { name: "an absolute import", css: "@import url(OUTSIDE);\n" },
    { name: "a symlinked stylesheet", css: '@import "./linked.css";\n', link: "linked.css" },
    { name: "a symlinked directory", css: '@import "./linked/outside.css";\n', link: "linked" },
    { name: "a url() that leaves the deck", css: ".a { background: url(../../outside.css); }\n" },
  ])("reads no stylesheet outside the deck, through $name, in dev or build", async ({ css, link }) => {
    const deck = createDeck();
    const outside = path.join(workspace, "outside.css");
    await writeFile(outside, `.secret::after { content: "${OUTSIDE_SECRET}"; }\n`);
    await mkdir(path.join(deck, "styles"), { recursive: true });
    await writeFile(path.join(deck, "styles", "deck.css"), css.replace("OUTSIDE", outside));
    if (link === "linked.css") {
      await symlink(outside, path.join(deck, "styles", "linked.css"));
    } else if (link === "linked") {
      await symlink(workspace, path.join(deck, "styles", "linked"));
    }
    await writeFile(path.join(deck, "slides", "cover.mdx"), 'import "../styles/deck.css";\n\n# Talk\n');

    const build = fuseDeck(deck, ["build", "--json"]);
    const built = await builtText(path.join(deck, "dist"));

    const dev = await startDev(deck);
    let served = "";
    try {
      served = await (await fetch(new URL("styles/deck.css", dev.url))).text();
    } finally {
      await dev.stop();
    }
    expect({ built: built.includes(OUTSIDE_SECRET), served: served.includes(OUTSIDE_SECRET) }).toEqual({
      built: false,
      served: false,
    });
    expect(build.status).toBe(1);
  });

  it("serves no file a symlink in the deck takes outside it", async () => {
    const deck = createDeck();
    const outside = path.join(workspace, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), OUTSIDE_SECRET);
    await mkdir(path.join(deck, "public"));
    await mkdir(path.join(deck, "assets"));
    await symlink(path.join(outside, "secret.txt"), path.join(deck, "assets", "file.txt"));
    await symlink(outside, path.join(deck, "assets", "directory"));
    await symlink(path.join(outside, "secret.txt"), path.join(deck, "public", "file.txt"));
    await symlink(outside, path.join(deck, "public", "directory"));
    const dev = await startDev(deck);
    try {
      const requests = [
        "assets/file.txt",
        "assets/file.txt?raw",
        "assets/file.txt?raw&import",
        "assets/directory/secret.txt",
        "assets/directory/secret.txt?raw",
        "file.txt",
        "directory/secret.txt",
        `@fs${realpathSync(deck)}/assets/file.txt?raw`,
        `@fs${realpathSync(deck)}/assets/directory/secret.txt`,
      ];
      const leaked = [];
      for (const request of requests) {
        const response = await fetch(new URL(request, dev.url));
        if ((await response.text()).includes(OUTSIDE_SECRET)) {
          leaked.push(request);
        }
      }
      expect(leaked).toEqual([]);
      // A file inside the deck still serves.
      expect((await fetch(new URL("deck.json", dev.url))).status).toBe(200);
    } finally {
      await dev.stop();
    }
  });

  /** A slide that imports `source`, the default export as `secret`, and renders `render`. */
  const importing = (source: string, render = "{secret}") => ({
    slide: `import secret from ${JSON.stringify(source)};`,
    render,
    named: source.replace(/\?.*$/, ""),
  });
  /** A slide that starts `assets/worker.js`, which imports the outside module. */
  const starting = (slide: string) => ({
    slide,
    render: "<button onClick={start}>Start</button>",
    named: "../../outside/secret.js",
  });
  it.each([
    { name: "a relative import", ...importing("../../outside/secret.js") },
    { name: "an absolute import", ...importing("OUTSIDE/secret.js") },
    { name: "a ?raw import", ...importing("../../outside/secret.txt?raw") },
    { name: "a ?url import", ...importing("../../outside/secret.txt?url", "<a href={secret}>link</a>") },
    { name: "a plain asset import", ...importing("../../outside/secret.png", '<img src={secret} alt="" />') },
    { name: "a symlinked file", ...importing("../assets/linked.js") },
    { name: "a symlinked directory", ...importing("../assets/linked/secret.js") },
    {
      name: "a new URL() asset",
      slide: 'export const secret = new URL("../../outside/secret.png", import.meta.url).href;',
      render: '<img src={secret} alt="" />',
      // Checked when the build emits the asset, by the file it came from.
      named: "REAL/secret.png",
    },
    {
      name: "a worker started from a new URL()",
      ...starting(
        'export const start = () => new Worker(new URL("../assets/worker.js", import.meta.url), { type: "module" });'
      ),
    },
    {
      name: "a ?worker import",
      ...starting(
        'import Secret from "../assets/worker.js?worker";\nexport const start = () => new Secret();'
      ),
    },
  ])(
    "builds and serves no module or asset outside the deck, through $name",
    async ({ slide, render, named }) => {
      const deck = createDeck();
      const outside = path.join(workspace, "outside");
      // Past Vite's 4 KiB inline limit, so an asset ships as a file that holds the text as written.
      const text = `${OUTSIDE_SECRET} ${"x".repeat(8192)}`;
      await mkdir(outside);
      await writeFile(path.join(outside, "secret.js"), `export default ${JSON.stringify(text)};\n`);
      await writeFile(path.join(outside, "secret.txt"), text);
      await writeFile(path.join(outside, "secret.png"), text);
      await mkdir(path.join(deck, "assets"));
      await symlink(path.join(outside, "secret.js"), path.join(deck, "assets", "linked.js"));
      await symlink(outside, path.join(deck, "assets", "linked"));
      await writeFile(
        path.join(deck, "assets", "worker.js"),
        'import secret from "../../outside/secret.js";\npostMessage(secret);\n'
      );
      const placed = (template: string) =>
        template.replace("OUTSIDE", outside).replace("REAL", realpathSync(outside));
      await writeFile(path.join(deck, "slides", "cover.mdx"), `${placed(slide)}\n\n# Talk\n\n${render}\n`);

      const build = fuseDeck(deck, ["build", "--json"]);
      const built = await builtText(path.join(deck, "dist"));

      const dev = await startDev(deck);
      const leaked: string[] = [];
      try {
        // The slide and each module or asset it imports, then the worker and the outside files, in
        // the order a page fetches them: Vite serves an outside file once a module imported it.
        const code = await (await fetch(new URL("slides/cover.mdx", dev.url))).text();
        const imports = [...code.matchAll(/(?:from |import\(|new URL\()"([^"]+)"/g)].flatMap(([, href]) =>
          href === undefined ? [] : [href]
        );
        const requests = [
          ...imports,
          "assets/worker.js",
          "assets/linked.js",
          "assets/linked/secret.js",
          `@fs${realpathSync(outside)}/secret.js`,
        ];
        for (const href of requests) {
          if ((await (await fetch(new URL(href, dev.url))).text()).includes(OUTSIDE_SECRET)) {
            leaked.push(href);
          }
        }
      } finally {
        await dev.stop();
      }
      expect({ built: built.includes(OUTSIDE_SECRET), served: leaked }).toEqual({ built: false, served: [] });
      expect(build.status).toBe(1);
      expect(oneDocument(build, Tagged).message).toContain(placed(named));
    }
  );

  it("inlines a deck's own CSS imports, keeps remote ones for the browser and fetches none in Node", async () => {
    const hits: string[] = [];
    const remote = createServer((request, response) => {
      hits.push(request.url ?? "");
      response.end(".remote {}");
    });
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(remote.address());
    const remoteUrl = `http://127.0.0.1:${String(port)}/font.css`;
    try {
      const deck = createDeck();
      const files = {
        // A comment that mentions `@import` is no import.
        "styles/deck.css": [
          `@import url("${remoteUrl}");`,
          '/* @import "theme"; */',
          '@import"./parts/base.css" layer(base);',
          "@import url(./print.css) print;",
          ".deck { color: blue; }",
          "",
        ].join("\n"),
        "styles/parts/base.css": '@import "./inner.css";\n.base { background: url(../image.png); }\n',
        "styles/parts/inner.css": ".inner { color: green; }\n",
        "styles/print.css": ".print { color: black; }\n",
        "styles/image.png": "png",
        "slides/cover.mdx": 'import "../styles/deck.css";\n\n# Talk\n',
      };
      for (const [file, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(deck, file)), { recursive: true });
        await writeFile(path.join(deck, file), text);
      }
      const build = fuseDeck(deck, ["build", "--json"]);
      expect(build.status, build.stderr).toBe(0);
      const assets = path.join(deck, "dist", "assets");
      const sheets = (await readdir(assets)).filter((name) => name.endsWith(".css"));
      const css = (await Promise.all(sheets.map((name) => readFile(path.join(assets, name), "utf8")))).join(
        "\n"
      );
      expect(css).toContain(remoteUrl);
      expect(css).toMatch(/@layer base\s*\{[^]*\.inner\s*\{[^]*\.base\s*\{/);
      expect(css).toMatch(/@media print\s*\{\s*\.print/);
      // The nested stylesheet's `url()` still names the image in `styles/`, which Vite inlines.
      expect(css).toContain(`data:image/png;base64,${Buffer.from("png").toString("base64")}`);

      const dev = await startDev(deck);
      try {
        const served = await (await fetch(new URL("styles/deck.css", dev.url))).text();
        expect(served).toContain(".inner");
      } finally {
        await dev.stop();
      }
      expect(hits).toEqual([]);
    } finally {
      await new Promise((resolve) => remote.close(resolve));
    }
  });

  it("build prints one document and writes the page", () => {
    const deck = createDeck();
    const run = fuseDeck(deck, ["build", "--json"]);
    expect(run.status, run.stderr).toBe(0);
    const built = oneDocument(run, Schema.TaggedStruct("DeckBuilt", { out: Schema.String }));
    expect(built.out).toBe(path.join(realpathSync(deck), "dist"));
    expect(existsSync(path.join(built.out, "index.html"))).toBe(true);

    // A directory outside the deck takes a second build, because the first one marked it as its own.
    const outside = ["build", "--out", "../site", "--json"];
    expect([fuseDeck(deck, outside).status, fuseDeck(deck, outside).status]).toEqual([0, 0]);
  });

  it("prints a failure document larger than a pipe's buffer whole before it exits", async () => {
    const deck = createDeck();
    // Each orphan adds a problem of about 250 bytes, so the document passes 64 KiB.
    for (let index = 0; index < 400; index += 1) {
      await writeFile(path.join(deck, "slides", `orphan-${String(index)}.mdx`), "# Orphan\n");
    }
    const run = fuseDeck(deck, ["check", "--json"]);
    expect(run.status).toBe(1);
    expect(run.stdout.length).toBeGreaterThan(64 * 1024);
    expect(oneDocument(run, CheckFailed).problems).toHaveLength(400);
  });

  it("keeps --help as text with exit 0", () => {
    const run = fuseDeck(workspace, ["--help", "--json"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("USAGE");
  });
});
