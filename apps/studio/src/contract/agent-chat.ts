/**
 * The agent chat as the renderer sees it: the backend holds one chat per open deck, maps the
 * agent's ACP updates onto these entries, and streams the whole state on every change. The
 * contract is the studio's own; nothing in it names an ACP type, so the renderer never loads
 * the protocol code.
 *
 * Like every deck call, each chat call carries the deck's scope id.
 */

import * as Schema from "effect/Schema";

import { SlideId } from "@elmeragroup/deck-core/deck/slide-id";

/** What the preview showed when the user sent a prompt: the slide and its step. */
export const ViewContext = Schema.Struct({
  slideId: SlideId,
  step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** What the preview showed when the user sent a prompt. */
export type ViewContext = typeof ViewContext.Type;

/** One answer the agent offers to a permission request. */
export const PermissionChoice = Schema.Struct({
  optionId: Schema.String,
  name: Schema.String,
  /** ACP's hint: `allow_once`, `allow_always`, `reject_once`, `reject_always` or a newer kind. */
  kind: Schema.String,
});

/** One answer the agent offers to a permission request. */
export type PermissionChoice = typeof PermissionChoice.Type;

/** A file edit the agent shows: a whole-file text diff (ACP v1) or a patch (ACP v2). */
export const ProposedDiff = Schema.Union([
  Schema.TaggedStruct("TextDiff", {
    path: Schema.String,
    /** The file before the edit, or null when the edit creates it. */
    oldText: Schema.NullOr(Schema.String),
    newText: Schema.String,
  }),
  Schema.TaggedStruct("Patch", { text: Schema.String }),
]);

/** A file edit the agent shows. */
export type ProposedDiff = typeof ProposedDiff.Type;

/** A file the agent names as changed, without its contents (an ACP v2 `changes[]` entry). */
export const NamedChange = Schema.Struct({
  /** `add`, `delete`, `modify`, `move` or a newer operation. */
  operation: Schema.String,
  path: Schema.String,
  /** Where a moved file came from, or null. */
  oldPath: Schema.NullOr(Schema.String),
});

/** A file the agent names as changed. */
export type NamedChange = typeof NamedChange.Type;

/** How a permission request stands. */
export const PermissionOutcome = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Chosen", { choice: PermissionChoice }),
  /** Answered as cancelled without the user: Stop, the turn ended, or the agent went away. */
  Schema.TaggedStruct("Withdrawn", { reason: Schema.String }),
]);

/** How a permission request stands. */
export type PermissionOutcome = typeof PermissionOutcome.Type;

/** What a tool call or a permission request shows about the files it touches. */
const FileDetail = {
  /** The locations the agent names. */
  paths: Schema.Array(Schema.String),
  diffs: Schema.Array(ProposedDiff),
  changes: Schema.Array(NamedChange),
};

/** One entry in the chat. */
export const ChatEntry = Schema.Union([
  /** A prompt the user sent, with the view it carried. */
  Schema.TaggedStruct("User", { id: Schema.String, text: Schema.String, view: Schema.NullOr(ViewContext) }),
  /** The agent's reply, as Markdown. */
  Schema.TaggedStruct("Agent", { id: Schema.String, text: Schema.String }),
  /** The agent's reasoning, as Markdown. */
  Schema.TaggedStruct("Thought", { id: Schema.String, text: Schema.String }),
  /** A tool the agent ran or runs. `status` is ACP's, or null before the agent reports one. */
  Schema.TaggedStruct("Tool", {
    id: Schema.String,
    title: Schema.String,
    kind: Schema.NullOr(Schema.String),
    status: Schema.NullOr(Schema.String),
    ...FileDetail,
  }),
  /** The agent asks before it acts. */
  Schema.TaggedStruct("Permission", {
    id: Schema.String,
    title: Schema.String,
    /** A shell command the request is about, or null. */
    command: Schema.NullOr(Schema.String),
    choices: Schema.Array(PermissionChoice),
    outcome: PermissionOutcome,
    ...FileDetail,
  }),
  /** Something the studio or the agent reports, such as a failed start. */
  Schema.TaggedStruct("Notice", {
    id: Schema.String,
    tone: Schema.Literals(["info", "error"]),
    text: Schema.String,
  }),
]);

/** One entry in the chat. */
export type ChatEntry = typeof ChatEntry.Type;

/** The agent process behind the chat. */
export const AgentSession = Schema.Union([
  /** None yet: the first prompt starts one. */
  Schema.TaggedStruct("NotStarted", {}),
  Schema.TaggedStruct("Starting", {}),
  Schema.TaggedStruct("Ready", {
    /** The agent's name and version, as it reports them. */
    agent: Schema.String,
    /** The ACP generation the agent answered `initialize` with. */
    generation: Schema.Literals([1, 2]),
    /** The permission mode the session runs in. */
    mode: Schema.String,
  }),
  /** The process is gone; the next prompt starts a new one. */
  Schema.TaggedStruct("Ended", { reason: Schema.String }),
]);

/** The agent process behind the chat. */
export type AgentSession = typeof AgentSession.Type;

/**
 * The current turn: none, one running, or one the user stopped that the agent has not finished.
 * Source is read-only while it is not `Idle`.
 */
export const AgentTurn = Schema.Literals(["Idle", "Running", "Stopping"]);

/** The current turn. */
export type AgentTurn = typeof AgentTurn.Type;

/** The chat of one open deck. */
export const ChatState = Schema.Struct({
  scopeId: Schema.String,
  session: AgentSession,
  turn: AgentTurn,
  entries: Schema.Array(ChatEntry),
});

/** The chat of one open deck. */
export type ChatState = typeof ChatState.Type;

/** A prompt for the agent, with the view it was sent from. */
export const PromptInput = Schema.Struct({
  text: Schema.String.check(Schema.isNonEmpty()),
  view: Schema.NullOr(ViewContext),
});

/** A prompt for the agent. */
export type PromptInput = typeof PromptInput.Type;

/** One deck file whose bytes differ from the snapshot taken when the last turn started. */
export const ObservedChange = Schema.Struct({
  /** Relative to the deck directory: `deck.json` or `slides/<id>.mdx`. */
  path: Schema.String,
  /** The text at the snapshot, or null when the file did not exist then. */
  before: Schema.NullOr(Schema.String),
  /** The text on disk now, or null when the file is gone. */
  after: Schema.NullOr(Schema.String),
});

/** One deck file that changed since the last turn started. */
export type ObservedChange = typeof ObservedChange.Type;

/** What changed on disk since the last turn started; `turn` is null before the first turn. */
export const ObservedChanges = Schema.Struct({
  turn: Schema.NullOr(Schema.Int),
  files: Schema.Array(ObservedChange),
});

/** What changed on disk since the last turn started. */
export type ObservedChanges = typeof ObservedChanges.Type;

/** A turn is already running; the prompt was not sent. */
export class AgentBusy extends Schema.TaggedError<AgentBusy>()("AgentBusy", {
  message: Schema.String,
}) {}

/** The decision named a request that is no longer pending, or a choice it does not offer. */
export class PermissionGone extends Schema.TaggedError<PermissionGone>()("PermissionGone", {
  message: Schema.String,
}) {}
