import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as McpProtocol from "effect/ai/McpProtocol";
import type * as McpSchema from "effect/ai/McpSchema";
import * as McpTest from "effect/ai/McpTest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Bundler } from "../src/bundler/bundler.ts";
import { DeckFiles } from "../src/deck/deck-files.ts";
import { scaffoldDeck } from "../src/deck/scaffold.ts";
import { deckToolsForDeck } from "../src/tools/deck-tools.ts";

/** The skill path the host hands the tools; `describe` must name it as given. */
const SKILL = "/opt/fuse-deck/skill/SKILL.md";

const THEME = "neutral-elma-private";

const tempDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), "fuse-deck-tools-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
);

/**
 * Run `body` with an MCP client of the deck tools, bound to a new deck from `create` whose order
 * holds one slide, `cover`.
 */
const withTools = Effect.fnUntraced(
  function* <A, E>(body: (client: McpTest.Client, root: string) => Effect.Effect<A, E>) {
    const root = path.join(yield* tempDir, "deck");
    yield* scaffoldDeck({ directory: root, brief: Option.none(), theme: THEME });
    // No page is served here, so the runtime directory is never read.
    const deck = Bundler.layer({
      runtimeRoot: path.join(root, "no-runtime"),
      cacheRoot: path.join(root, "..", "cache"),
    }).pipe(Layer.provideMerge(DeckFiles.layerFrom(root)), Layer.provide(NodeServices.layer));
    const client = yield* McpTest.makeClient(deckToolsForDeck(SKILL), {
      protocols: [McpProtocol.v2025_11_25],
    }).pipe(Effect.provide(deck));
    return yield* body(client, root);
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer)
);

const Manifest = Schema.fromJsonString(Schema.Struct({ order: Schema.Array(Schema.String) }));

/** The order in `deck.json`, read from disk. */
const orderOnDisk = (root: string) =>
  Effect.promise(() => readFile(path.join(root, "deck.json"), "utf8")).pipe(
    Effect.flatMap(Schema.decodeEffect(Manifest)),
    Effect.map((manifest) => manifest.order),
    Effect.orDie
  );

const slideOnDisk = (root: string, id: string) =>
  Effect.promise(() => readFile(path.join(root, "slides", `${id}.mdx`), "utf8"));

const Failure = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.String,
    message: Schema.String,
    hint: Schema.optionalKey(Schema.String),
    id: Schema.optionalKey(Schema.String),
    problems: Schema.optionalKey(
      Schema.Array(Schema.Struct({ _tag: Schema.String, path: Schema.optionalKey(Schema.String) }))
    ),
  })
);

/** A call that the tool answered with an error result, decoded as the command's failure document. */
const failureOf = Effect.fnUntraced(function* (result: McpSchema.CallToolResult) {
  assert.isTrue(result.isError, "the call should fail");
  const [first] = result.content;
  if (first?.type !== "text") {
    return yield* Effect.die(`Expected one text block, got ${String(first?.type)}`);
  }
  return yield* Schema.decodeEffect(Failure)(first.text).pipe(Effect.orDie);
});

/** The text of a call refused before its tool ran, such as one with invalid parameters. */
const refusalOf = (result: McpSchema.CallToolResult) => {
  assert.isTrue(result.isError, "the call should be refused");
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
};

/** A call that succeeded, with its structured document. */
const documentOf = (result: McpSchema.CallToolResult) => {
  assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
  return result.structuredContent;
};

describe("deck tools over MCP", () => {
  it.effect(
    "lists the six tools, read-only where they only read, with the parameters their commands take",
    () =>
      withTools((client) =>
        Effect.gen(function* () {
          const { tools } = yield* client.listTools();
          const byName = new Map(tools.map((tool) => [tool.name, tool]));
          assert.deepStrictEqual(tools.map((tool) => tool.name).toSorted(), [
            "check",
            "describe",
            "slides_add",
            "slides_list",
            "slides_move",
            "slides_remove",
          ]);
          const parameters = (name: string) =>
            Object.keys(byName.get(name)?.inputSchema.properties ?? {}).toSorted();
          assert.deepStrictEqual(parameters("describe"), []);
          assert.deepStrictEqual(parameters("slides_list"), []);
          assert.deepStrictEqual(parameters("check"), []);
          assert.deepStrictEqual(parameters("slides_add"), ["after", "id", "layout", "title"]);
          assert.deepStrictEqual(parameters("slides_move"), ["after", "before", "id"]);
          assert.deepStrictEqual(parameters("slides_remove"), ["id"]);
          assert.deepStrictEqual(byName.get("slides_add")?.inputSchema.required, ["id"]);
          for (const name of ["describe", "slides_list", "check"]) {
            assert.isTrue(byName.get(name)?.annotations?.readOnlyHint, name);
          }
          assert.isTrue(byName.get("slides_remove")?.annotations?.destructiveHint);
          assert.isFalse(byName.get("slides_add")?.annotations?.destructiveHint);
          for (const tool of tools) {
            assert.isAbove(tool.description?.length ?? 0, 80, `${tool.name} has a description for agents`);
          }
        })
      )
  );

  it.effect("describe names the skill the host ships and the commands", () =>
    withTools((client) =>
      Effect.gen(function* () {
        const document = yield* Schema.decodeUnknownEffect(
          Schema.TaggedStruct("DeckVocabulary", {
            skill: Schema.String,
            defaultLayout: Schema.String,
            commands: Schema.Array(Schema.Struct({ usage: Schema.String })),
          })
        )(documentOf(yield* client.callTool({ name: "describe", arguments: {} }))).pipe(Effect.orDie);
        assert.strictEqual(document.skill, SKILL);
        assert.strictEqual(document.defaultLayout, "content");
        assert.include(
          document.commands.map((command) => command.usage),
          "fuse-deck mcp"
        );
      })
    )
  );

  it.effect("slides_add writes the slide with its layout and title and puts it in the order", () =>
    withTools((client, root) =>
      Effect.gen(function* () {
        const added = yield* client.callTool({
          name: "slides_add",
          arguments: { id: "part-two", layout: "section", title: "Part two" },
        });
        assert.deepStrictEqual(documentOf(added), {
          _tag: "SlideAdded",
          id: "part-two",
          path: "slides/part-two.mdx",
          order: ["cover", "part-two"],
        });
        assert.strictEqual(yield* slideOnDisk(root, "part-two"), "---\nlayout: section\n---\n\n# Part two\n");
        assert.deepStrictEqual(yield* orderOnDisk(root), ["cover", "part-two"]);

        const between = yield* client.callTool({
          name: "slides_add",
          arguments: { id: "how-it-works", after: "cover" },
        });
        assert.deepStrictEqual(documentOf(between), {
          _tag: "SlideAdded",
          id: "how-it-works",
          path: "slides/how-it-works.mdx",
          order: ["cover", "how-it-works", "part-two"],
        });
        assert.strictEqual(yield* slideOnDisk(root, "how-it-works"), "# How it works\n");
      })
    )
  );

  it.effect("slides_add of a taken id returns SlideIdTaken with its hint and writes nothing", () =>
    withTools((client, root) =>
      Effect.gen(function* () {
        const before = yield* slideOnDisk(root, "cover");
        const failure = yield* failureOf(
          yield* client.callTool({ name: "slides_add", arguments: { id: "cover", title: "Again" } })
        );
        assert.strictEqual(failure._tag, "SlideIdTaken");
        assert.strictEqual(failure.id, "cover");
        assert.isString(failure.hint);
        assert.strictEqual(yield* slideOnDisk(root, "cover"), before);
        assert.deepStrictEqual(yield* orderOnDisk(root), ["cover"]);
      })
    )
  );

  it.effect("refuses an id that is not a slide id before the tool runs", () =>
    withTools((client, root) =>
      Effect.gen(function* () {
        assert.match(
          refusalOf(yield* client.callTool({ name: "slides_add", arguments: { id: "../outside" } })),
          /^Invalid parameters for tool 'slides_add': A slide id has only lowercase letters/
        );
        assert.isFalse(existsSync(path.join(root, "outside.mdx")));
        assert.deepStrictEqual(yield* orderOnDisk(root), ["cover"]);
      })
    )
  );

  it.effect(
    "slides_list gives each slide's title and layout, and null for a slide that does not compile",
    () =>
      withTools((client, root) =>
        Effect.gen(function* () {
          yield* client.callTool({ name: "slides_add", arguments: { id: "intro", title: "Hello there" } });
          yield* client.callTool({ name: "slides_add", arguments: { id: "broken" } });
          yield* Effect.promise(() => writeFile(path.join(root, "slides", "broken.mdx"), "# Broken {\n"));
          const document = yield* Schema.decodeUnknownEffect(
            Schema.TaggedStruct("SlideList", {
              slides: Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  path: Schema.String,
                  title: Schema.NullOr(Schema.String),
                  layout: Schema.NullOr(Schema.String),
                })
              ),
            })
          )(documentOf(yield* client.callTool({ name: "slides_list", arguments: {} }))).pipe(Effect.orDie);
          assert.deepStrictEqual(
            document.slides.map(({ id }) => id),
            ["cover", "intro", "broken"]
          );
          assert.deepStrictEqual(document.slides[1], {
            id: "intro",
            path: "slides/intro.mdx",
            title: "Hello there",
            layout: "content",
          });
          assert.deepStrictEqual(document.slides[2], {
            id: "broken",
            path: "slides/broken.mdx",
            title: null,
            layout: null,
          });
        })
      )
  );

  it.effect("slides_move takes exactly one anchor and reorders deck.json", () =>
    withTools((client, root) =>
      Effect.gen(function* () {
        yield* client.callTool({ name: "slides_add", arguments: { id: "one" } });
        yield* client.callTool({ name: "slides_add", arguments: { id: "two" } });
        const moved = yield* client.callTool({
          name: "slides_move",
          arguments: { id: "two", before: "cover" },
        });
        assert.deepStrictEqual(documentOf(moved), {
          _tag: "SlideMoved",
          id: "two",
          order: ["two", "cover", "one"],
        });
        assert.deepStrictEqual(yield* orderOnDisk(root), ["two", "cover", "one"]);

        const after = yield* client.callTool({ name: "slides_move", arguments: { id: "two", after: "one" } });
        assert.deepStrictEqual(documentOf(after), {
          _tag: "SlideMoved",
          id: "two",
          order: ["cover", "one", "two"],
        });

        for (const anchors of [{}, { after: "one", before: "cover" }]) {
          assert.strictEqual(
            refusalOf(yield* client.callTool({ name: "slides_move", arguments: { id: "two", ...anchors } })),
            "Invalid parameters for tool 'slides_move': Pass exactly one of after and before."
          );
        }
        const self = yield* failureOf(
          yield* client.callTool({ name: "slides_move", arguments: { id: "two", after: "two" } })
        );
        assert.strictEqual(self._tag, "SlideAnchoredToItself");
        assert.deepStrictEqual(yield* orderOnDisk(root), ["cover", "one", "two"]);
      })
    )
  );

  it.effect("slides_remove takes the slide out of the order and deletes its file", () =>
    withTools((client, root) =>
      Effect.gen(function* () {
        yield* client.callTool({ name: "slides_add", arguments: { id: "spare" } });
        const removed = yield* client.callTool({ name: "slides_remove", arguments: { id: "spare" } });
        assert.deepStrictEqual(documentOf(removed), {
          _tag: "SlideRemoved",
          id: "spare",
          path: "slides/spare.mdx",
          order: ["cover"],
        });
        assert.isFalse(existsSync(path.join(root, "slides", "spare.mdx")));
        assert.deepStrictEqual(yield* orderOnDisk(root), ["cover"]);

        const missing = yield* failureOf(
          yield* client.callTool({ name: "slides_remove", arguments: { id: "spare" } })
        );
        assert.strictEqual(missing._tag, "SlideNotInDeck");
        assert.strictEqual(missing.id, "spare");
        assert.isString(missing.hint);
      })
    )
  );

  it.effect("check reports a clean deck, then lists every problem of a broken one", () =>
    withTools((client, root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(
            path.join(root, "slides", "cover.mdx"),
            "# Cover\n\n<Step>One</Step>\n\n<Step>Two</Step>\n"
          )
        );
        const clean = yield* client.callTool({ name: "check", arguments: {} });
        assert.deepStrictEqual(documentOf(clean), { _tag: "DeckChecked", slides: 1, steps: 2, theme: THEME });

        yield* Effect.promise(() => writeFile(path.join(root, "slides", "stray.mdx"), "# Stray\n"));
        yield* client.callTool({ name: "slides_add", arguments: { id: "gone" } });
        yield* Effect.promise(() => rm(path.join(root, "slides", "gone.mdx")));
        const failure = yield* failureOf(yield* client.callTool({ name: "check", arguments: {} }));
        assert.strictEqual(failure._tag, "DeckCheckFailed");
        assert.isString(failure.hint);
        assert.deepStrictEqual((failure.problems ?? []).map((problem) => problem._tag).toSorted(), [
          "DanglingSlide",
          "OrphanSlide",
        ]);
        assert.include(
          (failure.problems ?? []).map((problem) => problem.path),
          "slides/stray.mdx"
        );
      })
    )
  );
});
