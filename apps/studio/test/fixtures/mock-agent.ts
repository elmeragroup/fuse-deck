/**
 * A scripted ACP v2 agent for the studio's chat tests, on effect-acp's agent side. The prompt's
 * last text block picks the script:
 *
 * - `stream`: three message chunks, then the turn ends.
 * - `echo`: one message that lists the prompt's blocks, so a test sees what the studio sent.
 * - `write <slide>`: asks to edit `slides/<slide>.mdx` with a v2 patch, its headers in
 *   claude-acp's absolute form; on Allow it writes the
 *   file and ends the turn, on Reject or a cancel it ends the turn without writing.
 * - `patch`: asks with a v2 patch and named changes, then waits for the answer.
 * - `patch2`: the same with one patch over two files, `a-one` and `a-two`.
 * - `wait`: asks for permission and then waits for `session/cancel` before it ends the turn.
 * - `hang`: asks for permission and ignores `session/cancel`; the turn never ends.
 * - `withdraw`: asks for permission, and ends the turn without waiting for the answer.
 * - `fail`: ends the turn with an error, as an adapter without a login does.
 * - `image <url>`: replies with Markdown that shows the image at `<url>`.
 *
 * Flags: `--embedded` advertises embedded context; `--mode=stuck` keeps the permission mode at
 * `auto` whatever the client sets, and `--mode=none` offers no mode; `--log=<file>` appends
 * `start <pid>`, its working directory and whether background tasks are off when the process
 * starts, `prompt` for each prompt and `cancel` for each cancel, so a test can find the process and
 * count what reached it, `session-meta <json>` with the `_meta` of `session/new`, and
 * `session-directories <json>` with its `cwd` and `additionalDirectories`. The deck is the first
 * additional directory of `session/new`.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import path from "node:path";

import * as AcpAgent from "@elmeragroup/effect-acp/agent";
import type * as AcpSchema from "@elmeragroup/effect-acp/schema";

const flags = process.argv.slice(2);
const flag = (name: string) =>
  flags.find((candidate) => candidate.startsWith(`--${name}=`))?.slice(name.length + 3);
const embeddedContext = flags.includes("--embedded");
const modeBehavior = flag("mode") ?? "normal";
const log = flag("log");
const sessionId = "mock-session";
// oxlint-disable-next-line turbo/no-undeclared-env-vars -- the studio sets it for its agent; no task reads it from turbo
const backgroundTasksDisabled = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? "unset";

const modeOption = (current: string): AcpSchema.SessionConfigOption => ({
  configId: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: current,
  options: [
    { value: "default", name: "Manual" },
    { value: "auto", name: "Auto" },
  ],
});

/** A prompt block as the echo script describes it: text, an embedded text resource, or another type. */
const decodeBlock = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    Schema.Struct({ type: Schema.Literal("resource"), resource: Schema.Struct({ text: Schema.String }) }),
    Schema.Struct({ type: Schema.String }),
  ])
);

/** One line describing a prompt block. */
function describeBlock(block: AcpSchema.ContentBlock): string {
  return Option.match(decodeBlock(block), {
    onNone: () => "unknown",
    onSome: (decoded) =>
      "text" in decoded
        ? `text: ${decoded.text}`
        : "resource" in decoded
          ? `resource: ${decoded.resource.text}`
          : decoded.type,
  });
}

const decodeMode = Schema.decodeUnknownOption(Schema.String);
const encodeMeta = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const program = Effect.gen(function* () {
  const agent = yield* AcpAgent.AcpAgent;
  const fs = yield* FileSystem.FileSystem;
  const note = (line: string) =>
    log === undefined ? Effect.void : fs.writeFileString(log, `${line}\n`, { flag: "a" }).pipe(Effect.ignore);
  let mode = "auto";
  // The deck, which reaches the agent as the session's first additional directory.
  let deck = process.cwd();
  let cancelled = yield* Deferred.make<void>();

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 2,
      info: { name: "mock-agent", version: "1.0.0" },
      capabilities: { session: embeddedContext ? { prompt: { embeddedContext: {} } } : {} },
    })
  );
  yield* agent.handleCreateSession((request) =>
    Effect.gen(function* () {
      deck = request.additionalDirectories?.[0] ?? request.cwd;
      yield* note(`session-meta ${yield* encodeMeta(request._meta ?? null)}`);
      yield* note(
        `session-directories ${yield* encodeMeta({
          cwd: request.cwd,
          additionalDirectories: request.additionalDirectories ?? [],
        })}`
      );
      return modeBehavior === "none" ? { sessionId } : { sessionId, configOptions: [modeOption(mode)] };
    }).pipe(Effect.orDie)
  );
  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.sync(() => {
      const value = decodeMode(request.value);
      if (modeBehavior !== "stuck" && request.configId === "mode" && Option.isSome(value)) {
        mode = value.value;
      }
      return { configOptions: [modeOption(mode)] };
    })
  );
  yield* agent.handleCancel(() =>
    note("cancel").pipe(Effect.andThen(Deferred.succeed(cancelled, undefined)))
  );

  const say = (messageId: string, text: string) =>
    agent.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } },
    });
  const endTurn = (stopReason: "end_turn" | "cancelled") =>
    agent.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "state_update", state: "idle", stopReason },
    });
  const ask = (title: string, content: ReadonlyArray<AcpSchema.ToolCallContent>) =>
    agent.client.requestPermission({
      sessionId,
      title,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
      subject: { type: "tool_call", toolCall: { toolCallId: "edit-1", title, kind: "edit", content } },
    });

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      cancelled = yield* Deferred.make<void>();
      yield* note("prompt");
      const texts = request.prompt
        .map(describeBlock)
        .flatMap((line) => (line.startsWith("text: ") ? [line.slice("text: ".length)] : []));
      const [script = "", argument = ""] = (texts.at(-1) ?? "").split(" ");
      yield* agent.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "state_update", state: "running" },
      });
      switch (script) {
        case "stream": {
          yield* say("reply-1", "Hello");
          yield* say("reply-1", " from");
          yield* say("reply-1", " the mock.");
          yield* endTurn("end_turn");
          return {};
        }
        case "echo": {
          const described = request.prompt.map(describeBlock);
          yield* say("echo-1", described.join("\n"));
          yield* endTurn("end_turn");
          return {};
        }
        case "write": {
          const relative = `slides/${argument}.mdx`;
          const file = path.join(deck, relative);
          const oldText = yield* fs.readFileString(file);
          const newText = `${oldText}\nWritten by the mock agent.\n`;
          yield* agent.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "edit-1",
              // claude-acp names a file outside the session's working directory by its absolute path.
              title: `Edit ${file}`,
              kind: "edit",
              status: "pending",
              locations: [{ path: file }],
            },
          });
          // Headers as claude-acp 0.109.0 writes them: absolute paths, no a/ and b/.
          const patch = `diff --git ${file} ${file}\n--- ${file}\n+++ ${file}\n@@ -1 +1,3 @@\n ${oldText.trimEnd()}\n+\n+Written by the mock agent.\n`;
          const answer = yield* ask(`Edit ${file}`, [
            {
              type: "diff",
              changes: [{ operation: "modify", path: file }],
              patch: { format: "git_patch", text: patch },
            },
          ]);
          if (answer.outcome.outcome === "selected" && answer.outcome.optionId === "allow") {
            yield* fs.writeFileString(file, newText);
            yield* agent.client.sessionUpdate({
              sessionId,
              update: { sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed" },
            });
            yield* say("reply-2", "Done.");
            yield* endTurn("end_turn");
          } else {
            yield* endTurn("cancelled");
          }
          return {};
        }
        case "patch": {
          const patch = "--- a/slides/one.mdx\n+++ b/slides/one.mdx\n@@ -1 +1 @@\n-# One\n+# Uno\n";
          const answer = yield* ask("Rename a slide", [
            {
              type: "diff",
              changes: [
                { operation: "modify", path: path.join(deck, "slides/one.mdx") },
                {
                  operation: "move",
                  oldPath: path.join(deck, "slides/two.mdx"),
                  path: path.join(deck, "slides/deux.mdx"),
                },
              ],
              patch: { format: "git_patch", text: patch },
            },
          ]);
          yield* endTurn(answer.outcome.outcome === "selected" ? "end_turn" : "cancelled");
          return {};
        }
        case "patch2": {
          // Two files in one patch, with claude-acp's absolute headers.
          const one = path.join(deck, "slides/a-one.mdx");
          const two = path.join(deck, "slides/a-two.mdx");
          const patch = [
            `diff --git ${one} ${one}`,
            `--- ${one}`,
            `+++ ${one}`,
            "@@ -1 +1 @@",
            "-# A one",
            "+# A one, patched",
            `diff --git ${two} ${two}`,
            `--- ${two}`,
            `+++ ${two}`,
            "@@ -1 +1 @@",
            "-# A two",
            "+# A two, patched",
            "",
          ].join("\n");
          const answer = yield* ask("Edit two slides", [
            {
              type: "diff",
              changes: [
                { operation: "modify", path: one },
                { operation: "modify", path: two },
              ],
              patch: { format: "git_patch", text: patch },
            },
          ]);
          yield* endTurn(answer.outcome.outcome === "selected" ? "end_turn" : "cancelled");
          return {};
        }
        case "wait": {
          yield* ask("Wait for the user", []).pipe(Effect.forkScoped);
          yield* Deferred.await(cancelled);
          yield* endTurn("cancelled");
          return {};
        }
        case "hang": {
          yield* ask("Hang", []).pipe(Effect.forkScoped);
          return yield* Effect.never;
        }
        case "withdraw": {
          // Started at once, so the request is queued ahead of the turn's end.
          yield* ask("Withdrawn", []).pipe(Effect.forkScoped({ startImmediately: true }));
          yield* say("reply-4", "Never mind.");
          yield* endTurn("end_turn");
          return {};
        }
        case "image": {
          yield* say("reply-5", `A remote picture: ![remote](${argument})`);
          yield* endTurn("end_turn");
          return {};
        }
        case "fail": {
          yield* agent.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "state_update",
              state: "idle",
              stopReason: "error",
              error: { code: -32000, message: "Authentication required" },
            },
          });
          return {};
        }
        default: {
          yield* say("reply-0", `Unknown script: ${script}`);
          yield* endTurn("end_turn");
          return {};
        }
      }
    }).pipe(Effect.scoped, Effect.orDie)
  );

  // Logged only once every handler is registered: the agent layer reads stdin from the start, and
  // an await before a handler exists lets its request arrive first and fail as unknown.
  yield* note(
    [
      `start ${String(process.pid)}`,
      `cwd ${process.cwd()}`,
      `background-tasks-disabled ${backgroundTasksDisabled}`,
    ].join("\n")
  );
  return yield* Effect.never;
});

program.pipe(
  // Stdout carries the protocol, so logs go to stderr.
  Effect.provideService(References.LogToStderr, true),
  Effect.provide(Layer.provideMerge(AcpAgent.layerStdio(), NodeServices.layer)),
  NodeRuntime.runMain
);
