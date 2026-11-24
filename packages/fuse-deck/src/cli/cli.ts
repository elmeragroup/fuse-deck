/**
 * The `fuse-deck` command line. It parses argv, runs a command over the deck and reports the
 * result in the output mode argv asked for. A command line that does not parse exits 2, a domain
 * failure exits 1.
 */

import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpServer from "effect/ai/McpServer";
import * as Cause from "effect/Cause";
import * as Argument from "effect/cli/Argument";
import * as CliConfig from "effect/cli/CliConfig";
import * as CliError from "effect/cli/CliError";
import * as CliOutput from "effect/cli/CliOutput";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import { DEFAULT_OUT } from "@elmeragroup/deck-core/bundler/build-output";
import { Bundler } from "@elmeragroup/deck-core/bundler/bundler";
import { DeckFiles } from "@elmeragroup/deck-core/deck/deck-files";
import {
  addSlide,
  checkDeckDocument,
  listSlides,
  moveSlide,
  removeSlide,
} from "@elmeragroup/deck-core/deck/deck-operations";
import { describeDeck } from "@elmeragroup/deck-core/deck/describe";
import type { DeckVocabularyDocument } from "@elmeragroup/deck-core/deck/describe";
import { DEFAULT_THEME, scaffoldDeck } from "@elmeragroup/deck-core/deck/scaffold";
import { SlideId } from "@elmeragroup/deck-core/deck/slide-id";
import * as Vocabulary from "@elmeragroup/deck-core/deck/vocabulary";
import { deckToolsForDeck } from "@elmeragroup/deck-core/tools/deck-tools";

import packageJson from "../../package.json" with { type: "json" };
import { runtimeRoot, shippedSkillPath, userCacheRoot } from "../package-root.ts";
import { jsonPresenter, Output, outputModeFromArgv, printDocument, reply, reportFailure } from "./output.ts";
import type { ReportableError } from "./output.ts";

/**
 * `--json`, accepted before or after any subcommand. The run reads its mode from argv before
 * parsing, so a command line that does not parse still answers in JSON; the parsed value is unused.
 */
const Json = GlobalFlag.Setting("json")({
  flag: Flag.Boolean("json").pipe(
    Flag.withDescription("Print exactly one JSON document on stdout, including for failures."),
    Flag.withDefault(false)
  ),
});

/** The deck in the working directory or the nearest one above it. */
const deckLayer = Layer.suspend(() => DeckFiles.layerFrom(process.cwd()));

/** The deck and the bundler over it, serving the runtime this package ships. */
const bundlerLayer = Layer.suspend(() =>
  Bundler.layer({ runtimeRoot: runtimeRoot(), cacheRoot: userCacheRoot() })
).pipe(Layer.provideMerge(deckLayer));

const create = Command.make(
  "create",
  {
    directory: Argument.String("dir").pipe(
      Argument.withDescription("The new deck's directory. It may exist if empty.")
    ),
    brief: Flag.String("brief").pipe(
      Flag.withDescription(
        "What the talk is for. BRIEF.md keeps it verbatim and the cover slide shows its first line."
      ),
      Flag.withMetavar("text"),
      Flag.optional
    ),
    theme: Flag.String("theme").pipe(
      Flag.withDescription(`A Fuse theme slug, <identity>-<brand>-<segment>. Default: ${DEFAULT_THEME}.`),
      Flag.withMetavar("slug"),
      Flag.withDefault(DEFAULT_THEME)
    ),
  },
  Effect.fn("cli.create")(function* (input) {
    const created = yield* scaffoldDeck(input);
    const next = [
      `cd ${created.root}`,
      "fuse-deck describe --json",
      "fuse-deck slides add <id> --title <text>",
      "fuse-deck check --json",
      "fuse-deck dev",
    ];
    yield* reply({
      document: { _tag: "DeckCreated", root: created.root, files: created.files, next },
      text: [
        `Created a deck in ${created.root}:`,
        ...created.files.map((file) => `  ${file}`),
        "",
        "Next:",
        ...next.map((step) => `  ${step}`),
      ].join("\n"),
    });
  })
).pipe(Command.withDescription("Scaffold a new deck: deck.json, a cover slide, BRIEF.md and AGENTS.md"));

const describe = Command.make(
  "describe",
  {},
  Effect.fn("cli.describe")(function* () {
    const document = describeDeck(shippedSkillPath());
    yield* reply({ document, text: describeText(document) });
  })
).pipe(
  Command.withDescription(
    "Print every layout, component, frontmatter key, setting and command, and the path of the shipped skill, as one document"
  )
);

const list = Command.make(
  "list",
  {},
  Effect.fn("cli.slides.list")(function* () {
    const document = yield* listSlides();
    yield* reply({
      document,
      text:
        document.slides.length === 0
          ? "The deck has no slides."
          : document.slides
              .map(
                (slide, index) =>
                  `${String(index + 1)}. ${slide.id}  ${slide.title ?? "(no title)"}  [${slide.layout ?? "unreadable"}]`
              )
              .join("\n"),
    });
  })
).pipe(
  Command.withDescription("List the slides in order, with each one's title and layout"),
  Command.provide(deckLayer)
);

const slideIdArgument = Argument.String("id").pipe(Argument.withSchema(SlideId));
const anchorFlag = (name: "after" | "before", description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.withMetavar("id"),
    Flag.withSchema(SlideId),
    Flag.optional
  );

const add = Command.make(
  "add",
  {
    id: slideIdArgument.pipe(
      Argument.withDescription("The new slide's id: lowercase letters, digits and dashes.")
    ),
    after: anchorFlag("after", "Put the new slide after this one. Default: at the end."),
    layout: Flag.Literals("layout", Vocabulary.LAYOUT_NAMES).pipe(
      Flag.withDescription(`The slide's layout. Default: ${Vocabulary.DEFAULT_LAYOUT}.`),
      Flag.optional
    ),
    title: Flag.String("title").pipe(
      Flag.withDescription("The slide's first heading. Default: the id in words."),
      Flag.withMetavar("text"),
      Flag.optional
    ),
  },
  Effect.fn("cli.slides.add")(function* (slide) {
    const document = yield* addSlide(slide);
    yield* reply({ document, text: `Added ${document.path}.\n${orderText(document.order)}` });
  })
).pipe(Command.withDescription("Create slides/<id>.mdx and add it to the order"), Command.provide(deckLayer));

const move = Command.make(
  "move",
  {
    id: slideIdArgument.pipe(Argument.withDescription("The slide to move.")),
    after: anchorFlag("after", "Move it after this slide."),
    before: anchorFlag("before", "Move it before this slide."),
  },
  Effect.fn("cli.slides.move")(function* ({ id, after, before }) {
    const position = Option.getOrThrowWith(
      Option.orElse(
        Option.map(after, (anchor) => ({ _tag: "After", anchor }) as const),
        () => Option.map(before, (anchor) => ({ _tag: "Before", anchor }) as const)
      ),
      () => new Error("The move validation lets only one anchor through.")
    );
    const document = yield* moveSlide(id, position);
    yield* reply({ document, text: `Moved ${id}.\n${orderText(document.order)}` });
  })
).pipe(
  Command.validate(({ after, before }) =>
    Option.isSome(after) === Option.isSome(before)
      ? Effect.fail(new CliError.ValidationError({ message: "Pass exactly one of --after and --before." }))
      : Effect.void
  ),
  Command.withDescription("Move a slide in the order"),
  Command.provide(deckLayer)
);

const remove = Command.make(
  "remove",
  { id: slideIdArgument.pipe(Argument.withDescription("The slide to remove.")) },
  Effect.fn("cli.slides.remove")(function* ({ id }) {
    const document = yield* removeSlide(id);
    yield* reply({
      document,
      text: `Removed ${id} and deleted ${document.path}.\n${orderText(document.order)}`,
    });
  })
).pipe(
  Command.withDescription("Take a slide out of the order and delete its file"),
  Command.provide(deckLayer)
);

const slides = Command.make("slides").pipe(
  Command.withDescription("List, add, move and remove slides, keeping deck.json and the files in step"),
  // Each subcommand finds the deck itself, so `slides` without one reports a usage error from
  // anywhere instead of failing to find a deck first.
  Command.withSubcommands([list, add, move, remove])
);

const check = Command.make(
  "check",
  {},
  Effect.fn("cli.check")(function* () {
    const document = yield* checkDeckDocument();
    yield* reply({
      document,
      text: `The deck's ${String(document.slides)} slides compile, with ${String(document.steps)} steps in all. Theme: ${document.theme}.`,
    });
  })
).pipe(
  Command.withDescription(
    "Report dangling ids, orphan files, invalid frontmatter, slides that do not compile and an invalid theme; exit 1 when there are any"
  ),
  Command.provide(bundlerLayer)
);

const dev = Command.make(
  "dev",
  {
    port: Flag.Int("port").pipe(
      Flag.withDescription("The port to serve on. Default: Vite's, 5173, or the next free one."),
      Flag.optional
    ),
  },
  Effect.fn("cli.dev")(function* ({ port }) {
    const bundler = yield* Bundler;
    const server = yield* bundler.dev({ _tag: "Standalone", port });
    yield* reply({
      document: { _tag: "DevServerReady", url: server.url },
      text: `Serving the deck at ${server.url}. Press Ctrl-C to stop.`,
    });
    return yield* Effect.never;
  }, Effect.scoped)
).pipe(
  Command.withDescription("Serve the deck on 127.0.0.1 with live reload until interrupted"),
  Command.provide(bundlerLayer)
);

const build = Command.make(
  "build",
  {
    out: Flag.String("out").pipe(
      Flag.withDescription(
        `The output directory, relative to the deck. It must not hold the deck or sit in slides/, and an existing one must be empty or an earlier build's. Default: ${DEFAULT_OUT}.`
      ),
      Flag.withMetavar("dir"),
      Flag.withDefault(DEFAULT_OUT)
    ),
  },
  Effect.fn("cli.build")(function* ({ out }) {
    const bundler = yield* Bundler;
    const built = yield* bundler.build(out);
    yield* reply({
      document: { _tag: "DeckBuilt", out: built.out },
      text: `Built the deck into ${built.out}.`,
    });
  })
).pipe(Command.withDescription("Build the deck into static files"), Command.provide(bundlerLayer));

/**
 * The MCP revisions `mcp` serves, newest first. A client that offers another revision gets the
 * first one, as the MCP handshake allows.
 */
const MCP_PROTOCOLS = [
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const;

const mcp = Command.make(
  "mcp",
  {},
  Effect.fn("cli.mcp")(function* () {
    // Stdout carries only MCP messages from here on: the server owns it until stdin ends.
    return yield* Layer.launch(
      McpServer.layerStdio({
        name: "fuse-deck",
        version: packageJson.version,
        instructions:
          "These tools edit the fuse-deck deck in the directory the server started in. Call describe first, then slides_add for each slide and write its content in slides/<id>.mdx. Run check after each round of edits.",
        protocols: MCP_PROTOCOLS,
        registrations: deckToolsForDeck(shippedSkillPath()),
      })
    );
  })
).pipe(
  Command.withDescription(
    "Serve describe, slides list, add, move and remove, and check as MCP tools over stdio, for the deck in the working directory, until stdin ends"
  ),
  Command.provide(bundlerLayer)
);

const cli = Command.make("fuse-deck").pipe(
  Command.withDescription(
    "Build Fuse-themed slide decks from MDX. Agents start with `fuse-deck describe --json`."
  ),
  Command.withGlobalFlags([Json]),
  Command.withSubcommands([create, describe, slides, check, dev, build, mcp])
);

function orderText(order: readonly SlideId[]): string {
  return `Order: ${order.join(", ")}`;
}

function describeText(document: DeckVocabularyDocument): string {
  const section = (title: string, rows: ReadonlyArray<readonly [string, string]>) =>
    [title, ...rows.map(([name, summary]) => `  ${name}\n    ${summary}`)].join("\n");
  return [
    section(
      "LAYOUTS",
      document.layouts.map(({ name, summary }) => [name, summary])
    ),
    section(
      "FRONTMATTER",
      document.frontmatter.map(({ name, summary }) => [name, summary])
    ),
    section(
      "COMPONENTS",
      document.components.map(({ usage, summary }) => [usage, summary])
    ),
    section(
      "DECK.JSON",
      document.deck.map(({ name, summary }) => [name, summary])
    ),
    section(
      "FILES",
      document.files.map(({ path, summary }) => [path, summary])
    ),
    section(
      "COMMANDS",
      document.commands.map(({ usage, summary }) => [usage, summary])
    ),
    section("SKILL", [[document.skill, "The workflow for writing a deck. Open it before the first slide."]]),
  ].join("\n\n");
}

/** The exit status of a failed run: 2 for a command line that does not parse, 1 otherwise. */
const ExitCode = Schema.Literals([1, 2]);

/**
 * A failure the run has already reported. The runtime exits with its status but does not log it
 * again with a stack trace.
 */
class ReportedFailure extends Schema.TaggedError<ReportedFailure>()("ReportedFailure", {
  exitCode: ExitCode,
}) {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = this.exitCode;
}

/** A command line that did not parse. The presenter has reported it, so this only sets exit 2. */
function usage(_error: CliError.CliError): Effect.Effect<never, ReportedFailure> {
  return Effect.fail(new ReportedFailure({ exitCode: 2 }));
}

function report(error: ReportableError): Effect.Effect<never, ReportedFailure> {
  return reportFailure(error).pipe(Effect.andThen(Effect.fail(new ReportedFailure({ exitCode: 1 }))));
}

/**
 * In JSON mode a defect still answers with one document, so stdout always parses. Interrupts and
 * reported failures pass through.
 */
function reportDefect(cause: Cause.Cause<ReportedFailure>): Effect.Effect<never, ReportedFailure> {
  return Cause.hasDies(cause)
    ? printDocument({ _tag: "UnexpectedError", message: Cause.pretty(cause) }).pipe(
        Effect.andThen(Effect.fail(new ReportedFailure({ exitCode: 1 })))
      )
    : Effect.failCause(cause);
}

/** Only `--help`, `--version` and `--log-level`; the wizard and completions write to stdout themselves. */
const BUILT_INS = [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.LogLevel];

/**
 * Run the command line. A failure type without a `_tag` and a `message` does not compile here, so
 * no new error can skip the report.
 *
 * @param argv - The arguments after the executable and script path.
 */
export const runCli = (argv: readonly string[]) => {
  const mode = outputModeFromArgv(argv);
  const run = Command.runWith(cli, { version: packageJson.version })(argv).pipe(
    Effect.catchIf(CliError.isCliError, usage, report)
  );
  return (mode === "json" ? run.pipe(Effect.catchCause(reportDefect)) : run).pipe(
    Effect.provideService(Output, mode),
    Effect.provide([
      CliConfig.layer({ builtIns: BUILT_INS }),
      mode === "json" ? CliOutput.layerPresenter(jsonPresenter) : Layer.empty,
    ])
  );
};
