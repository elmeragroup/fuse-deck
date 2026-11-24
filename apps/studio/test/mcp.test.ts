import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatState } from "../src/contract/agent-chat.ts";
import { DECK_PATH, SESSION_PATH, SessionResponse, TICKET_PATH } from "../src/contract/studio-launch.ts";
import { OpenRequestId } from "../src/contract/studio-rpc.ts";
import type { ScopeId } from "../src/contract/studio-rpc.ts";
import { writeMockSettings } from "./agent.ts";
import type { MockAgentOptions } from "./agent.ts";
import { startBackend } from "./backend.ts";
import type { Backend } from "./backend.ts";
import { DECK_A, DECK_B, writeDeck } from "./decks.ts";
import { connectRpc } from "./rpc-client.ts";

const ORIGIN = "fuse-deck-studio://app";

/** A lock record naming this test's own process, which is alive, so no edit takes it over. */
const LIVE_LOCK = JSON.stringify({ pid: process.pid, token: "the-test-holds-it" });

let workspace = "";
let backend: Backend | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "fuse-deck-studio-mcp-"));
});

afterEach(async () => {
  await backend?.stop();
  backend = undefined;
  await rm(workspace, { recursive: true, force: true });
});

/** An MCP server entry the mock agent logged from `session/new`. */
const LoggedServer = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("stdio"),
    name: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    env: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  })
);

/** The endpoint and `Authorization` value of one agent session's relay. */
type SessionCredential = { readonly endpoint: string; readonly authorization: string };

/** Each session's relay credential, in the order the sessions opened, from the agent's log. */
async function credentials(log: string): Promise<ReadonlyArray<SessionCredential>> {
  const text = existsSync(log) ? await readFile(log, "utf8") : "";
  return text
    .split("\n")
    .filter((line) => line.startsWith("mcp-server "))
    .map((line) => {
      const server = Schema.decodeSync(LoggedServer)(line.slice("mcp-server ".length));
      const env = new Map(server.env.map(({ name, value }) => [name, value]));
      return {
        endpoint: env.get("FUSE_DECK_MCP_ENDPOINT") ?? "",
        authorization: env.get("FUSE_DECK_MCP_AUTHORIZATION") ?? "",
      };
    });
}

/** Wait until the agent's log names `count` sessions' relays. */
async function waitForCredentials(log: string, count: number): Promise<ReadonlyArray<SessionCredential>> {
  for (;;) {
    const found = await credentials(log);
    if (found.length >= count) {
      return found;
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** A JSON-RPC message, or a tool's arguments: a JSON object. */
type JsonRpcMessage = { readonly [key: string]: Schema.Json };

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
} satisfies JsonRpcMessage;

/** POST one JSON-RPC message to `/mcp` with `headers`, as the relay posts. */
function post(
  endpoint: string,
  headers: Readonly<Record<string, string>>,
  body: JsonRpcMessage
): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const ToolCallResponse = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optionalKey(Schema.Boolean),
      structuredContent: Schema.optionalKey(Schema.Unknown),
    }),
  })
);

/** Initialize an MCP session with `credential`, call `tool`, and return its result. */
async function callTool(credential: SessionCredential, tool: string, args: JsonRpcMessage) {
  const auth = { authorization: credential.authorization };
  const initialized = await post(credential.endpoint, auth, INITIALIZE);
  expect(initialized.status).toBe(200);
  const session = { ...auth, "mcp-session-id": initialized.headers.get("mcp-session-id") ?? "" };
  await initialized.text();
  await (
    await post(credential.endpoint, session, { jsonrpc: "2.0", method: "notifications/initialized" })
  ).text();
  const called = await post(credential.endpoint, session, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
  return Schema.decodeSync(ToolCallResponse)(await called.text()).result;
}

/** The status `/mcp` answers an initialize with `credential`. */
async function initializeStatus(credential: SessionCredential): Promise<number> {
  const response = await post(credential.endpoint, { authorization: credential.authorization }, INITIALIZE);
  await response.text();
  return response.status;
}

/** Trade the backend's bootstrap credential for its session bearer. */
async function sessionBearer(running: Backend): Promise<string> {
  const response = await fetch(new URL(SESSION_PATH, running.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrap: running.bootstrap }),
  });
  return Schema.decodeUnknownSync(SessionResponse)(await response.json()).bearer;
}

/** Two decks, a backend whose agent is the mock with `options`, and the agent's log. */
async function setup(options: MockAgentOptions = {}) {
  const deckA = await writeDeck(path.join(workspace, "a"), DECK_A);
  const deckB = await writeDeck(path.join(workspace, "b"), DECK_B);
  const userData = path.join(workspace, "user-data");
  const log = path.join(workspace, "agent.log");
  await Effect.runPromise(
    writeMockSettings(userData, { ...options, log }).pipe(Effect.provide(NodeServices.layer))
  );
  backend = await startBackend(ORIGIN, userData);
  return { deckA, deckB, log, running: backend, bearer: await sessionBearer(backend) };
}

type Client = Effect.Success<ReturnType<typeof connectRpc>>;

/** The first chat state of `scopeId` that `matches` accepts. */
function chatState(client: Client, scopeId: ScopeId, matches: (state: ChatState) => boolean) {
  return client["agent.chat"]({ scopeId }).pipe(
    Stream.filter(matches),
    Stream.runHead,
    Effect.map(Option.getOrThrow)
  );
}

/**
 * Send `text` to the agent of `scopeId` and wait for the turn to end: the chat is idle, and the
 * prompt's own user entry, the first one after the entries the chat held before, has an agent
 * message or a notice after it. The state stream batches changes, so a count of entries alone can
 * match a state from before the reply.
 */
const promptAndWait = Effect.fnUntraced(function* (client: Client, scopeId: ScopeId, text: string) {
  const before = (yield* chatState(client, scopeId, () => true)).entries.length;
  yield* client["agent.prompt"]({ scopeId, input: { text, view: null } });
  return yield* chatState(client, scopeId, (state) => {
    const ours = state.entries.findIndex(
      (entry, index) => index >= before && entry._tag === "User" && entry.text === text
    );
    return (
      state.turn === "Idle" &&
      ours !== -1 &&
      state.entries.slice(ours + 1).some((entry) => entry._tag === "Agent" || entry._tag === "Notice")
    );
  });
});

/**
 * The text of the agent's last message. A turn that ended without one fails with the turn's
 * notices, so a test says why instead of failing to parse an empty reply.
 */
function lastReply(state: ChatState): string {
  const reply = state.entries.findLast((entry) => entry._tag === "Agent");
  if (reply === undefined) {
    const notices = state.entries.flatMap((entry) => (entry._tag === "Notice" ? [entry.text] : []));
    throw new Error(`The turn ended without a reply. Notices: ${notices.join(" | ") || "none"}`);
  }
  return reply.text;
}

const Reply = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({ isError: Schema.Boolean, structuredContent: Schema.optionalKey(Schema.Unknown) }),
  })
);

/** Run `body` with an RPC client of the backend, connected with `bearer`. */
function withClient<A, E>(
  running: Backend,
  bearer: string,
  body: (client: Client) => Effect.Effect<A, E, Scope.Scope>
): Promise<A> {
  return Effect.runPromise(connectRpc(running, ORIGIN, bearer).pipe(Effect.flatMap(body), Effect.scoped));
}

const newRequestId = () => OpenRequestId.make(crypto.randomUUID());

describe("the studio's deck tools at /mcp", () => {
  it("serves an agent session the deck tools through the relay session/new names", async () => {
    const { deckA, running, bearer } = await setup();
    const replies = await withClient(running, bearer, (client) =>
      Effect.gen(function* () {
        const a = yield* client["deck.open"]({ path: deckA, requestId: newRequestId() });
        const added = yield* promptAndWait(
          client,
          a.scopeId,
          'mcp slides_add {"id":"agenda","title":"Agenda"}'
        );
        const described = yield* promptAndWait(client, a.scopeId, "mcp describe {}");
        return { added: lastReply(added), described: lastReply(described) };
      })
    );
    expect(Schema.decodeSync(Reply)(replies.added).result).toEqual({
      isError: false,
      structuredContent: {
        _tag: "SlideAdded",
        id: "agenda",
        path: "slides/agenda.mdx",
        order: ["a-one", "a-two", "a-three", "agenda"],
      },
    });
    expect(await readFile(path.join(deckA, "slides", "agenda.mdx"), "utf8")).toBe("# Agenda\n");
    const skill = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          result: Schema.Struct({ structuredContent: Schema.Struct({ skill: Schema.String }) }),
        })
      )
    )(replies.described).result.structuredContent.skill;
    expect(existsSync(skill)).toBe(true);
    expect(path.basename(skill)).toBe("SKILL.md");
  });

  it("moves the preview with view_go through the renderer and reads it back with view_current", async () => {
    const { deckA, running, bearer } = await setup();
    const replies = await withClient(running, bearer, (client) =>
      Effect.gen(function* () {
        const a = yield* client["deck.open"]({ path: deckA, requestId: newRequestId() });
        const before = yield* promptAndWait(client, a.scopeId, "mcp view_current {}");
        // The renderer: it shows each slide the agent asks for, and reports what the deck committed.
        yield* client["view.requests"]({ scopeId: a.scopeId }).pipe(
          Stream.runForEach((request) =>
            request._tag === "Go"
              ? client["view.report"]({
                  scopeId: a.scopeId,
                  position: { slideId: request.slideId, step: request.step },
                  requestId: request.requestId,
                })
              : Effect.void
          ),
          Effect.forkScoped
        );
        const went = yield* promptAndWait(client, a.scopeId, 'mcp view_go {"id":"a-two","step":1}');
        const now = yield* promptAndWait(client, a.scopeId, "mcp view_current {}");
        const unknown = yield* promptAndWait(client, a.scopeId, 'mcp view_go {"id":"nowhere"}');
        return [before, went, now, unknown].map((state) => Schema.decodeSync(Reply)(lastReply(state)).result);
      })
    );
    const [before, went, now, unknown] = replies;
    expect(before?.isError).toBe(true);
    expect(went).toEqual({
      isError: false,
      structuredContent: { _tag: "ViewPosition", slideId: "a-two", step: 1 },
    });
    expect(now).toEqual({
      isError: false,
      structuredContent: { _tag: "ViewPosition", slideId: "a-two", step: 1 },
    });
    expect(unknown?.isError).toBe(true);
  });

  it("answers 403 to any request with an Origin, and 401 without the session's token", async () => {
    const { deckA, log, running, bearer } = await setup();
    await withClient(running, bearer, (client) =>
      Effect.gen(function* () {
        const a = yield* client["deck.open"]({ path: deckA, requestId: newRequestId() });
        yield* promptAndWait(client, a.scopeId, "stream");
      })
    );
    // The agent logs its relay as session/new reaches it; wait for the line rather than read once.
    const [credential] = await waitForCredentials(log, 1);
    if (credential === undefined) {
      throw new Error("No agent session named its relay.");
    }
    expect(await initializeStatus(credential)).toBe(200);
    for (const method of ["GET", "POST", "DELETE"]) {
      for (const origin of [ORIGIN, "http://127.0.0.1:5173", "null"]) {
        const headers = {
          origin,
          authorization: credential.authorization,
          "content-type": "application/json",
        };
        const response = await fetch(
          credential.endpoint,
          method === "POST" ? { method, headers, body: JSON.stringify(INITIALIZE) } : { method, headers }
        );
        expect([method, origin, response.status]).toEqual([method, origin, 403]);
      }
    }
    // The renderer's bearer is not an MCP token, and no token is none.
    expect(await initializeStatus({ endpoint: credential.endpoint, authorization: `Bearer ${bearer}` })).toBe(
      401
    );
    expect(await initializeStatus({ endpoint: credential.endpoint, authorization: "" })).toBe(401);
    // The MCP token opens nothing but /mcp.
    const ticket = await fetch(new URL(TICKET_PATH, running.url), {
      method: "POST",
      headers: { origin: ORIGIN, authorization: credential.authorization },
    });
    expect(ticket.status).toBe(401);
    const deck = await fetch(new URL(DECK_PATH, running.url), {
      headers: { authorization: credential.authorization },
    });
    expect(deck.status).toBe(401);
  });

  it("revokes a deck's token when the studio switches decks, and the next deck's token reaches only that deck", async () => {
    const { deckA, deckB, log, running, bearer } = await setup();
    await withClient(running, bearer, (client) =>
      Effect.gen(function* () {
        const a = yield* client["deck.open"]({ path: deckA, requestId: newRequestId() });
        yield* promptAndWait(client, a.scopeId, "stream");
        const b = yield* client["deck.open"]({ path: deckB, requestId: newRequestId() });
        yield* promptAndWait(client, b.scopeId, "stream");
      })
    );
    const [onA, onB] = await waitForCredentials(log, 2);
    if (onA === undefined || onB === undefined) {
      throw new Error("Two agent sessions should have named their relays.");
    }
    expect(await initializeStatus(onA)).toBe(401);
    const listed = await callTool(onB, "slides_list", {});
    expect(listed.structuredContent).toMatchObject({
      _tag: "SlideList",
      slides: [{ id: "b-one" }, { id: "b-two" }, { id: "b-three" }],
    });
  });

  it("ends a session's MCP transport sessions with its token, and no other token reaches them", async () => {
    const { deckA, deckB, log, running, bearer } = await setup();
    const transport = await withClient(running, bearer, (client) =>
      Effect.gen(function* () {
        const a = yield* client["deck.open"]({ path: deckA, requestId: newRequestId() });
        yield* promptAndWait(client, a.scopeId, "stream");
        const [onA] = yield* Effect.promise(() => waitForCredentials(log, 1));
        if (onA === undefined) {
          return yield* Effect.die("No agent session named its relay.");
        }
        const initialized = yield* Effect.promise(() =>
          post(onA.endpoint, { authorization: onA.authorization }, INITIALIZE)
        );
        yield* Effect.promise(() => initialized.text());
        const id = initialized.headers.get("mcp-session-id") ?? "";
        const b = yield* client["deck.open"]({ path: deckB, requestId: newRequestId() });
        yield* promptAndWait(client, b.scopeId, "stream");
        return id;
      })
    );
    const [, onB] = await waitForCredentials(log, 2);
    if (onB === undefined) {
      throw new Error("Two agent sessions should have named their relays.");
    }
    const reused = await post(
      onB.endpoint,
      { authorization: onB.authorization, "mcp-session-id": transport },
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }
    );
    await reused.text();
    expect({ transport: transport !== "", status: reused.status }).toEqual({ transport: true, status: 404 });
    // And the server ended it when the deck switch revoked its token.
    await running.stderrMatches(/Ended the MCP transport session of a revoked token\./);
  });

  it("revokes a session's token when its agent exits, and gives the next session its own", async () => {
    const { deckA, log, running, bearer } = await setup();
    await withClient(running, bearer, (client) =>
      Effect.gen(function* () {
        const a = yield* client["deck.open"]({ path: deckA, requestId: newRequestId() });
        yield* client["agent.prompt"]({ scopeId: a.scopeId, input: { text: "exit", view: null } });
        yield* chatState(
          client,
          a.scopeId,
          (state) => state.session._tag === "Ended" && state.turn === "Idle"
        );
        yield* promptAndWait(client, a.scopeId, "stream");
      })
    );
    const [first, second] = await waitForCredentials(log, 2);
    if (first === undefined || second === undefined) {
      throw new Error("Two agent sessions should have named their relays.");
    }
    expect(first.authorization).not.toBe(second.authorization);
    expect(await initializeStatus(first)).toBe(401);
    expect(await initializeStatus(second)).toBe(200);
  });

  it("keeps the token across Stop, so the next prompt's tools still work", async () => {
    const { deckA, log, running, bearer } = await setup();
    const reply = await withClient(running, bearer, (client) =>
      Effect.gen(function* () {
        const a = yield* client["deck.open"]({ path: deckA, requestId: newRequestId() });
        yield* client["agent.prompt"]({ scopeId: a.scopeId, input: { text: "wait", view: null } });
        yield* chatState(client, a.scopeId, (state) => state.turn === "Running");
        yield* client["agent.stop"]({ scopeId: a.scopeId });
        yield* chatState(client, a.scopeId, (state) => state.turn === "Idle");
        return lastReply(yield* promptAndWait(client, a.scopeId, "mcp slides_list {}"));
      })
    );
    // The agent logs its relay as session/new reaches it; wait for the line rather than read once.
    const [credential] = await waitForCredentials(log, 1);
    if (credential === undefined) {
      throw new Error("No agent session named its relay.");
    }
    expect(await initializeStatus(credential)).toBe(200);
    expect(Schema.decodeSync(Reply)(reply).result.isError).toBe(false);
  });

  it("cancels a deck tool call the turn admitted when the user stops it, so its edit never lands", async () => {
    const { deckA, running, bearer } = await setup();
    const lock = path.join(deckA, ".fuse-deck.lock");
    const outcome = await withClient(running, bearer, (client) =>
      Effect.gen(function* () {
        const a = yield* client["deck.open"]({ path: deckA, requestId: newRequestId() });
        // Another edit holds the deck's lock, so the agent's slides_add waits inside the backend.
        yield* Effect.promise(() => writeFile(lock, LIVE_LOCK));
        yield* client["agent.prompt"]({
          scopeId: a.scopeId,
          input: { text: 'mcp slides_add {"id":"late"}', view: null },
        });
        yield* client["studio.state"]().pipe(
          Stream.filter((state) => state._tag === "Open" && state.writing === 1),
          Stream.runHead
        );
        yield* client["agent.stop"]({ scopeId: a.scopeId });
        // Released at once: a call that Stop left running would now take the lock and add the slide.
        yield* Effect.promise(() => unlink(lock));
        const stopped = yield* chatState(client, a.scopeId, (state) => state.turn === "Idle");
        const settled = yield* client["studio.state"]().pipe(
          Stream.filter((state) => state._tag === "Open" && state.admitted === 0),
          Stream.runHead
        );
        return { stopped, settled };
      })
    );
    expect(outcome.stopped.turn).toBe("Idle");
    expect(Option.isSome(outcome.settled)).toBe(true);
    expect(existsSync(path.join(deckA, "slides", "late.mdx"))).toBe(false);
    const manifest = Schema.decodeSync(
      Schema.fromJsonString(Schema.Struct({ order: Schema.Array(Schema.String) }))
    )(await readFile(path.join(deckA, "deck.json"), "utf8"));
    expect(manifest.order).toEqual(["a-one", "a-two", "a-three"]);
  });

  it("revokes the token of a session stopped while it starts", async () => {
    const { deckA, log, running, bearer } = await setup({ slowSession: true });
    await withClient(running, bearer, (client) =>
      Effect.gen(function* () {
        const a = yield* client["deck.open"]({ path: deckA, requestId: newRequestId() });
        yield* client["agent.prompt"]({ scopeId: a.scopeId, input: { text: "stream", view: null } });
        yield* Effect.promise(() => waitForCredentials(log, 1));
        yield* client["agent.stop"]({ scopeId: a.scopeId });
        yield* chatState(client, a.scopeId, (state) => state.turn === "Idle");
      })
    );
    // The agent logs its relay as session/new reaches it; wait for the line rather than read once.
    const [credential] = await waitForCredentials(log, 1);
    if (credential === undefined) {
      throw new Error("No agent session named its relay.");
    }
    expect(await initializeStatus(credential)).toBe(401);
  });

  it("writes the token into the protocol log as a placeholder", async () => {
    const protocolLog = path.join(workspace, "acp.log");
    const { deckA, log, running, bearer } = await setup({ protocolLog });
    await withClient(running, bearer, (client) =>
      Effect.gen(function* () {
        const a = yield* client["deck.open"]({ path: deckA, requestId: newRequestId() });
        yield* promptAndWait(client, a.scopeId, "stream");
      })
    );
    // The agent logs its relay as session/new reaches it; wait for the line rather than read once.
    const [credential] = await waitForCredentials(log, 1);
    if (credential === undefined) {
      throw new Error("No agent session named its relay.");
    }
    const logged = await readFile(protocolLog, "utf8");
    expect(logged).toContain('"FUSE_DECK_MCP_AUTHORIZATION","value":"Bearer <mcp-token>"');
    expect(logged).not.toContain(credential.authorization.slice("Bearer ".length));
  });
});
