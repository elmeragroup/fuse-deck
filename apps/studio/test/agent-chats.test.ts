import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import path from "node:path";

import { DeckFiles } from "@elmeragroup/deck-core/deck/deck-files";
import { SlideId } from "@elmeragroup/deck-core/deck/slide-id";

import type { ChatEntry, ChatState } from "../src/contract/agent-chat.ts";
import { ScopeId } from "../src/contract/studio-rpc.ts";
import { AgentChats } from "../src/server/agent-chats.ts";
import type { AgentChat } from "../src/server/agent-chats.ts";
import { AgentLaunch, SESSION_DIRECTORY } from "../src/server/agent-launch.ts";
import { McpTokens } from "../src/server/mcp-tokens.ts";
import { mockAgentChats, seedAdapter, writeMockSettings } from "./agent.ts";
import type { MockAgentOptions } from "./agent.ts";
import { DECK_A, slideTitle, writeDeck } from "./decks.ts";

const slide = Schema.decodeSync(SlideId);

/** Deck A in a fresh directory, and its chat driving the mock agent with `options`. */
const setup = Effect.fn("setup")(function* (options: Omit<MockAgentOptions, "log"> = {}) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "fuse-deck-studio-chat-" });
  // The real path, as the session names the deck in `additionalDirectories`.
  const deck = yield* fs.realPath(yield* Effect.promise(() => writeDeck(path.join(root, "deck"), DECK_A)));
  const userData = path.join(root, "user-data");
  const log = path.join(root, "agent.log");
  yield* writeMockSettings(userData, { ...options, log });
  const services = yield* Layer.build(
    Layer.mergeAll(DeckFiles.layerFrom(deck), mockAgentChats(userData, options.stopDeadline)).pipe(
      Layer.provideMerge(McpTokens.layer)
    )
  );
  const chats = Context.get(services, AgentChats);
  const files = Context.get(services, DeckFiles);
  const chat = yield* chats.make({ scopeId: ScopeId.make("scope-a"), files });
  /** The lines the agent processes wrote to their log so far. */
  const agentLog = fs.readFileString(log).pipe(
    Effect.map((text) => text.split("\n").filter((line) => line !== "")),
    Effect.orElseSucceed((): ReadonlyArray<string> => [])
  );
  return { chat, deck, userData, agentLog };
});

/** The first chat state `matches` accepts. */
function waitFor(chat: AgentChat, matches: (state: ChatState) => boolean): Effect.Effect<ChatState> {
  return chat.state.pipe(
    Stream.filter(matches),
    Stream.runHead,
    Effect.map((state) => Option.getOrThrowWith(state, () => new Error("The chat ended first.")))
  );
}

/** The chat's entries with `tag`. */
function entriesOf<Tag extends ChatEntry["_tag"]>(
  state: ChatState,
  tag: Tag
): ReadonlyArray<Extract<ChatEntry, { readonly _tag: Tag }>> {
  return state.entries.filter(
    (entry): entry is Extract<ChatEntry, { readonly _tag: Tag }> => entry._tag === tag
  );
}

const idle = (state: ChatState) => state.turn === "Idle" && state.entries.length > 1;

const pendingCard = (state: ChatState) =>
  entriesOf(state, "Permission").some((card) => card.outcome._tag === "Pending");

/** The pid the agent process that started first logged. */
function firstPid(log: ReadonlyArray<string>): number {
  const line = log.find((entry) => entry.startsWith("start ")) ?? assert.fail("No agent process started.");
  return Number(line.slice("start ".length));
}

describe("AgentChats", () => {
  it.live("streams the agent's reply into one message, in the asking mode", () =>
    Effect.gen(function* () {
      const { chat } = yield* setup();
      yield* chat.prompt({ text: "stream", view: null });
      const done = yield* waitFor(chat, idle);
      assert.deepStrictEqual(
        entriesOf(done, "Agent").map((entry) => entry.text),
        ["Hello from the mock."]
      );
      assert.deepStrictEqual(done.session, {
        _tag: "Ready",
        agent: "mock-agent 1.0.0",
        generation: 2,
        mode: "default",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("tells the agent the view as text, without the slide when it takes no embedded context", () =>
    Effect.gen(function* () {
      const { chat } = yield* setup();
      yield* chat.prompt({ text: "echo", view: { slideId: slide("a-two"), step: 1 } });
      const done = yield* waitFor(chat, idle);
      assert.deepStrictEqual(
        entriesOf(done, "Agent").map((entry) => entry.text),
        [`text: The studio's preview shows slide "a-two" (slides/a-two.mdx), step 1.\ntext: echo`]
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("embeds the shown slide's source when the agent takes embedded context", () =>
    Effect.gen(function* () {
      const { chat } = yield* setup({ embedded: true });
      yield* chat.prompt({ text: "echo", view: { slideId: slide("a-two"), step: 0 } });
      const done = yield* waitFor(chat, idle);
      assert.deepStrictEqual(
        entriesOf(done, "Agent").map((entry) => entry.text),
        [
          [
            `text: The studio's preview shows slide "a-two" (slides/a-two.mdx), step 0.`,
            `resource: # ${slideTitle("a-two")}\n`,
            "text: echo",
          ].join("\n"),
        ]
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("leaves out a view that names a slide the deck does not have", () =>
    Effect.gen(function* () {
      const { chat } = yield* setup({ embedded: true });
      yield* chat.prompt({ text: "echo", view: { slideId: slide("not-in-deck"), step: 0 } });
      const done = yield* waitFor(chat, idle);
      assert.deepStrictEqual(entriesOf(done, "User")[0]?.view, null);
      assert.deepStrictEqual(
        entriesOf(done, "Agent").map((entry) => entry.text),
        ["text: echo"]
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("writes only after Allow, and shows the write as an observed change", () =>
    Effect.gen(function* () {
      const { chat, deck } = yield* setup();
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(deck, "slides", "a-one.mdx");
      const before = yield* fs.readFileString(file);
      yield* chat.prompt({ text: "write a-one", view: null });
      const asking = yield* waitFor(chat, pendingCard);
      const [card] = entriesOf(asking, "Permission");
      assert.deepStrictEqual(
        card?.choices.map((choice) => choice.name),
        ["Allow", "Reject"]
      );
      assert.deepStrictEqual(card?.diffs, [
        {
          _tag: "Patch",
          text: `diff --git ${file} ${file}\n--- ${file}\n+++ ${file}\n@@ -1 +1,3 @@\n # A one\n+\n+Written by the mock agent.\n`,
        },
      ]);
      assert.deepStrictEqual(card?.changes, [{ operation: "modify", path: file, oldPath: null }]);
      // Nothing is written while the request waits.
      assert.strictEqual(yield* fs.readFileString(file), before);
      yield* chat.decide(card?.id ?? "", "allow");
      const done = yield* waitFor(chat, idle);
      assert.strictEqual(yield* fs.readFileString(file), `${before}\nWritten by the mock agent.\n`);
      assert.deepStrictEqual(entriesOf(done, "Permission")[0]?.outcome, {
        _tag: "Chosen",
        choice: { optionId: "allow", name: "Allow", kind: "allow_once" },
      });
      assert.deepStrictEqual(
        entriesOf(done, "Tool").map((tool) => tool.status),
        ["completed"]
      );
      assert.deepStrictEqual(yield* chat.changes, {
        turn: 1,
        files: [{ path: "slides/a-one.mdx", before, after: `${before}\nWritten by the mock agent.\n` }],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("writes nothing after Reject", () =>
    Effect.gen(function* () {
      const { chat, deck } = yield* setup();
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(deck, "slides", "a-one.mdx");
      const before = yield* fs.readFileString(file);
      yield* chat.prompt({ text: "write a-one", view: null });
      const [card] = entriesOf(yield* waitFor(chat, pendingCard), "Permission");
      yield* chat.decide(card?.id ?? "", "reject");
      yield* waitFor(chat, idle);
      assert.strictEqual(yield* fs.readFileString(file), before);
      assert.deepStrictEqual(yield* chat.changes, { turn: 1, files: [] });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("shows a v2 patch and the changes it names", () =>
    Effect.gen(function* () {
      const { chat, deck } = yield* setup();
      yield* chat.prompt({ text: "patch", view: null });
      const [card] = entriesOf(yield* waitFor(chat, pendingCard), "Permission");
      assert.deepStrictEqual(card?.diffs, [
        { _tag: "Patch", text: "--- a/slides/one.mdx\n+++ b/slides/one.mdx\n@@ -1 +1 @@\n-# One\n+# Uno\n" },
      ]);
      assert.deepStrictEqual(card?.changes, [
        { operation: "modify", path: path.join(deck, "slides/one.mdx"), oldPath: null },
        {
          operation: "move",
          path: path.join(deck, "slides/deux.mdx"),
          oldPath: path.join(deck, "slides/two.mdx"),
        },
      ]);
      yield* chat.stop;
      yield* waitFor(chat, idle);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("stops a turn: cancels it, withdraws the request, and keeps the session for the next prompt", () =>
    Effect.gen(function* () {
      const { chat, agentLog } = yield* setup();
      yield* chat.prompt({ text: "wait", view: null });
      yield* waitFor(chat, pendingCard);
      yield* chat.stop;
      const stopped = yield* waitFor(chat, idle);
      assert.deepStrictEqual(entriesOf(stopped, "Permission")[0]?.outcome, {
        _tag: "Withdrawn",
        reason: "Stopped.",
      });
      assert.deepStrictEqual(
        entriesOf(stopped, "Notice").map((notice) => notice.text),
        ["Stopped."]
      );
      yield* chat.prompt({ text: "stream", view: null });
      yield* waitFor(chat, (state) => idle(state) && entriesOf(state, "Agent").length === 1);
      const log = yield* agentLog;
      assert.deepStrictEqual(
        log.flatMap((line) =>
          line.startsWith("start ") ? ["start"] : ["prompt", "cancel"].includes(line) ? [line] : []
        ),
        ["start", "prompt", "cancel", "prompt"]
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("stops an agent that ignores the cancel once the Stop deadline passes", () =>
    Effect.gen(function* () {
      const { chat, agentLog } = yield* setup({ stopDeadline: Duration.millis(300) });
      yield* chat.prompt({ text: "hang", view: null });
      yield* waitFor(chat, pendingCard);
      yield* chat.stop;
      const stopped = yield* waitFor(chat, (state) => state.turn === "Idle");
      assert.deepStrictEqual(stopped.session, {
        _tag: "Ended",
        reason: "The agent had not ended its turn 300ms after Stop, so the studio stopped it.",
      });
      // The next prompt starts a new agent.
      yield* chat.prompt({ text: "stream", view: null });
      yield* waitFor(chat, (state) => state.turn === "Idle" && entriesOf(state, "Agent").length === 1);
      assert.strictEqual((yield* agentLog).filter((line) => line.startsWith("start ")).length, 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("gives a new agent's permission request its own card after a restart", () =>
    Effect.gen(function* () {
      const { chat, deck } = yield* setup({ stopDeadline: Duration.millis(300) });
      yield* chat.prompt({ text: "hang", view: null });
      yield* waitFor(chat, pendingCard);
      yield* chat.stop;
      yield* waitFor(chat, (state) => state.turn === "Idle" && state.session._tag === "Ended");
      // A new agent process numbers its requests from the start again.
      yield* chat.prompt({ text: "write a-one", view: null });
      const asking = yield* waitFor(chat, pendingCard);
      const cards = entriesOf(asking, "Permission");
      const fresh = cards.at(-1);
      assert.strictEqual(cards.length, 2);
      assert.notStrictEqual(fresh?.id, cards[0]?.id);
      yield* chat.decide(fresh?.id ?? "", "allow");
      const done = yield* waitFor(chat, (state) => idle(state) && entriesOf(state, "Agent").length === 1);
      assert.deepStrictEqual(
        entriesOf(done, "Permission").map((card) => card.outcome._tag),
        ["Withdrawn", "Chosen"]
      );
      const fs = yield* FileSystem.FileSystem;
      assert.strictEqual(
        yield* fs.readFileString(path.join(deck, "slides", "a-one.mdx")),
        `# ${slideTitle("a-one")}\n\nWritten by the mock agent.\n`
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("withdraws a request and ends the turn when the agent's process dies", () =>
    Effect.gen(function* () {
      const { chat, agentLog } = yield* setup();
      yield* chat.prompt({ text: "hang", view: null });
      yield* waitFor(chat, pendingCard);
      process.kill(firstPid(yield* agentLog), "SIGKILL");
      const ended = yield* waitFor(chat, (state) => state.turn === "Idle");
      const outcome = entriesOf(ended, "Permission")[0]?.outcome;
      assert.strictEqual(outcome?._tag, "Withdrawn");
      assert.strictEqual(ended.session._tag, "Ended");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("withdraws a request the agent stops waiting for when its turn ends", () =>
    Effect.gen(function* () {
      const { chat } = yield* setup();
      yield* chat.prompt({ text: "withdraw", view: null });
      const done = yield* waitFor(
        chat,
        (state) =>
          state.turn === "Idle" &&
          entriesOf(state, "Permission").some((card) => card.outcome._tag === "Withdrawn")
      );
      assert.deepStrictEqual(entriesOf(done, "Permission")[0]?.outcome, {
        _tag: "Withdrawn",
        reason: "The turn ended.",
      });
      const error = yield* Effect.flip(chat.decide(entriesOf(done, "Permission")[0]?.id ?? "", "allow"));
      assert.strictEqual(error._tag, "PermissionGone");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("sends no prompt to an agent that will not take the asking mode", () =>
    Effect.gen(function* () {
      const { chat, agentLog } = yield* setup({ mode: "stuck" });
      yield* chat.prompt({ text: "stream", view: null });
      const done = yield* waitFor(chat, idle);
      assert.deepStrictEqual(done.session, {
        _tag: "Ended",
        reason: "Setting the permission mode failed: The agent kept its mode at auto.",
      });
      assert.isFalse((yield* agentLog).includes("prompt"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("shows the error an agent ends its turn with", () =>
    Effect.gen(function* () {
      const { chat } = yield* setup();
      yield* chat.prompt({ text: "fail", view: null });
      const done = yield* waitFor(chat, idle);
      assert.deepStrictEqual(
        entriesOf(done, "Notice").map((notice) => [notice.tone, notice.text]),
        [["error", "The agent ended the turn with an error: Authentication required"]]
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("sends no prompt to an agent that offers no asking mode", () =>
    Effect.gen(function* () {
      const { chat, agentLog } = yield* setup({ mode: "none" });
      yield* chat.prompt({ text: "stream", view: null });
      const done = yield* waitFor(chat, idle);
      assert.deepStrictEqual(done.session, {
        _tag: "Ended",
        reason: 'Setting the permission mode failed: The agent offers no "default" permission mode.',
      });
      assert.isFalse((yield* agentLog).includes("prompt"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("refuses a second prompt while a turn runs", () =>
    Effect.gen(function* () {
      const { chat } = yield* setup();
      yield* chat.prompt({ text: "wait", view: null });
      const error = yield* Effect.flip(chat.prompt({ text: "stream", view: null }));
      assert.strictEqual(error._tag, "AgentBusy");
      yield* chat.stop;
      yield* waitFor(chat, idle);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});

/** The test runner's PATH, which the agent starts from. */
const RUNNER_PATH = process.env.PATH ?? "/usr/bin:/bin";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** A file outside the deck, and the text in it that must never reach the agent or the Changes tab. */
const OUTSIDE_SECRET = "outside-the-deck-7f3a";

describe("AgentChats and an untrusted deck", () => {
  it.live("runs nothing the deck ships, whatever PATH holds, and runs the agent outside the deck", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fuse-deck-studio-attack-" });
      const deck = yield* fs.realPath(
        yield* Effect.promise(() => writeDeck(path.join(root, "deck"), DECK_A))
      );
      const userData = path.join(root, "user-data");
      const sentinel = path.join(root, "deck-code-ran");
      const adapterRan = path.join(root, "adapter-ran");
      // The deck ships a `node` and an `npx`, where a relative PATH entry or npx would find them.
      const shim = `#!/bin/sh\necho "$0" >> '${sentinel}'\n`;
      for (const file of ["node_modules/.bin/node", "node_modules/.bin/npx", "node", "npx"]) {
        yield* fs.makeDirectory(path.dirname(path.join(deck, file)), { recursive: true });
        yield* fs.writeFileString(path.join(deck, file), shim);
        yield* fs.chmod(path.join(deck, file), 0o755);
      }
      // The adapter, as installed, notes where it runs and runs `node` and `npx` by name, as the
      // Claude Agent SDK and an agent's tools do.
      yield* seedAdapter(
        userData,
        [
          'const { appendFileSync } = require("node:fs");',
          'const { spawnSync } = require("node:child_process");',
          `appendFileSync("${adapterRan}", process.cwd() + "\\n");`,
          'spawnSync("node", ["-e", ""]);',
          'spawnSync("npx", ["--version"]);',
          "process.exit(1);",
          "",
        ].join("\n")
      );
      const pathVariable = ["node_modules/.bin", ".", "", RUNNER_PATH].join(path.delimiter);
      const services = yield* Layer.build(
        Layer.mergeAll(
          DeckFiles.layerFrom(deck),
          AgentChats.layer({ stopDeadline: Duration.seconds(15), mcpRelay: Option.none() }).pipe(
            Layer.provide(McpTokens.layer),
            Layer.provide(AgentLaunch.layerWithPath(userData, pathVariable))
          )
        )
      );
      const chat = yield* Context.get(services, AgentChats).make({
        scopeId: ScopeId.make("scope-a"),
        files: Context.get(services, DeckFiles),
      });
      yield* chat.prompt({ text: "stream", view: null });
      yield* waitFor(chat, (state) => state.session._tag === "Ended" && state.turn === "Idle");
      assert.deepStrictEqual(
        {
          deckCodeRan: yield* fs.exists(sentinel),
          adapterRanIn: (yield* fs.readFileString(adapterRan).pipe(Effect.orElseSucceed(() => ""))).trim(),
        },
        { deckCodeRan: false, adapterRanIn: yield* fs.realPath(path.join(userData, "agent")) }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("opens the session with no settings, hooks or MCP servers from the deck, and no bypass", () =>
    Effect.gen(function* () {
      const { chat, deck, agentLog } = yield* setup();
      yield* chat.prompt({ text: "stream", view: null });
      yield* waitFor(chat, idle);
      const line = (yield* agentLog).find((each) => each.startsWith("session-meta "));
      // Oracle: claude-agent-acp 0.109.0 spreads `_meta.claudeCode.options` over its defaults.
      assert.deepStrictEqual(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(line?.slice(13)),
        {
          systemPrompt: {
            append: [
              `You work on a fuse-deck slide deck at ${deck}. It is not your working directory, which is a directory the studio made for this session.`,
              `Resolve every deck path you are given, such as slides/intro.mdx, against ${deck}, and pass absolute paths under it to your file tools.`,
              `Shell commands start outside the deck; give them absolute paths, or change into ${deck} first.`,
            ].join("\n"),
          },
          claudeCode: {
            options: {
              settingSources: ["user"],
              strictMcpConfig: true,
              perTaskStopAffordance: false,
              allowDangerouslySkipPermissions: false,
            },
          },
        }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live(
    "opens the session in a directory of the studio's that holds only its settings, with the deck as an additional directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { chat, deck, userData, agentLog } = yield* setup();
        yield* chat.prompt({ text: "stream", view: null });
        yield* waitFor(chat, idle);
        const line = (yield* agentLog).find((each) => each.startsWith("session-directories "));
        const directories = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ cwd: Schema.String, additionalDirectories: Schema.Array(Schema.String) })
          )
        )(line?.slice("session-directories ".length));
        const live = {
          parent: path.dirname(directories.cwd),
          entries: yield* fs.readDirectory(directories.cwd, { recursive: true }).pipe(
            Effect.map((names) => names.toSorted()),
            Effect.orElseSucceed(() => ["(missing)"])
          ),
          settings: yield* fs
            .readFileString(path.join(directories.cwd, ".claude", "settings.local.json"))
            .pipe(Effect.orElseSucceed(() => "(missing)")),
          additionalDirectories: directories.additionalDirectories,
        };
        yield* chat.end;
        assert.deepStrictEqual(
          { ...live, removedAtEnd: !(yield* fs.exists(directories.cwd)) },
          {
            parent: path.join(userData, SESSION_DIRECTORY),
            entries: [".claude", path.join(".claude", "settings.local.json")],
            // Oracle: claude-agent-acp 0.109.0 opens the session in this file's `defaultMode`.
            settings: '{"permissions":{"defaultMode":"default"}}\n',
            additionalDirectories: [deck],
            removedAtEnd: true,
          }
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("runs the agent with Claude Code's background tasks off", () =>
    Effect.gen(function* () {
      const { chat, agentLog } = yield* setup();
      yield* chat.prompt({ text: "stream", view: null });
      yield* waitFor(chat, idle);
      assert.include(yield* agentLog, "background-tasks-disabled 1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live.each(["file", "directory"] as const)(
    "attaches and reports no slide that a symlinked %s takes outside the deck",
    (linked) =>
      Effect.gen(function* () {
        const { chat, deck } = yield* setup({ embedded: true });
        const fs = yield* FileSystem.FileSystem;
        const outside = path.join(path.dirname(deck), "outside");
        yield* fs.makeDirectory(outside);
        yield* fs.writeFileString(path.join(outside, "a-two.mdx"), `# ${OUTSIDE_SECRET}\n`);
        if (linked === "file") {
          yield* fs.remove(path.join(deck, "slides", "a-two.mdx"));
          yield* fs.symlink(path.join(outside, "a-two.mdx"), path.join(deck, "slides", "a-two.mdx"));
        } else {
          yield* fs.remove(path.join(deck, "slides"), { recursive: true });
          yield* fs.symlink(outside, path.join(deck, "slides"));
        }
        yield* chat.prompt({ text: "echo", view: { slideId: slide("a-two"), step: 0 } });
        const done = yield* waitFor(chat, idle);
        // The outside file changes after the turn's snapshot.
        yield* fs.writeFileString(path.join(outside, "a-two.mdx"), `# ${OUTSIDE_SECRET}, changed\n`);
        const changes = yield* chat.changes;
        const seen = yield* encodeJson({ entries: done.entries, changes });
        assert.isFalse(seen.includes(OUTSIDE_SECRET), seen);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("reports no slide through a link to another slide in the deck", () =>
    Effect.gen(function* () {
      const { chat, deck } = yield* setup();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path.join(deck, "slides", "a-two.mdx"));
      yield* fs.symlink(path.join(deck, "slides", "a-one.mdx"), path.join(deck, "slides", "a-two.mdx"));
      yield* chat.prompt({ text: "echo", view: null });
      yield* waitFor(chat, idle);
      yield* fs.writeFileString(path.join(deck, "slides", "a-one.mdx"), "# A one, changed\n");
      const { files } = yield* chat.changes;
      assert.deepStrictEqual(
        files.map((change) => change.path),
        ["slides/a-one.mdx"]
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("ends the chat while a turn's read of the deck stalls", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fuse-deck-studio-stall-" });
      const deck = yield* fs.realPath(
        yield* Effect.promise(() => writeDeck(path.join(root, "deck"), DECK_A))
      );
      const userData = path.join(root, "user-data");
      yield* writeMockSettings(userData);
      const stalled = yield* Deferred.make<void>();
      // The chats' file system never answers a read of deck.json, as a stalled disk would not.
      const stalling = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (real) =>
          FileSystem.make({
            ...real,
            readFile: (file) =>
              file.endsWith("deck.json")
                ? Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Effect.never))
                : real.readFile(file),
          })
        )
      ).pipe(Layer.provide(NodeServices.layer));
      const services = yield* Layer.build(
        Layer.mergeAll(
          DeckFiles.layerFrom(deck),
          AgentChats.layer({ stopDeadline: Duration.seconds(15), mcpRelay: Option.none() }).pipe(
            Layer.provide(McpTokens.layer),
            Layer.provide(AgentLaunch.layerWithPath(userData, RUNNER_PATH)),
            Layer.provide(stalling)
          )
        )
      );
      const chat = yield* Context.get(services, AgentChats).make({
        scopeId: ScopeId.make("scope-a"),
        files: Context.get(services, DeckFiles),
      });
      const prompting = yield* chat.prompt({ text: "stream", view: null }).pipe(Effect.forkScoped);
      yield* Deferred.await(stalled);
      const ended = yield* chat.end.pipe(Effect.timeoutOption(Duration.seconds(5)));
      assert.isTrue(Option.isSome(ended), "The chat did not end while the read stalled.");
      yield* Fiber.interrupt(prompting);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("stops a turn whose prompt has not reached a running agent, and sends the agent nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fuse-deck-studio-stall-" });
      const deck = yield* fs.realPath(
        yield* Effect.promise(() => writeDeck(path.join(root, "deck"), DECK_A))
      );
      const userData = path.join(root, "user-data");
      const log = path.join(root, "agent.log");
      yield* writeMockSettings(userData, { log });
      let stall = false;
      const stalled = yield* Deferred.make<void>();
      // From the second turn on, the snapshot's read of deck.json never answers.
      const stalling = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (real) =>
          FileSystem.make({
            ...real,
            readFile: (file) =>
              stall && file.endsWith("deck.json")
                ? Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Effect.never))
                : real.readFile(file),
          })
        )
      ).pipe(Layer.provide(NodeServices.layer));
      const services = yield* Layer.build(
        Layer.mergeAll(
          DeckFiles.layerFrom(deck),
          AgentChats.layer({ stopDeadline: Duration.seconds(15), mcpRelay: Option.none() }).pipe(
            Layer.provide(McpTokens.layer),
            Layer.provide(AgentLaunch.layerWithPath(userData, RUNNER_PATH)),
            Layer.provide(stalling)
          )
        )
      );
      const chat = yield* Context.get(services, AgentChats).make({
        scopeId: ScopeId.make("scope-a"),
        files: Context.get(services, DeckFiles),
      });
      yield* chat.prompt({ text: "stream", view: null });
      yield* waitFor(chat, (state) => idle(state) && entriesOf(state, "Agent").length === 1);
      stall = true;
      yield* chat.prompt({ text: "stream", view: null });
      yield* Deferred.await(stalled);
      yield* chat.stop;
      const stopped = yield* waitFor(chat, (state) => state.turn === "Idle").pipe(
        Effect.timeoutOption(Duration.seconds(5))
      );
      assert.isTrue(Option.isSome(stopped), "The turn did not end after Stop.");
      const prompts = (yield* fs.readFileString(log)).split("\n").filter((line) => line === "prompt");
      assert.strictEqual(prompts.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
