/**
 * The packed smoke test: fuse-deck's portability gate. It installs the packed fuse-deck and the
 * published Fuse release the workspace pins with npm in a directory outside the workspace, creates a deck in another directory
 * outside that install, gives a slide a Fuse component, and runs `create`, `describe`, `slides add`,
 * `check --json` and `build` through the `fuse-deck` command npm installed. It starts `mcp` in the
 * deck, lists its tools over stdio and checks that it exits 0 when stdin ends. It checks that the
 * skill `describe` names exists, and that the package refuses a deep import. It type-checks a
 * consumer module that imports from `@elmeragroup/fuse-deck/components` with the workspace's
 * TypeScript, through the package's `exports` and the React types the consumer installs, and checks
 * that a module passing a wrong prop does not. It then runs the built page's classic bootstrap and
 * checks the theme it applies before the module entry runs. Last, it serves the deck with `dev`,
 * renders both slides in Chromium, and stops the server with SIGINT. A second `dev` starts with a
 * slide that does not compile and must render it once it is repaired.
 *
 * Without a workspace, Fuse resolves to its built `dist` and React to the consumer's install, so
 * this is the check that fuse-deck's anchored `runnerImport` and its resolver work when installed.
 *
 * Usage: node scripts/packed-smoke.ts (after `pack`)
 */

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { chromium } from "playwright";
import type { Browser } from "playwright";

/** One step of the smoke test failed. */
class SmokeFailed extends Schema.TaggedError<SmokeFailed>()("SmokeFailed", {
  message: Schema.String,
}) {}

const packageRoot = path.resolve(import.meta.dirname, "..");

/** deck-core, whose development install holds the React types the runtime is written against. */
const deckCoreRoot = path.resolve(packageRoot, "..", "deck-core");

/** Mirrors `minimumReleaseAge` in pnpm-workspace.yaml, so npm resolves what the lockfile could. */
const RELEASE_AGE = Duration.minutes(4320);

/** The tarball `pack` left in a package's `.artifacts`. */
const tarball = Effect.fn("tarball")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = path.join(root, ".artifacts");
  const names = yield* fs
    .readDirectory(directory)
    .pipe(Effect.mapError(() => new SmokeFailed({ message: `No ${directory}. Run the pack task first.` })));
  const tarballs = names.filter((name) => name.endsWith(".tgz"));
  const [only] = tarballs;
  if (only === undefined || tarballs.length !== 1) {
    return yield* new SmokeFailed({
      message: `Expected one tarball in ${directory}, found ${String(tarballs.length)}.`,
    });
  }
  return path.join(directory, only);
});

/** Run a command to completion and return what it printed and its exit code. */
const exec = Effect.fn("exec")(function* (command: string, args: readonly string[], cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const label = `${path.basename(command)} ${args.join(" ")}`;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd,
          stdin: "ignore",
          forceKillAfter: Duration.seconds(2),
        })
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [text(handle.stdout), text(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" }
      );
      yield* Console.log(
        `$ ${label}  (in ${cwd})\n${stdout}${stderr === "" ? "" : `[stderr]\n${stderr}`}[exit ${String(exitCode)}]`
      );
      return { label, stdout, stderr, exitCode };
    })
  ).pipe(Effect.mapError((error) => new SmokeFailed({ message: `${label}: ${error.message}` })));
});

/** Run a command to completion and return its stdout; a non-zero exit fails with its output. */
const run = Effect.fn("run")(function* (command: string, args: readonly string[], cwd: string) {
  const { label, stdout, stderr, exitCode } = yield* exec(command, args, cwd);
  if (exitCode !== 0) {
    return yield* new SmokeFailed({ message: `${label} exited ${String(exitCode)}:\n${stderr}` });
  }
  return stdout;
});

function text<E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> {
  return stream.pipe(Stream.decodeText(), Stream.mkString);
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** A CLI result: the single JSON document a `--json` run prints. */
const Document = Schema.fromJsonString(Schema.Struct({ _tag: Schema.String }));

const expectDocument = Effect.fn("expectDocument")(function* (stdout: string, tag: string) {
  const document = yield* Schema.decodeEffect(Document)(stdout).pipe(
    Effect.mapError(() => new SmokeFailed({ message: `Expected one JSON document, got: ${stdout}` }))
  );
  if (document._tag !== tag) {
    return yield* new SmokeFailed({ message: `Expected ${tag}, got: ${stdout}` });
  }
});

/** `describe --json`'s pointer to the skill that ships in the package. */
const Vocabulary = Schema.fromJsonString(Schema.TaggedStruct("DeckVocabulary", { skill: Schema.String }));

/**
 * A module that imports a file inside fuse-deck's `dist` by its package path, and exits 0 only when
 * Node refuses it because the package exports no such path.
 */
const DEEP_IMPORT = `try {
  await import("@elmeragroup/fuse-deck/dist/runtime/main.js");
  process.exit(1);
} catch (error) {
  process.exit(error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? 0 : 1);
}`;

/** A consumer module that uses the components entry's values and types as documented. */
const TYPED_CONSUMER = `import { Bento, Metric, Metrics, SpotlightCard, Step } from "@elmeragroup/fuse-deck/components";
import type { BentoCursor, BentoProps, MetricProps, MetricsProps } from "@elmeragroup/fuse-deck/components";

const cursor: BentoCursor = { x: 180, y: 120, pressed: true };
const layout: BentoProps = { columns: 3, rows: 2, gap: 24, spotlight: true, cursor };
const band: MetricsProps = { columns: 4, dividers: true, size: "default", align: "start" };
const item: MetricProps = { value: "94", label: "Components", detail: "Forms and charts" };

export function Demo() {
  return (
    <>
      <Metrics {...band}>
        <Metric {...item} />
      </Metrics>
      <Bento {...layout}>
        <SpotlightCard colSpan={2} title="Typed" description="Through exports">
          <Step index="1">Revealed</Step>
        </SpotlightCard>
      </Bento>
    </>
  );
}
`;

/** A consumer module passing a row count `<Bento>` does not accept. */
const WRONG_PROP_CONSUMER = `import { Bento } from "@elmeragroup/fuse-deck/components";

export function Demo() {
  return <Bento rows={1} />;
}
`;

/**
 * Type-check each consumer module on its own with the workspace's TypeScript, in strict mode and
 * with library checks on, so the shipped declarations resolve through the installed package's
 * `exports` alone. The documented module must pass and the wrong prop must fail with TS2322.
 */
const typeCheckComponents = Effect.fn("typeCheckComponents")(function* (consumer: string) {
  const fs = yield* FileSystem.FileSystem;
  const tsc = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  const check = (file: string) =>
    exec(
      process.execPath,
      [
        tsc,
        "--strict",
        "--noEmit",
        "--jsx",
        "react-jsx",
        "--module",
        "preserve",
        "--moduleResolution",
        "bundler",
        "--target",
        "es2022",
        file,
      ],
      consumer
    );
  yield* fs.writeFileString(path.join(consumer, "typed.tsx"), TYPED_CONSUMER);
  yield* fs.writeFileString(path.join(consumer, "wrong-prop.tsx"), WRONG_PROP_CONSUMER);
  const typed = yield* check("typed.tsx");
  if (typed.exitCode !== 0) {
    return yield* new SmokeFailed({
      message: `The components consumer did not type-check:\n${typed.stdout}${typed.stderr}`,
    });
  }
  const wrong = yield* check("wrong-prop.tsx");
  if (wrong.exitCode === 0 || !wrong.stdout.includes("TS2322")) {
    return yield* new SmokeFailed({
      message: `A wrong <Bento> prop did not fail with TS2322 (exit ${String(wrong.exitCode)}):\n${wrong.stdout}${wrong.stderr}`,
    });
  }
});

/** What the bootstrap does to the document when it runs as a classic script. */
function runBootstrap(source: string, stored: string | null, systemDark: boolean): string | null {
  let scheme: string | null = null;
  runInNewContext(source, {
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) => (scheme = name === "data-theme" ? value : scheme),
      },
    },
    localStorage: { getItem: () => stored },
    window: { matchMedia: () => ({ matches: systemDark }) },
    globalThis: {},
  });
  return scheme;
}

const smoke = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const deckTarball = yield* tarball(packageRoot);
  const consumer = yield* fs.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "fuse-deck-packed-" });
  const decks = yield* fs.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "fuse-deck-decks-" });

  // The Fuse release the workspace tests against, fetched as a tarball first: pnpm-workspace.yaml
  // exempts that in-house canary from the release age, and the install's `--before` would not.
  const fuseTarballs = yield* fs.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "fuse-deck-fuse-" });
  const fuseVersion = yield* installedVersion("@elmeragroup/fuse");
  const fuseTarball = path.join(
    fuseTarballs,
    (yield* run(
      "npm",
      ["pack", `@elmeragroup/fuse@${fuseVersion}`, "--pack-destination", fuseTarballs, "--silent"],
      fuseTarballs
    )).trim()
  );

  // The consumer installs the React, and the React types, this workspace tests against.
  const react = yield* installedVersion("react");
  const reactTypes = yield* installedVersion("@types/react", deckCoreRoot);
  yield* fs.writeFileString(
    path.join(consumer, "package.json"),
    yield* encodeJson({
      private: true,
      type: "module",
      dependencies: {
        "@elmeragroup/fuse": `file:${fuseTarball}`,
        "@elmeragroup/fuse-deck": `file:${deckTarball}`,
        react,
        "react-dom": react,
        "@types/react": reactTypes,
      },
    })
  );
  const cutoff = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, RELEASE_AGE));
  // npm writes package-lock.json, as an install does by default. fuse-deck keys the deck's optimizer
  // cache by it, so the second `dev` below starts from what the first one optimized.
  yield* run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", `--before=${cutoff}`],
    consumer
  );

  // The command npm linked for the package's `bin`, as an agent in the consumer runs it. Its
  // `#!/usr/bin/env node` finds the Node pnpm put first on PATH for this script.
  const bin = path.join(consumer, "node_modules", ".bin", "fuse-deck");
  const fuseDeck = (args: readonly string[], cwd: string) => run(bin, args, cwd);
  yield* expectDocument(
    yield* fuseDeck(["create", "talk", "--brief", "Packed smoke.", "--json"], decks),
    "DeckCreated"
  );
  const deck = path.join(decks, "talk");

  const { skill } = yield* Schema.decodeEffect(Vocabulary)(
    yield* fuseDeck(["describe", "--json"], deck)
  ).pipe(Effect.mapError((error) => new SmokeFailed({ message: `describe --json: ${error.message}` })));
  const installedSkill = path.join(
    consumer,
    "node_modules",
    "@elmeragroup",
    "fuse-deck",
    "skill",
    "SKILL.md"
  );
  if ((yield* fs.realPath(skill)) !== (yield* fs.realPath(installedSkill))) {
    return yield* new SmokeFailed({
      message: `describe names ${skill}, not the installed ${installedSkill}.`,
    });
  }
  yield* run(process.execPath, ["--input-type=module", "--eval", DEEP_IMPORT], consumer);
  yield* typeCheckComponents(consumer);
  yield* expectDocument(yield* fuseDeck(["slides", "add", "intro", "--json"], deck), "SlideAdded");
  yield* fs.writeFileString(path.join(deck, "slides", "intro.mdx"), INTRO);
  yield* expectDocument(yield* fuseDeck(["check", "--json"], deck), "DeckChecked");
  yield* expectDocument(yield* fuseDeck(["build", "--json"], deck), "DeckBuilt");
  yield* listMcpTools(bin, deck);

  const html = yield* fs.readFileString(path.join(deck, "dist", "index.html"));
  const root = /<html\b[^>]*>/.exec(html)?.[0] ?? "";
  for (const attribute of [
    'data-theme-identity="neutral"',
    'data-theme-brand="elma"',
    'data-theme-segment="private"',
    'data-density="comfortable"',
  ]) {
    if (!root.includes(attribute)) {
      return yield* new SmokeFailed({ message: `<html> lacks ${attribute}: ${root}` });
    }
  }
  const stylesheet = html.search(/<link[^>]*rel="stylesheet"/);
  const bootstrap = /<script>([\s\S]*?)<\/script>/.exec(html);
  const entry = html.search(/<script[^>]*type="module"/);
  if (bootstrap === null || stylesheet === -1 || !(stylesheet < bootstrap.index && bootstrap.index < entry)) {
    return yield* new SmokeFailed({
      message: "The page must link the stylesheet, then run the bootstrap, then load the module entry.",
    });
  }
  const source = bootstrap[1] ?? "";
  const cases = [
    { stored: null, systemDark: false, expected: "light" },
    { stored: null, systemDark: true, expected: "dark" },
    { stored: "light", systemDark: true, expected: "light" },
    { stored: "dark", systemDark: false, expected: "dark" },
  ];
  for (const { stored, systemDark, expected } of cases) {
    const applied = runBootstrap(source, stored, systemDark);
    if (applied !== expected) {
      return yield* new SmokeFailed({
        message: `The bootstrap applied ${String(applied)} with storage ${String(stored)} and a ${systemDark ? "dark" : "light"} system, not ${expected}.`,
      });
    }
  }
  yield* serveAndRender(bin, deck);
  yield* Console.log(
    "Packed smoke passed: create, describe, slides add, check, build, mcp and dev ran through the installed fuse-deck command, describe named the installed skill, a deep import failed, a consumer of the components entry type-checked and a wrong prop did not, the bootstrap applied each scheme, the dev server rendered both slides in Chromium, and a second dev server recovered from a broken first load."
  );
}).pipe(Effect.scoped);

/** One JSON-RPC response `mcp` writes: every stdout line must be one, answering the request sent. */
const McpResponse = Schema.fromJsonString(
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: Schema.Finite, result: Schema.Unknown })
);

const McpToolList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) });

/** The six deck tools `mcp` serves. */
const DECK_TOOLS = ["check", "describe", "slides_add", "slides_list", "slides_move", "slides_remove"];

/**
 * Start the installed `mcp` in the deck and send it an initialize and a tool list on stdin, which
 * then ends. The server answers what it read before it exits, so stdout must hold exactly the two
 * answers, and the process must exit 0.
 */
const listMcpTools = Effect.fn("listMcpTools")(
  function* (bin: string, deck: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "packed-smoke", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const input = (yield* Effect.forEach(requests, (request) => encodeJson(request), { concurrency: 1 })).map(
      (line) => `${line}\n`
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* spawner.spawn(
          ChildProcess.make(bin, ["mcp"], {
            cwd: deck,
            stdin: Stream.make(new TextEncoder().encode(input.join(""))),
            forceKillAfter: Duration.seconds(2),
          })
        );
        yield* Console.log(`$ fuse-deck mcp  (in ${deck}, pid ${String(server.pid)})`);
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [text(server.stdout), text(server.stderr), server.exitCode],
          { concurrency: "unbounded" }
        ).pipe(
          Effect.timeout("60 seconds"),
          Effect.mapError((error) =>
            error._tag === "TimeoutError"
              ? new SmokeFailed({ message: "mcp did not exit within 60 s of stdin ending." })
              : error
          )
        );
        yield* Console.log(
          `${stdout}${stderr === "" ? "" : `[stderr]\n${stderr}`}[exit ${String(exitCode)}]`
        );
        const lines = stdout.split("\n").filter((line) => line !== "");
        const responses = yield* Effect.forEach(
          lines,
          (line) =>
            Schema.decodeEffect(McpResponse)(line).pipe(
              Effect.mapError(
                () => new SmokeFailed({ message: `mcp wrote something other than a response: ${line}` })
              )
            ),
          { concurrency: 1 }
        );
        const [initialized, listed] = responses;
        if (responses.length !== 2 || initialized?.id !== 1 || listed?.id !== 2) {
          return yield* new SmokeFailed({
            message: `mcp wrote ${String(lines.length)} lines, not the two answers.`,
          });
        }
        const { tools } = yield* Schema.decodeUnknownEffect(McpToolList)(listed.result);
        const names = tools.map((tool) => tool.name).toSorted();
        if (names.join(",") !== DECK_TOOLS.join(",")) {
          return yield* new SmokeFailed({
            message: `mcp listed ${names.join(", ")}, not ${DECK_TOOLS.join(", ")}.`,
          });
        }
        if (exitCode !== 0) {
          return yield* new SmokeFailed({
            message: `mcp exited ${String(exitCode)} when stdin ended, not 0.`,
          });
        }
      })
    );
  },
  Effect.mapError((error) =>
    error._tag === "SmokeFailed" ? error : new SmokeFailed({ message: `mcp: ${error.message}` })
  )
);

/** `dev --json`'s readiness document. */
const DevServerReady = Schema.fromJsonString(Schema.TaggedStruct("DevServerReady", { url: Schema.String }));
const decodeReady = Schema.decodeUnknownOption(DevServerReady);

/** The deck's title, which labels its cover slide. */
const DeckTitle = Schema.fromJsonString(Schema.Struct({ title: Schema.String }));

/** The intro slide the smoke writes: a Fuse Button, imported from a deck outside the install. */
const INTRO =
  'import { Button } from "@elmeragroup/fuse/button";\n\n# Intro\n\n<Step>One</Step>\n\n<Step>Two</Step>\n\n<Button>Ask</Button>\n';

/** The intro slide with a `<Step>` inside an expression, which the slide compile rejects. */
const BROKEN_INTRO = "# Intro\n\n{<Step>later</Step>}\n";

/**
 * Serve the deck with the installed `dev` twice. The first server renders the cover slide and the
 * slide with the Fuse Button in Chromium. The second starts with the intro slide broken, shows
 * Vite's error overlay, and renders the slide once the file is repaired, with no reload from the
 * test. Each server stops on SIGINT to its PID and must exit 130.
 */
const serveAndRender = Effect.fn("serveAndRender")(
  function* (bin: string, deck: string) {
    const fs = yield* FileSystem.FileSystem;
    const { title } = yield* Schema.decodeEffect(DeckTitle)(
      yield* fs.readFileString(path.join(deck, "deck.json"))
    );
    const slide = path.join(deck, "slides", "intro.mdx");
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    yield* serveWith(bin, deck, "renders both slides", (browser, url) => renderDeck(browser, url, title));
    yield* fs.writeFileString(slide, BROKEN_INTRO);
    yield* serveWith(bin, deck, "recovers from a broken first load", (browser, url) =>
      recoverFromBrokenLoad(browser, url, () => runPromise(fs.writeFileString(slide, INTRO)))
    );
  },
  Effect.mapError((error) =>
    error._tag === "SmokeFailed" ? error : new SmokeFailed({ message: `dev: ${error.message}` })
  )
);

/**
 * Start `dev --json` in the deck, run `drive` against its address in Chromium, then stop the server
 * with SIGINT and check that it exits 130.
 *
 * @param step - What the step checks, for the log and the failure.
 * @param drive - Opens the page and returns its errors, empty when it behaved.
 */
const serveWith = Effect.fn("serveWith")(function* (
  bin: string,
  deck: string,
  step: string,
  drive: (browser: Browser, url: string) => Promise<string[]>
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Effect.scoped(
    Effect.gen(function* () {
      // The scope kills the server if a step below fails before the SIGINT.
      const server = yield* spawner.spawn(
        ChildProcess.make(bin, ["dev", "--json"], {
          cwd: deck,
          stdin: "ignore",
          forceKillAfter: Duration.seconds(2),
        })
      );
      yield* Console.log(`$ fuse-deck dev --json  (${step}; in ${deck}, pid ${String(server.pid)})`);
      const stderr = yield* Effect.forkScoped(text(server.stderr));
      const ready = yield* server.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filterMap((line) => Result.fromOption(decodeReady(line), () => line)),
        Stream.runHead,
        Effect.timeout("60 seconds")
      );
      if (Option.isNone(ready)) {
        return yield* new SmokeFailed({
          message: "dev --json closed stdout without a readiness document.",
        });
      }
      const { url } = ready.value;
      yield* Console.log(`ready at ${url}`);

      const pageErrors = yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => chromium.launch({ headless: true }),
          catch: (cause) => new SmokeFailed({ message: `Chromium did not launch: ${String(cause)}` }),
        }),
        (browser) => Effect.promise(() => drive(browser, url)),
        (browser) => Effect.promise(() => browser.close()).pipe(Effect.ignore)
      );

      // stderr ends only when the server exits, so stop it before reading what it logged.
      // `kill` waits for the exit, so the 10 s limit sits on the kill itself: after it the server
      // gets SIGKILL, its exit code is a signal rather than a number, and the step fails.
      yield* server.kill({ killSignal: "SIGINT", forceKillAfter: Duration.seconds(10) });
      const exited = yield* Effect.result(server.exitCode);
      const status = Result.isSuccess(exited)
        ? `exited ${String(exited.success)}`
        : `did not exit by itself (${exited.failure.message})`;
      yield* Console.log(`dev ${status} on SIGINT\n[stderr]\n${yield* Fiber.join(stderr)}`);
      if (pageErrors.length > 0) {
        return yield* new SmokeFailed({
          message: `The dev page ${step}, but reported errors:\n${pageErrors.join("\n")}`,
        });
      }
      if (!Result.isSuccess(exited) || exited.success !== 130) {
        return yield* new SmokeFailed({ message: `dev ${status} within 10 s of SIGINT, not exit 130.` });
      }
    })
  );
});

/**
 * Open the deck, wait for the cover slide, step to the intro slide and wait for its Fuse Button.
 *
 * @returns The page errors, console errors and failed steps, empty when the deck rendered cleanly.
 */
async function renderDeck(browser: Browser, url: string, title: string): Promise<string[]> {
  const errors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(`console.error: ${message.text()}`);
      }
    });
    const slide = page.locator('section[aria-roledescription="slide"]');
    await page.goto(url);
    await slide.and(page.getByRole("region", { name: title })).waitFor({ timeout: 30_000 });
    // The cover has no steps, so one ArrowRight opens the intro slide.
    await page.keyboard.press("ArrowRight");
    await slide.and(page.getByRole("region", { name: "Intro" })).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Ask" }).waitFor({ timeout: 10_000 });
  } catch (error) {
    errors.push(`render: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

/**
 * Open the intro slide while it does not compile and wait for Vite's error overlay. Then repair the
 * file and wait for the slide and its Fuse Button, without reloading the page. The broken load
 * logs errors by design, so only a missing overlay or a slide that never renders counts.
 *
 * @param repair - Writes the slide's working text.
 * @returns The failed steps, empty when the page recovered.
 */
async function recoverFromBrokenLoad(
  browser: Browser,
  url: string,
  repair: () => Promise<void>
): Promise<string[]> {
  try {
    const page = await browser.newPage();
    await page.goto(`${url}#/intro`);
    await page.locator("vite-error-overlay").waitFor({ state: "attached", timeout: 30_000 });
    await repair();
    // `dev` polls the deck every 100 ms, so the repair reaches the server at once. Without the
    // reload after a failed load, the slide never renders.
    const slide = page.locator('section[aria-roledescription="slide"]');
    await slide.and(page.getByRole("region", { name: "Intro" })).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Ask" }).waitFor({ timeout: 10_000 });
    return [];
  } catch (error) {
    return [`recover: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/** The version of a package this workspace installed for the package at `root`, fuse-deck by default. */
const installedVersion = Effect.fn("installedVersion")(function* (name: string, root: string = packageRoot) {
  const fs = yield* FileSystem.FileSystem;
  const manifest = yield* fs.readFileString(path.join(root, "node_modules", name, "package.json"));
  const { version } = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
  )(manifest);
  return version;
});

smoke.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
