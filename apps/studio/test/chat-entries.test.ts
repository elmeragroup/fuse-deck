import type * as Schema from "effect/Schema";
import { assert, describe, it } from "vitest";

import type * as Acp from "@elmeragroup/effect-acp/compat";

import type { ChatEntry } from "../src/contract/agent-chat.ts";
import { applySessionUpdate, permissionEntry, settlePermission } from "../src/server/chat-entries.ts";

/** Apply `updates` in order to an empty chat, minting ids `new-1`, `new-2` and so on. */
function apply(updates: ReadonlyArray<Acp.SessionUpdate>): ReadonlyArray<ChatEntry> {
  let minted = 0;
  const nextId = () => {
    minted += 1;
    return `new-${String(minted)}`;
  };
  return updates.reduce<ReadonlyArray<ChatEntry>>(
    (entries, update) => applySessionUpdate(entries, update, nextId),
    []
  );
}

const text = (value: string): Acp.ContentBlock => ({ type: "text", text: value });

describe("applySessionUpdate", () => {
  it("joins a message's chunks, and lets the whole message replace them", () => {
    assert.deepStrictEqual(
      apply([
        { sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("Hel") },
        { sessionUpdate: "agent_thought_chunk", messageId: "t1", content: text("Thinking") },
        { sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("lo") },
      ]),
      [
        { _tag: "Agent", id: "m1", text: "Hello" },
        { _tag: "Thought", id: "t1", text: "Thinking" },
      ]
    );
    assert.deepStrictEqual(
      apply([
        { sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("Hel") },
        { sessionUpdate: "agent_message", messageId: "m1", content: [text("Hello, "), text("world.")] },
      ]),
      [{ _tag: "Agent", id: "m1", text: "Hello, world." }]
    );
  });

  it("adds chunks without an id to the message before them, and starts a message after anything else", () => {
    assert.deepStrictEqual(
      apply([
        { sessionUpdate: "agent_message_chunk", content: text("One") },
        { sessionUpdate: "agent_message_chunk", content: text(" two") },
        { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "Read" },
        { sessionUpdate: "agent_message_chunk", content: text("Three") },
      ]),
      [
        { _tag: "Agent", id: "new-1", text: "One two" },
        {
          _tag: "Tool",
          id: "tool-1",
          title: "Read",
          kind: null,
          status: null,
          paths: [],
          diffs: [],
          changes: [],
        },
        { _tag: "Agent", id: "new-2", text: "Three" },
      ]
    );
  });

  it("opens a tool call on its first update and merges the later ones into it", () => {
    assert.deepStrictEqual(
      apply([
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit",
          title: "Edit slides/a.mdx",
          kind: "edit",
          status: "pending",
          locations: [{ path: "/deck/slides/a.mdx" }],
        },
        { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" },
      ]),
      [
        {
          _tag: "Tool",
          id: "edit",
          title: "Edit slides/a.mdx",
          kind: "edit",
          status: "completed",
          paths: ["/deck/slides/a.mdx"],
          diffs: [],
          changes: [],
        },
      ]
    );
  });

  it("shows an ACP v1 text diff as a text diff", () => {
    const [entry] = apply([
      {
        sessionUpdate: "tool_call",
        toolCallId: "write",
        title: "Write",
        content: [{ type: "diff", path: "/deck/slides/a.mdx", oldText: null, newText: "# New\n" }],
      },
    ]);
    assert.deepStrictEqual(entry?._tag === "Tool" ? entry.diffs : undefined, [
      { _tag: "TextDiff", path: "/deck/slides/a.mdx", oldText: null, newText: "# New\n" },
    ]);
  });

  it("leaves the chat as it is for updates it does not show", () => {
    assert.deepStrictEqual(
      apply([
        { sessionUpdate: "state_update", state: "running" },
        { sessionUpdate: "current_mode_update", currentModeId: "default" },
        { sessionUpdate: "_t3_unknown", originalSessionUpdate: "timeline_update", raw: {} },
      ]),
      []
    );
  });
});

describe("permission entries", () => {
  const request: Acp.RequestPermissionRequest = {
    sessionId: "s",
    toolCall: { toolCallId: "t", title: "Run npm test" },
    subject: { type: "command", command: "npm test", cwd: "/deck" },
    options: [
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  };

  it("shows the request's title, command and choices, pending", () => {
    assert.deepStrictEqual(permissionEntry("r1", request), {
      _tag: "Permission",
      id: "r1",
      title: "Run npm test",
      command: "npm test",
      summary: null,
      arguments: null,
      choices: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
      outcome: { _tag: "Pending" },
      paths: [],
      diffs: [],
      changes: [],
    });
  });

  /** A deck tool's request as claude-agent-acp 0.109.0 sends it (from the S5 live session's log). */
  const deckTool = (name: string, rawInput: Schema.Json): Acp.RequestPermissionRequest => ({
    sessionId: "s",
    title: `mcp__fuse-deck__${name}`,
    toolCall: { toolCallId: "t", title: `mcp__fuse-deck__${name}`, rawInput },
    options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }],
  });

  it.each([
    {
      name: "slides_add",
      input: { id: "agenda", after: "intro" },
      summary: "Add slide `agenda` after `intro`",
    },
    {
      name: "slides_add",
      input: { id: "agenda", title: "Agenda", layout: "section" },
      summary: "Add slide `agenda` at the end, titled “Agenda”, with the section layout",
    },
    {
      name: "slides_move",
      input: { id: "outro", before: "intro" },
      summary: "Move slide `outro` before `intro`",
    },
    { name: "slides_remove", input: { id: "outro" }, summary: "Remove slide `outro`" },
    {
      name: "view_go",
      input: { id: "agenda", step: 2 },
      summary: "Show slide `agenda` in the preview, at step 2",
    },
    { name: "slides_list", input: {}, summary: "List the slides" },
  ])("says what $name does with $input, and shows the arguments", ({ name, input, summary }) => {
    const entry = permissionEntry("r2", deckTool(name, input));
    assert.deepStrictEqual(
      { summary: entry.summary, arguments: entry.arguments },
      {
        summary,
        arguments: Object.keys(input).length === 0 ? null : JSON.stringify(input, null, 2),
      }
    );
  });

  it("leaves out the arguments of an edit whose diff the card shows", () => {
    const entry = permissionEntry("r4", {
      sessionId: "s",
      title: "Edit slides/intro.mdx",
      toolCall: {
        toolCallId: "t",
        title: "Edit slides/intro.mdx",
        rawInput: { file_path: "/deck/slides/intro.mdx", old_string: "# Intro", new_string: "# Attacked" },
        content: [
          { type: "diff", path: "/deck/slides/intro.mdx", oldText: "# Intro\n", newText: "# Attacked\n" },
        ],
      },
      options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }],
    });
    assert.deepStrictEqual(
      { arguments: entry.arguments, diffs: entry.diffs.length },
      { arguments: null, diffs: 1 }
    );
  });

  it("shows another MCP tool's arguments, with no sentence", () => {
    const entry = permissionEntry("r3", {
      ...deckTool("slides_add", { id: "x" }),
      title: "mcp__other__search",
      toolCall: { toolCallId: "t", title: "mcp__other__search", rawInput: { query: "fuse" } },
    });
    assert.deepStrictEqual(
      { summary: entry.summary, arguments: entry.arguments },
      { summary: null, arguments: '{\n  "query": "fuse"\n}' }
    );
  });

  it("settles a pending request once, so a later withdrawal keeps the user's choice", () => {
    const chosen = settlePermission([permissionEntry("r1", request)], "r1", {
      _tag: "Chosen",
      choice: { optionId: "yes", name: "Allow", kind: "allow_once" },
    });
    const after = settlePermission(chosen, "r1", { _tag: "Withdrawn", reason: "The turn ended." });
    assert.deepStrictEqual(after[0]?._tag === "Permission" ? after[0].outcome : undefined, {
      _tag: "Chosen",
      choice: { optionId: "yes", name: "Allow", kind: "allow_once" },
    });
  });
});
