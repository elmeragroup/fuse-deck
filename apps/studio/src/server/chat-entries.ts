/**
 * Maps the agent's ACP traffic onto chat entries, through effect-acp's compatibility types, so
 * ACP v1 and v2 agents land in the same entries. Pure: each function takes the entries and returns
 * new ones.
 *
 * ACP v1 streams a message as chunks and opens a tool call with `tool_call`; v2 may also send a
 * whole message (`agent_message`) and opens a tool call with its first `tool_call_update`. So
 * messages and tool calls are upserts keyed by their ids: a whole message replaces the text its
 * chunks built, and a tool call update merges into the entry or creates it. Updates the chat does
 * not show (plans, usage, modes, commands, unknown variants) leave the entries as they are.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Acp from "@elmeragroup/effect-acp/compat";

import type { ChatEntry, NamedChange, PermissionChoice, ProposedDiff } from "../contract/agent-chat.ts";

type ToolEntry = Extract<ChatEntry, { readonly _tag: "Tool" }>;
type PermissionEntry = Extract<ChatEntry, { readonly _tag: "Permission" }>;
type TextEntry = Extract<ChatEntry, { readonly _tag: "Agent" | "Thought" }>;

/** A named change, of any operation, with the fields the chat shows. */
const decodeChange = Schema.decodeUnknownOption(
  Schema.Struct({
    operation: Schema.String,
    path: Schema.String,
    oldPath: Schema.optionalKey(Schema.String),
  })
);

const decodeCommand = Schema.decodeUnknownOption(Schema.String);

/** The text of a content block, or a short placeholder for content the chat does not render. */
function contentText(content: Acp.ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return `[${content.name}](${content.uri})`;
    default:
      return "";
  }
}

/**
 * Append `text` to the message `messageId` names, or to the last entry when the chunk carries no
 * id and that entry is a message of the same kind; otherwise start a new message.
 */
function appendChunk(
  entries: ReadonlyArray<ChatEntry>,
  tag: TextEntry["_tag"],
  messageId: string | null | undefined,
  text: string,
  nextId: () => string
): ReadonlyArray<ChatEntry> {
  const index =
    messageId === null || messageId === undefined
      ? entries.length - 1
      : entries.findIndex((entry) => entry._tag === tag && entry.id === messageId);
  const target = entries[index];
  if (index >= 0 && target?._tag === tag) {
    return entries.with(index, { ...target, text: target.text + text });
  }
  return [...entries, { _tag: tag, id: messageId ?? nextId(), text }];
}

/** Set the message `messageId` names to `text`, or add it. */
function replaceMessage(
  entries: ReadonlyArray<ChatEntry>,
  tag: TextEntry["_tag"],
  messageId: string,
  text: string
): ReadonlyArray<ChatEntry> {
  const index = entries.findIndex((entry) => entry._tag === tag && entry.id === messageId);
  const target = entries[index];
  return index >= 0 && target?._tag === tag
    ? entries.with(index, { ...target, text })
    : [...entries, { _tag: tag, id: messageId, text }];
}

/** The diffs and named changes in a tool call's content. */
export function fileDetail(
  content: ReadonlyArray<Acp.ToolCallContent> | null | undefined
): Pick<ToolEntry, "diffs" | "changes"> {
  const diffs: Array<ProposedDiff> = [];
  const changes: Array<NamedChange> = [];
  for (const item of content ?? []) {
    if (item.type !== "diff") {
      continue;
    }
    if ("newText" in item) {
      diffs.push({ _tag: "TextDiff", path: item.path, oldText: item.oldText ?? null, newText: item.newText });
      continue;
    }
    if (item.patch !== null && item.patch !== undefined) {
      diffs.push({ _tag: "Patch", text: item.patch.text });
    }
    for (const change of item.changes) {
      // ACP leaves room for future operations, whose fields are plain JSON.
      const named = decodeChange(change);
      if (Option.isSome(named)) {
        const { operation, path, oldPath } = named.value;
        changes.push({ operation, path, oldPath: oldPath ?? null });
      }
    }
  }
  return { diffs, changes };
}

/** Merge a tool call update into its entry, or add the entry. */
function upsertTool(entries: ReadonlyArray<ChatEntry>, update: Acp.ToolCallUpdate): ReadonlyArray<ChatEntry> {
  const index = entries.findIndex((entry) => entry._tag === "Tool" && entry.id === update.toolCallId);
  const existing = entries[index];
  const base: ToolEntry =
    index >= 0 && existing?._tag === "Tool"
      ? existing
      : {
          _tag: "Tool",
          id: update.toolCallId,
          title: "Tool call",
          kind: null,
          status: null,
          paths: [],
          diffs: [],
          changes: [],
        };
  const detail = update.content === undefined ? undefined : fileDetail(update.content);
  const merged: ToolEntry = {
    ...base,
    title: update.title ?? base.title,
    kind: update.kind ?? base.kind,
    status: update.status ?? base.status,
    paths: update.locations?.map((location) => location.path) ?? base.paths,
    diffs: detail?.diffs ?? base.diffs,
    changes: detail?.changes ?? base.changes,
  };
  return index >= 0 ? entries.with(index, merged) : [...entries, merged];
}

/**
 * The entries after one `session/update`.
 *
 * @param nextId - Mints an id for an entry the update does not name.
 */
export function applySessionUpdate(
  entries: ReadonlyArray<ChatEntry>,
  update: Acp.SessionUpdate,
  nextId: () => string
): ReadonlyArray<ChatEntry> {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return appendChunk(entries, "Agent", update.messageId, contentText(update.content), nextId);
    case "agent_thought_chunk":
      return appendChunk(entries, "Thought", update.messageId, contentText(update.content), nextId);
    case "agent_message":
      return replaceMessage(
        entries,
        "Agent",
        update.messageId,
        (update.content ?? []).map(contentText).join("")
      );
    case "agent_thought":
      return replaceMessage(
        entries,
        "Thought",
        update.messageId,
        (update.content ?? []).map(contentText).join("")
      );
    case "tool_call":
    case "tool_call_update":
      return upsertTool(entries, update);
    case "tool_call_content_chunk": {
      const index = entries.findIndex((entry) => entry._tag === "Tool" && entry.id === update.toolCallId);
      const existing = entries[index];
      if (existing?._tag !== "Tool") {
        return entries;
      }
      const detail = fileDetail([update.content]);
      return entries.with(index, {
        ...existing,
        diffs: [...existing.diffs, ...detail.diffs],
        changes: [...existing.changes, ...detail.changes],
      });
    }
    case "notice":
      return [
        ...entries,
        {
          _tag: "Notice",
          id: nextId(),
          tone: update.severity === "error" ? "error" : "info",
          text:
            update.description === null || update.description === undefined
              ? update.title
              : `${update.title}: ${update.description}`,
        },
      ];
    default:
      // The user's own messages come from the prompt, and the rest are not shown.
      return entries;
  }
}

/**
 * The entry for a permission request, pending.
 *
 * @param id - The card's id, which the decision names; the chat mints it, since a new agent
 *   process numbers its requests from the start again.
 */
export function permissionEntry(id: string, request: Acp.RequestPermissionRequest): PermissionEntry {
  const choices: ReadonlyArray<PermissionChoice> = request.options.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    kind: option.kind,
  }));
  const subject = request.subject;
  return {
    _tag: "Permission",
    id,
    title: request.title ?? request.toolCall.title ?? "The agent asks for permission",
    command: subject?.type === "command" ? Option.getOrNull(decodeCommand(subject.command)) : null,
    choices,
    outcome: { _tag: "Pending" },
    paths: request.toolCall.locations?.map((location) => location.path) ?? [],
    ...fileDetail(request.toolCall.content),
  };
}

/** The entries with the permission request `id` settled as `outcome`. */
export function settlePermission(
  entries: ReadonlyArray<ChatEntry>,
  id: string,
  outcome: PermissionEntry["outcome"]
): ReadonlyArray<ChatEntry> {
  const index = entries.findIndex((entry) => entry._tag === "Permission" && entry.id === id);
  const existing = entries[index];
  return existing?._tag === "Permission" && existing.outcome._tag === "Pending"
    ? entries.with(index, { ...existing, outcome })
    : entries;
}
