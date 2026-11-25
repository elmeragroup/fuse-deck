/**
 * The agent chat of each open deck. Each deck scope gets one chat, which starts its agent on the
 * first prompt and ends it when the deck closes or switches.
 *
 * A session is one agent process, spawned in its own process group from the studio's agent
 * directory (see `agent-launch.ts`), and spoken to over ACP through effect-acp's compatibility
 * client. The deck is untrusted, so it is never the session's working directory: the session works
 * in a directory of the studio's, made for it and removed when it ends, which holds only the
 * studio's `SESSION_SETTINGS` (see `SESSION_SETTINGS_FILE`), and the deck reaches
 * the agent as the session's additional directory, its path in the system prompt (see
 * `deckSystemPrompt`). Claude Code reads only the user's own settings, never the deck's (see
 * `CLAUDE_CODE_OPTIONS`). The agent
 * runs with Claude Code's background tasks off, so no command or subagent it starts outlives its
 * turn, and Source unlocks only when no agent work can still write. The studio offers
 * no client file system and no terminal, so the agent edits the deck with its own tools. The
 * session runs in the adapter's `default` permission mode, set through the session's mode config
 * option (ACP v2) or `session/set_mode` (ACP v1), so the agent asks before it changes anything; a
 * session whose mode cannot be confirmed is ended before any prompt reaches it.
 *
 * One turn runs at a time. Each turn snapshots the deck's text files first, for the Changes tab.
 * A permission request shows as a card with the agent's choices and waits for the user. Every way
 * a request can end goes through one place, so its card always settles: the user's choice, Stop,
 * the end of the turn, the agent's exit or a closed connection, or the agent dropping the request.
 *
 * Stop sends `session/cancel` and answers every pending request as cancelled. The turn stays
 * `Stopping`, and Source stays read-only, until the agent ends the turn or its process exits. An
 * agent that has not ended the turn `STOP_DEADLINE` after Stop is stopped with its process group,
 * so a stuck adapter cannot keep Source locked; the next prompt starts a new session.
 *
 * The process group gets SIGTERM, then SIGKILL after `KILL_GRACE`, when its session ends, which
 * effect's child-process spawner does for a detached child as its scope closes.
 *
 * With an MCP relay configured, each session gets the deck tools: `session/new` names the relay as
 * a stdio MCP server, with the backend's `/mcp` address and a token `McpTokens` minted for this
 * session and deck. The token is in the relay's environment only, never the agent's own, and the
 * protocol log writes it as `<mcp-token>`. It is revoked as the session's scope closes, so a failed
 * setup, the agent's exit, a closed connection and the deck's close all revoke it; Stop does not.
 * The tool calls a session makes run in the chat, and only from the moment a turn's prompt goes out
 * until Stop or the turn's end: Stop interrupts the running ones and refuses new ones, and the turn
 * ends only once they have settled, refusing new ones while it waits.
 */

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { DeckFiles } from "@elmeragroup/deck-core/deck/deck-files";
import { slidePath } from "@elmeragroup/deck-core/deck/slide-id";
import * as AcpClient from "@elmeragroup/effect-acp/client";
import type * as Acp from "@elmeragroup/effect-acp/compat";
import type { AcpProtocolLogEvent } from "@elmeragroup/effect-acp/protocol";

import { AgentBusy, PermissionGone } from "../contract/agent-chat.ts";
import type {
  AgentSession,
  ChatEntry,
  ChatState,
  ObservedChanges,
  PermissionOutcome,
  PromptInput,
  ViewContext,
} from "../contract/agent-chat.ts";
import type { ScopeId } from "../contract/studio-rpc.ts";
import {
  RELAY_AUTHORIZATION_VARIABLE,
  RELAY_ENDPOINT_VARIABLE,
  RELAY_LOG_VARIABLE,
} from "../relay/relay-environment.ts";
import { AgentLaunch } from "./agent-launch.ts";
import type { AgentCommand } from "./agent-launch.ts";
import { applySessionUpdate, permissionEntry, settlePermission } from "./chat-entries.ts";
import { diffSnapshots, readDeckSnapshot } from "./deck-snapshot.ts";
import type { DeckSnapshot } from "./deck-snapshot.ts";
import { McpTokens } from "./mcp-tokens.ts";
import type { MintedToken } from "./mcp-tokens.ts";

/** How long after Stop the agent may take to end its turn before its process group is stopped. */
export const STOP_DEADLINE = Duration.seconds(15);

/** How the agent reaches the deck tools: the relay command and the backend's `/mcp`. */
export type McpRelay = {
  /** The relay's executable, an absolute path: the backend's own Node. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The relay's environment besides the endpoint and the token. */
  readonly env: Readonly<Record<string, string>>;
  /** The backend's `/mcp` address. */
  readonly endpoint: string;
};

/** The name the deck tools' MCP server goes by, which prefixes their names in the agent. */
export const MCP_SERVER_NAME = "fuse-deck";

/** What the chats need from the host. */
export type AgentChatsConfig = {
  /** How long after Stop the agent may take to end its turn; `STOP_DEADLINE` in the app. */
  readonly stopDeadline: Duration.Duration;
  /** The relay to the deck tools, or none to give the agent no deck tools. */
  readonly mcpRelay: Option.Option<McpRelay>;
};

/** How long the agent's process group gets between SIGTERM and SIGKILL. */
const KILL_GRACE = Duration.seconds(1);

/** How long the chat gathers state changes into one report, so streamed text is not sent per chunk. */
const REPORT_WINDOW = Duration.millis(50);

/** How much of the agent's stderr a failure message quotes. */
const STDERR_TAIL = 2000;

/** The permission mode the studio runs the agent in: ask before every change. */
const ASK_MODE = "default";

/**
 * The Claude Agent SDK options the studio passes in `session/new` `_meta.claudeCode.options`, which
 * claude-agent-acp 0.109.0 spreads over its own defaults (`openQuery` in `dist/v2/agent.js`). The
 * deck, an additional directory of the session, is untrusted:
 * - `settingSources: ["user"]`: Claude Code loads no project or local settings, so no hooks,
 *   permissions or CLAUDE.md the deck ships.
 * - `strictMcpConfig: true`: only the MCP servers `session/new` names start, never a `.mcp.json`.
 * - `perTaskStopAffordance: false`: Stop's interrupt stops background tasks too.
 * - `allowDangerouslySkipPermissions: false`: no bypass mode, even if the deck's local settings ask.
 * The initial permission mode cannot be set here: the adapter assigns `permissionMode` after these
 * options, from the settings it reads in the session's working directory, so the studio writes
 * `SESSION_SETTINGS` there. It still sets `default` and confirms it before any prompt, and no
 * prompt runs before that.
 */
const CLAUDE_CODE_OPTIONS = {
  settingSources: ["user"],
  strictMcpConfig: true,
  perTaskStopAffordance: false,
  allowDangerouslySkipPermissions: false,
};

/**
 * What the studio appends to Claude Code's system prompt (`session/new` `_meta.systemPrompt`, which
 * claude-agent-acp 0.109.0 passes on as the preset's `append`): where the deck is, since the
 * session's working directory is not the deck.
 */
const deckSystemPrompt = (deck: string) =>
  [
    `You work on a fuse-deck slide deck at ${deck}. It is not your working directory, which is a directory the studio made for this session.`,
    `Resolve every deck path you are given, such as slides/intro.mdx, against ${deck}, and pass absolute paths under it to your file tools.`,
    `Shell commands start outside the deck; give them absolute paths, or change into ${deck} first.`,
  ].join("\n");

/**
 * The settings file the studio writes into each session's working directory, the one source of
 * `permissions.defaultMode` the adapter reads there (`SettingsManager` in claude-agent-acp 0.109.0
 * reads the user's, the managed and `<cwd>/.claude/settings*.json`). A local file outranks a
 * `defaultMode` in the user's own settings, so the session opens in the asking mode; without it the
 * adapter falls back to `auto`. Claude Code itself never reads it (`settingSources: ["user"]`).
 */
const SESSION_SETTINGS_FILE = path.join(".claude", "settings.local.json");

/** The contents of `SESSION_SETTINGS_FILE`. */
const SESSION_SETTINGS = { permissions: { defaultMode: ASK_MODE } };

const encodeSessionSettings = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ permissions: Schema.Struct({ defaultMode: Schema.String }) }))
);

/** The ACP `clientInfo` the studio sends. */
const CLIENT_INFO = { name: "fuse-deck-studio", version: "0.0.0" };

/** A deck tool call that the chat would not run: its session ended, or Stop is under way. */
export class ToolCallRefused extends Schema.TaggedError<ToolCallRefused>()("ToolCallRefused", {
  message: Schema.String,
}) {}

/** The agent could not be started or set up. */
class AgentStartFailed extends Schema.TaggedError<AgentStartFailed>()("AgentStartFailed", {
  message: Schema.String,
}) {}

/** One open deck's chat. */
export type AgentChat = {
  /** The chat now and on every change, until the deck closes. */
  readonly state: Stream.Stream<ChatState>;
  /** Start a turn with `input`. Returns once the turn has started, not when it ends. */
  readonly prompt: (input: PromptInput) => Effect.Effect<void, AgentBusy>;
  /** Stop the running turn, if any. */
  readonly stop: Effect.Effect<void>;
  /** Answer the pending permission request `id` with the agent's choice `optionId`. */
  readonly decide: (id: string, optionId: string) => Effect.Effect<void, PermissionGone>;
  /** The deck files that differ from the snapshot the last turn took when it started. */
  readonly changes: Effect.Effect<ObservedChanges>;
  /** End the agent and close the chat; the deck is closing. */
  readonly end: Effect.Effect<void>;
  /**
   * Run a deck tool call the session `sessionKey` made, while a turn runs: not after that session
   * ended, during Stop, or between turns. Stop interrupts it, and the turn ends only once it has
   * settled.
   */
  readonly toolCall: <A, E, R>(
    sessionKey: string,
    call: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | ToolCallRefused, R>;
};

/** The deck a chat belongs to. */
export type ChatDeck = {
  readonly scopeId: ScopeId;
  readonly files: DeckFiles["Service"];
};

/** One running agent process and its ACP session. */
type LiveSession = {
  readonly scope: Scope.Closeable;
  readonly acp: AcpClient.AcpClient["Service"];
  readonly sessionId: string;
  readonly embeddedContext: boolean;
  /** The session's MCP token's key in `McpTokens`, or none without a relay. */
  readonly mcpSession: Option.Option<string>;
  /** Completes with the reason once the process exits or its connection closes. */
  readonly ended: Deferred.Deferred<string>;
};

/** Makes the chat of each open deck. */
export class AgentChats extends Context.Service<
  AgentChats,
  {
    /** The chat of `deck`, which ends when the scope it is made in closes. */
    readonly make: (deck: ChatDeck) => Effect.Effect<AgentChat, never, Scope.Scope>;
  }
>()("@elmeragroup/fuse-deck-studio/server/AgentChats") {
  /**
   * The chats, launching the agent `AgentLaunch` names.
   *
   * @param config - The Stop deadline.
   */
  static readonly layer = (config: AgentChatsConfig) =>
    Layer.effect(
      AgentChats,
      Effect.gen(function* () {
        const services = yield* Effect.context<
          AgentLaunch | McpTokens | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
        >();
        return AgentChats.of({
          make: (deck) => makeChat(deck, config).pipe(Effect.provide(services)),
        });
      })
    );
}

const makeChat = Effect.fn("AgentChats.make")(function* (deck: ChatDeck, config: AgentChatsConfig) {
  const launch = yield* AgentLaunch;
  const tokens = yield* McpTokens;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const chatScope = yield* Scope.Scope;
  const root = deck.files.root;

  const state = yield* SubscriptionRef.make<ChatState>({
    scopeId: deck.scopeId,
    session: { _tag: "NotStarted" },
    turn: "Idle",
    entries: [],
  });
  const closed = yield* Deferred.make<void>();
  // Prompt, Stop and the end of the chat change the turn one at a time.
  const turns = yield* Semaphore.make(1);
  const turnFiber = yield* FiberHandle.make<void, never>();
  const stopWatch = yield* FiberHandle.make<void, never>();
  // The deck tool calls the agent makes, which Stop interrupts and the end of a turn waits for.
  const toolCalls = yield* FiberSet.make<unknown, unknown>();
  const pending = new Map<string, Deferred.Deferred<PermissionOutcome>>();
  let live: LiveSession | undefined;
  let lastTurn: { readonly turn: number; readonly snapshot: DeckSnapshot } | undefined;
  let turnCount = 0;
  // Whether the running turn's prompt went out; before then, Stop cancels the turn's own fiber.
  let prompted = false;
  // Whether the session's deck tool calls are admitted: from the prompt's dispatch until Stop or
  // the turn's end. It changes only under `admission`, which a call holds while it is checked and
  // registered in `toolCalls`, so Stop and the turn's end either precede a call or cancel it. A
  // lock of its own: `end` and Stop hold `turns` while they wait for the turn's fiber to end.
  const admission = yield* Semaphore.make(1);
  let admitting = false;
  const closeAdmission = admission.withPermits(1)(
    Effect.sync(() => {
      admitting = false;
    })
  );
  let entryCount = 0;
  const nextId = () => {
    entryCount += 1;
    return `entry-${String(entryCount)}`;
  };

  const modify = (change: (current: ChatState) => ChatState) => SubscriptionRef.update(state, change);
  const editEntries = (change: (entries: ReadonlyArray<ChatEntry>) => ReadonlyArray<ChatEntry>) =>
    modify((current) => ({ ...current, entries: change(current.entries) }));
  const notice = (tone: "info" | "error", text: string) =>
    editEntries((entries) => [...entries, { _tag: "Notice", id: nextId(), tone, text }]);
  const setSession = (session: AgentSession) => modify((current) => ({ ...current, session }));

  /** Answer every pending request as cancelled, its card withdrawn for `reason`. */
  const withdrawAll = Effect.fnUntraced(function* (reason: string) {
    const requests = [...pending.entries()];
    pending.clear();
    for (const [id, decision] of requests) {
      yield* editEntries((entries) => settlePermission(entries, id, { _tag: "Withdrawn", reason }));
      yield* Deferred.succeed(decision, { _tag: "Withdrawn", reason });
    }
  });

  /** End `session` for `reason`: its requests are withdrawn and its process group stopped. */
  const endSession = Effect.fnUntraced(function* (session: LiveSession, reason: string) {
    // Taken before `ended` wakes the watcher, so the caller, not the watcher, closes the session
    // and returns only once the agent has stopped.
    const current = live === session;
    if (current) {
      live = undefined;
    }
    yield* Deferred.succeed(session.ended, reason);
    if (!current) {
      return;
    }
    yield* withdrawAll(reason);
    yield* setSession({ _tag: "Ended", reason });
    yield* Scope.close(session.scope, Exit.void);
  }, Effect.uninterruptible);

  const onPermission = (
    request: Acp.RequestPermissionRequest
  ): Effect.Effect<Acp.RequestPermissionResponse> => {
    // The card's own id: a new agent process numbers its requests from the start again.
    const id = nextId();
    return Effect.gen(function* () {
      if ((yield* SubscriptionRef.get(state)).turn !== "Running") {
        // A request outside a running turn, or after Stop, is cancelled at once.
        return { outcome: { outcome: "cancelled" } } satisfies Acp.RequestPermissionResponse;
      }
      const decision = yield* Deferred.make<PermissionOutcome>();
      pending.set(id, decision);
      yield* editEntries((entries) => [...entries, permissionEntry(id, request)]);
      const outcome = yield* Deferred.await(decision);
      return outcome._tag === "Chosen"
        ? { outcome: { outcome: "selected", optionId: outcome.choice.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }).pipe(
      // Interrupted when the agent drops the request or the connection goes: the card settles too.
      Effect.ensuring(
        Effect.suspend(() => {
          pending.delete(id);
          return editEntries((entries) =>
            settlePermission(entries, id, { _tag: "Withdrawn", reason: "The agent withdrew the request." })
          );
        })
      )
    );
  };

  /** Spawn the agent, open an ACP session on the deck and put it in the asking mode. */
  const startSession = Effect.fn("AgentChat.startSession")(function* (command: AgentCommand) {
    const scope = yield* Scope.fork(chatScope);
    // The agent's last words on stderr, which a failed start quotes.
    let stderrTail = "";
    const withStderr = (message: string) =>
      stderrTail.trim() === "" ? message : `${message} ${stderrTail.trim()}`;
    return yield* Effect.gen(function* () {
      const ended = yield* Deferred.make<string>();
      // Made before the agent starts, so its scope removes it only once the agent has stopped.
      const sessionDirectory = yield* fs
        .makeTempDirectoryScoped({ directory: command.sessionsDirectory, prefix: "session-" })
        .pipe(
          Scope.provide(scope),
          Effect.mapError(
            (error) =>
              new AgentStartFailed({ message: `Could not make the session's directory: ${error.message}` })
          )
        );
      const settingsFile = path.join(sessionDirectory, SESSION_SETTINGS_FILE);
      yield* encodeSessionSettings(SESSION_SETTINGS).pipe(
        Effect.flatMap((text) =>
          fs
            .makeDirectory(path.dirname(settingsFile), { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(settingsFile, `${text}\n`)))
        ),
        Effect.mapError(
          (error) =>
            new AgentStartFailed({ message: `Could not write the session's settings: ${error.message}` })
        )
      );
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(command.command, [...command.args], {
            cwd: command.cwd,
            env: {
              ...command.env,
              PATH: command.pathVariable,
              CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: "1",
              // Work Claude Code would go on with after the turn ends, past Stop and the Source lock.
              CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
            },
            extendEnv: true,
            detached: true,
            forceKillAfter: KILL_GRACE,
          })
        )
        .pipe(
          Scope.provide(scope),
          Effect.mapError(
            (error) =>
              new AgentStartFailed({
                message: `The agent (${command.command}) did not start: ${error.message}`,
              })
          )
        );
      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
          })
        ),
        Effect.ignore,
        Effect.forkIn(scope)
      );
      yield* handle.exitCode.pipe(
        Effect.map((code) => `The agent exited with code ${String(code)}.`),
        Effect.orElseSucceed(() => "The agent's process ended."),
        Effect.flatMap((reason) => Deferred.succeed(ended, withStderr(reason))),
        Effect.forkIn(scope)
      );
      // Minted for this session, and revoked as its scope closes, however the session ends.
      const minted = yield* Option.match(config.mcpRelay, {
        onNone: () => Effect.succeed(Option.none<MintedToken>()),
        onSome: () =>
          tokens.mint(deck.scopeId).pipe(
            Effect.tap((token) => Scope.addFinalizer(scope, tokens.revokeSession(token.caller.sessionKey))),
            Effect.asSome
          ),
      });
      const secrets = Option.toArray(Option.map(minted, (token) => Redacted.value(token.token)));
      const generation = { value: Option.none<1 | 2>() };
      const context = yield* Layer.buildWithScope(
        AcpClient.layerChildProcess(handle, {
          logIncoming: true,
          logOutgoing: Option.isSome(command.protocolLog),
          logger: protocolLogger(command.protocolLog, generation, fs, secrets),
          onTermination: (error) =>
            Deferred.succeed(ended, `The connection to the agent closed: ${error.message}`).pipe(
              Effect.asVoid
            ),
        }),
        scope
      );
      const acp = Context.get(context, AcpClient.AcpClient);
      yield* acp.handleRequestPermission(onPermission);
      const startFailed = (step: string) => (error: { readonly message: string }) =>
        new AgentStartFailed({ message: withStderr(`${step} failed: ${error.message}`) });
      const initialized = yield* acp.agent
        .initialize({
          protocolVersion: 2,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: CLIENT_INFO,
        })
        .pipe(Effect.mapError(startFailed("The agent's initialize")));
      const mcpServers = Option.match(
        Option.zipWith(config.mcpRelay, minted, (relay, token) => relayServer(relay, token, command.mcpLog)),
        {
          onNone: () => [],
          onSome: (server) => [server],
        }
      );
      const created = yield* acp.agent
        .createSession({
          cwd: sessionDirectory,
          additionalDirectories: [root],
          mcpServers,
          _meta: {
            systemPrompt: { append: deckSystemPrompt(root) },
            claudeCode: { options: CLAUDE_CODE_OPTIONS },
          },
        })
        .pipe(Effect.mapError(startFailed("Opening a session")));
      const { sessionId } = created;
      yield* acp.handleSessionUpdate((notification) =>
        notification.sessionId === sessionId
          ? editEntries((entries) => applySessionUpdate(entries, notification.update, nextId))
          : Effect.void
      );
      const mode = yield* askingMode(acp, sessionId, created).pipe(
        Effect.mapError(startFailed("Setting the permission mode"))
      );
      const session: LiveSession = {
        scope,
        acp,
        sessionId,
        embeddedContext: initialized.agentCapabilities?.promptCapabilities?.embeddedContext === true,
        mcpSession: Option.map(minted, (token) => token.caller.sessionKey),
        ended,
      };
      const agent = initialized.agentInfo;
      yield* setSession({
        _tag: "Ready",
        agent: agent === undefined || agent === null ? command.command : `${agent.name} ${agent.version}`,
        generation: Option.getOrElse(generation.value, () => (initialized.protocolVersion >= 2 ? 2 : 1)),
        mode,
      });
      return session;
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  });

  /** The running session, or a new one. */
  const ensureSession = Effect.gen(function* () {
    if (live !== undefined && !(yield* Deferred.isDone(live.ended))) {
      return live;
    }
    yield* setSession({ _tag: "Starting" });
    const command = yield* launch
      .command(root)
      .pipe(Effect.mapError((error) => new AgentStartFailed({ message: error.message })));
    const session = yield* startSession(command).pipe(
      Effect.tapError((error) => setSession({ _tag: "Ended", reason: error.message })),
      // Stop while it starts: no agent runs, and the next prompt starts one.
      Effect.onInterrupt(() => setSession({ _tag: "NotStarted" }))
    );
    live = session;
    // Watched from the chat's scope, since ending the session closes the session's own.
    yield* Deferred.await(session.ended).pipe(
      Effect.flatMap((reason) => endSession(session, reason)),
      Effect.forkIn(chatScope)
    );
    return session;
  });

  /** The view, if the slide it names is still in the deck. */
  const checkedView = (view: ViewContext | null) =>
    view === null
      ? Effect.succeed(Option.none<ViewContext>())
      : deck.files.load.pipe(
          Effect.map(({ manifest }) =>
            manifest.order.includes(view.slideId) ? Option.some(view) : Option.none<ViewContext>()
          ),
          Effect.orElseSucceed(() => Option.none<ViewContext>())
        );

  /** The prompt's content: the view as text, the slide's source when the agent takes it, the text. */
  const promptBlocks = Effect.fnUntraced(function* (
    text: string,
    view: Option.Option<ViewContext>,
    embeddedContext: boolean
  ) {
    if (Option.isNone(view)) {
      return [{ type: "text", text }] satisfies ReadonlyArray<Acp.ContentBlock>;
    }
    const { slideId, step } = view.value;
    const relative = slidePath(slideId);
    const where: Acp.ContentBlock = {
      type: "text",
      text: `The studio's preview shows slide "${slideId}" (${relative}), step ${String(step)}.`,
    };
    const source = embeddedContext
      ? yield* deck.files.readSlide(slideId).pipe(Effect.option)
      : Option.none<string>();
    const embedded: ReadonlyArray<Acp.ContentBlock> = Option.match(source, {
      onNone: () => [],
      onSome: (slideText) => [
        {
          type: "resource",
          resource: {
            uri: pathToFileURL(path.join(root, relative)).href,
            mimeType: "text/markdown",
            text: slideText,
          },
        },
      ],
    });
    return [where, ...embedded, { type: "text", text }] satisfies ReadonlyArray<Acp.ContentBlock>;
  });

  /**
   * The turn, which `prompt` registered as running, with its user entry, before any disk I/O:
   * check the view, snapshot the deck, start or reuse the session, prompt, and end the turn. It runs in
   * the turn's fiber, so Stop or the end of the chat cancels a read that stalls as well.
   */
  const runTurn = Effect.fnUntraced(
    function* (input: PromptInput, entryId: string) {
      const view = yield* checkedView(input.view);
      if (Option.isNone(view) && input.view !== null) {
        // The user entry names no slide the deck does not have.
        yield* editEntries((entries) =>
          entries.map((entry) =>
            entry._tag === "User" && entry.id === entryId ? { ...entry, view: null } : entry
          )
        );
      }
      turnCount += 1;
      lastTurn = {
        turn: turnCount,
        snapshot: yield* readDeckSnapshot(root).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      };
      const { text } = input;
      const session = yield* ensureSession;
      const blocks = yield* promptBlocks(text, view, session.embeddedContext);
      yield* admission.withPermits(1)(
        Effect.sync(() => {
          prompted = true;
          admitting = true;
        })
      );
      const response = yield* session.acp.agent.prompt({ sessionId: session.sessionId, prompt: blocks }).pipe(
        Effect.mapError((error) => new AgentStartFailed({ message: error.message })),
        Effect.raceFirst(
          Deferred.await(session.ended).pipe(
            Effect.flatMap((reason) => Effect.fail(new AgentStartFailed({ message: reason })))
          )
        )
      );
      if (response.stopReason === "cancelled") {
        yield* notice("info", "Stopped.");
      } else if (response.error !== undefined && response.error !== null) {
        yield* notice("error", `The agent ended the turn with an error: ${response.error.message}`);
      } else if (response.stopReason !== "end_turn") {
        yield* notice("info", `The agent ended the turn: ${response.stopReason}.`);
      }
    },
    Effect.catch((error) => notice("error", error.message)),
    // Without the turn lock: `end` holds it while it interrupts this fiber.
    Effect.ensuring(
      Effect.gen(function* () {
        // No call starts while the turn drains the ones it admitted.
        yield* closeAdmission;
        yield* withdrawAll("The turn ended.");
        // Source unlocks only once no deck tool call of the turn can still write.
        yield* FiberSet.awaitEmpty(toolCalls);
        yield* FiberHandle.clear(stopWatch);
        yield* modify((current) => ({ ...current, turn: "Idle" }));
      })
    )
  );

  const prompt = (input: PromptInput) =>
    turns.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Deferred.isDone(closed)) {
          return yield* new AgentBusy({ message: "The deck is closing." });
        }
        if ((yield* SubscriptionRef.get(state)).turn !== "Idle") {
          return yield* new AgentBusy({ message: "The agent is still working on the last prompt." });
        }
        // Registered before any disk I/O, which runs in the turn's own fiber: the lock is never held
        // across a read, so Stop and the end of the chat cannot wait on one.
        prompted = false;
        const entryId = nextId();
        yield* modify((current) => ({
          ...current,
          turn: "Running",
          entries: [...current.entries, { _tag: "User", id: entryId, text: input.text, view: input.view }],
        }));
        yield* FiberHandle.run(turnFiber, runTurn(input, entryId));
      })
    );

  const stop = turns.withPermits(1)(
    Effect.gen(function* () {
      // Only a running turn stops; one that ended meanwhile stays ended.
      const stopping = yield* SubscriptionRef.modify(state, (current): readonly [boolean, ChatState] =>
        current.turn === "Running" ? [true, { ...current, turn: "Stopping" }] : [false, current]
      );
      if (!stopping) {
        return;
      }
      yield* closeAdmission;
      yield* FiberSet.clear(toolCalls);
      const session = live;
      if (session === undefined || !prompted) {
        // Still reading the deck or starting the agent: the turn's fiber is interrupted, which
        // ends the turn, and a start with it, before any prompt reaches the agent.
        yield* FiberHandle.clear(turnFiber);
        yield* notice("info", "Stopped before the agent started.");
        return;
      }
      yield* session.acp.agent.cancel({ sessionId: session.sessionId }).pipe(Effect.ignore);
      yield* withdrawAll("Stopped.");
      const overdue = Effect.gen(function* () {
        if ((yield* SubscriptionRef.get(state)).turn === "Stopping") {
          yield* endSession(
            session,
            `The agent had not ended its turn ${Duration.format(config.stopDeadline)} after Stop, so the studio stopped it.`
          );
        }
      });
      yield* FiberHandle.run(stopWatch, Effect.sleep(config.stopDeadline).pipe(Effect.andThen(overdue)));
    })
  );

  const decide = Effect.fnUntraced(function* (id: string, optionId: string) {
    const decision = pending.get(id);
    const entry = (yield* SubscriptionRef.get(state)).entries.find(
      (candidate) => candidate._tag === "Permission" && candidate.id === id
    );
    const choice =
      entry?._tag === "Permission" ? entry.choices.find((option) => option.optionId === optionId) : undefined;
    if (decision === undefined || choice === undefined) {
      return yield* new PermissionGone({ message: "That permission request is no longer waiting." });
    }
    pending.delete(id);
    yield* editEntries((entries) => settlePermission(entries, id, { _tag: "Chosen", choice }));
    yield* Deferred.succeed(decision, { _tag: "Chosen", choice });
  });

  const changes = Effect.gen(function* () {
    if (lastTurn === undefined) {
      return { turn: null, files: [] } satisfies ObservedChanges;
    }
    const now = yield* readDeckSnapshot(root).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    return { turn: lastTurn.turn, files: diffSnapshots(lastTurn.snapshot, now) } satisfies ObservedChanges;
  });

  // The chat refuses new turns first, then takes the lock, which no read holds, and cancels the
  // turn that runs and its agent.
  const end = Effect.gen(function* () {
    yield* Deferred.succeed(closed, undefined);
    yield* turns.withPermits(1)(
      Effect.gen(function* () {
        if (live !== undefined) {
          yield* endSession(live, "The deck closed.");
        }
        yield* FiberSet.clear(toolCalls);
        yield* FiberHandle.clear(turnFiber);
        yield* FiberHandle.clear(stopWatch);
      })
    );
  });
  yield* Effect.addFinalizer(() => end);

  const toolCall = Effect.fnUntraced(function* <A, E, R>(sessionKey: string, call: Effect.Effect<A, E, R>) {
    // Admitted and registered under the admission lock, so Stop and the turn's end run wholly
    // before or after it.
    const fiber = yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const session = live;
        const current = yield* SubscriptionRef.get(state);
        if (
          session === undefined ||
          Option.getOrUndefined(session.mcpSession) !== sessionKey ||
          (yield* Deferred.isDone(closed))
        ) {
          return yield* new ToolCallRefused({ message: "The agent session that made this call has ended." });
        }
        if (current.turn === "Stopping") {
          return yield* new ToolCallRefused({ message: "The user stopped the turn." });
        }
        // A call belongs to the turn whose prompt went out; before then and once it ended, Source
        // may be editable, or the turn's snapshot not taken.
        if (current.turn !== "Running" || !admitting) {
          return yield* new ToolCallRefused({
            message: "No turn is running, so the agent may not use the deck tools.",
          });
        }
        return yield* FiberSet.run(toolCalls, call);
      })
    );
    return yield* Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
  });

  return {
    state: SubscriptionRef.changes(state).pipe(
      Stream.groupedWithin(1000, REPORT_WINDOW),
      Stream.map((reports) => reports[reports.length - 1]),
      Stream.filter((report) => report !== undefined),
      Stream.interruptWhen(Deferred.await(closed))
    ),
    prompt,
    stop,
    decide,
    changes,
    end,
    toolCall,
  } satisfies AgentChat;
});

/**
 * Put the session in the asking mode and return the mode the agent reports. An ACP v2 agent sets
 * its mode through the config option in the `mode` category; an ACP v1 agent that lists modes
 * instead takes `session/set_mode`. Fails unless the agent reports the asking mode afterwards.
 */
const askingMode = Effect.fn("AgentChat.askingMode")(function* (
  acp: AcpClient.AcpClient["Service"],
  sessionId: string,
  created: Acp.NewSessionResponse
) {
  const option = created.configOptions?.find(
    (candidate) => candidate.category === "mode" && candidate.type === "select"
  );
  if (option !== undefined) {
    const { configOptions } = yield* acp.agent.setSessionConfigOption({
      sessionId,
      configId: option.id,
      value: ASK_MODE,
    });
    const now = configOptions.find((candidate) => candidate.id === option.id);
    if (now?.type === "select" && now.currentValue === ASK_MODE) {
      return ASK_MODE;
    }
    return yield* new AgentStartFailed({
      message: `The agent kept its mode at ${now?.type === "select" ? now.currentValue : "an unknown value"}.`,
    });
  }
  if (created.modes?.availableModes.some((mode) => mode.id === ASK_MODE) === true) {
    yield* acp.agent.setSessionMode({ sessionId, modeId: ASK_MODE });
    return ASK_MODE;
  }
  return yield* new AgentStartFailed({ message: `The agent offers no "${ASK_MODE}" permission mode.` });
});

/**
 * The ACP logger: it notes the generation from the first response the agent sends, which answers
 * `initialize` (an ACP v2 response carries `info`, as effect-acp decides), and appends each message
 * to the protocol log when one is set, as `incoming` or `outgoing`, a tab and the JSON line. Each of
 * `secrets` is written as `<mcp-token>`.
 */
function protocolLogger(
  protocolLog: Option.Option<string>,
  generation: { value: Option.Option<1 | 2> },
  fs: FileSystem.FileSystem,
  secrets: ReadonlyArray<string>
) {
  return (event: AcpProtocolLogEvent): Effect.Effect<void> => {
    const payload = decodeLine(event.payload);
    if (event.stage !== "raw" || Option.isNone(payload)) {
      return Effect.void;
    }
    const line = secrets.reduce(
      (text, secret) => text.replaceAll(secret, "<mcp-token>"),
      payload.value.trim()
    );
    return Effect.gen(function* () {
      if (Option.isNone(generation.value) && event.direction === "incoming") {
        const response = decodeResponse(line);
        if (Option.isSome(response)) {
          generation.value = Option.some("info" in response.value.result ? 2 : 1);
        }
      }
      if (Option.isSome(protocolLog)) {
        const record = `${event.direction}\t${line}\n`;
        yield* fs.writeFileString(protocolLog.value, record, { flag: "a" }).pipe(Effect.ignore);
      }
    });
  };
}

const decodeLine = Schema.decodeUnknownOption(Schema.String);

/** The relay as `session/new` names it: a stdio MCP server whose environment holds the token. */
function relayServer(relay: McpRelay, minted: MintedToken, mcpLog: Option.Option<string>): Acp.McpServer {
  const env = {
    ...relay.env,
    ...Option.match(mcpLog, { onNone: () => ({}), onSome: (file) => ({ [RELAY_LOG_VARIABLE]: file }) }),
    [RELAY_ENDPOINT_VARIABLE]: relay.endpoint,
    [RELAY_AUTHORIZATION_VARIABLE]: `Bearer ${Redacted.value(minted.token)}`,
  };
  return {
    name: MCP_SERVER_NAME,
    command: relay.command,
    args: [...relay.args],
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
  };
}

const decodeResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ result: Schema.Record(Schema.String, Schema.Unknown) }))
);
