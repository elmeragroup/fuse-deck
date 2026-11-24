import * as Schema from "effect/Schema";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** The built relay, which turbo builds before the tests. */
const RELAY = fileURLToPath(new URL("../dist/relay/bin.mjs", import.meta.url));

/** The Effect package the studio installs, the one package the relay may load. */
const EFFECT_PACKAGE = path.dirname(createRequire(import.meta.url).resolve("effect/package.json"));

/** One request the mock backend received. */
type Received = { readonly headers: IncomingHttpHeaders; readonly body: string };

/** How the mock backend answers one request. */
type Answer = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
};

/** A mock `/mcp`: it records each request and answers with `answer`. */
async function mockBackend(answer: (body: string, index: number) => Answer) {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const index = received.length;
      received.push({ headers: request.headers, body });
      const reply = answer(body, index);
      response.writeHead(reply.status, reply.headers ?? {});
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(server.address()).port;
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${String(port)}/mcp`, received };
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

/** The relay, started as an agent starts it, with a PATH that finds nothing. */
function startRelay(env: Readonly<Record<string, string>>, entry = RELAY) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [entry], {
    env: { PATH: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      lines.push(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
    }
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
  });
  /** Resolve once stdout has carried `count` lines. */
  const linesAfter = (count: number) =>
    new Promise<readonly string[]>((resolve) => {
      const check = () => {
        if (lines.length >= count) {
          child.stdout.off("data", check);
          resolve(lines.slice(0, count));
        }
      };
      child.stdout.on("data", check);
      check();
    });
  return {
    send: (message: { readonly [key: string]: Schema.Json }) =>
      child.stdin.write(`${JSON.stringify(message)}\n`),
    linesAfter,
    end: () => {
      child.stdin.end();
      return exited;
    },
    stray: () => buffered,
  };
}

const Message = Schema.fromJsonString(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String, Schema.Null])),
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ code: Schema.Finite, message: Schema.String })),
  })
);

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "agent", version: "1" } },
};

describe("the MCP relay", () => {
  it("forwards each message with the token, keeps the session and the revision, and relays JSON and SSE answers", async () => {
    const backend = await mockBackend((body, index) => {
      if (index === 0) {
        return {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }),
        };
      }
      if (body.includes('"notifications/initialized"')) {
        return { status: 202, body: "" };
      }
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })}\n\n`,
      };
    });
    const relay = startRelay({
      FUSE_DECK_MCP_ENDPOINT: backend.endpoint,
      FUSE_DECK_MCP_AUTHORIZATION: "Bearer the-session-token",
    });
    relay.send(INITIALIZE);
    await relay.linesAfter(1);
    relay.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    relay.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const lines = await relay.linesAfter(2);
    expect(await relay.end()).toBe(0);

    expect(lines.map((line) => Schema.decodeSync(Message)(line))).toEqual([
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
    expect(relay.stray()).toBe("");
    expect(backend.received.map((request) => request.headers.authorization)).toEqual([
      "Bearer the-session-token",
      "Bearer the-session-token",
      "Bearer the-session-token",
    ]);
    const later = backend.received.slice(1);
    expect(later.map((request) => request.headers["mcp-session-id"])).toEqual(["session-1", "session-1"]);
    expect(later.map((request) => request.headers["mcp-protocol-version"])).toEqual([
      "2025-11-25",
      "2025-11-25",
    ]);
    expect(backend.received.every((request) => request.headers.origin === undefined)).toBe(true);
  });

  it("answers a request the endpoint refuses with a JSON-RPC error for that request", async () => {
    const backend = await mockBackend(() => ({ status: 401, body: "" }));
    const relay = startRelay({
      FUSE_DECK_MCP_ENDPOINT: backend.endpoint,
      FUSE_DECK_MCP_AUTHORIZATION: "Bearer revoked",
    });
    relay.send(INITIALIZE);
    const [line = ""] = await relay.linesAfter(1);
    expect(await relay.end()).toBe(0);
    expect(Schema.decodeSync(Message)(line)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "The studio's MCP endpoint responded with HTTP 401." },
    });
  });

  it("runs from a directory where only Effect resolves, so it loads no Vite and no deck-core", async () => {
    // A copy of the entry beside a node_modules that holds Effect alone: an import of anything
    // else, such as Vite or a deck-core dependency, fails before the relay answers.
    const directory = await mkdtemp(path.join(tmpdir(), "fuse-deck-relay-"));
    try {
      await mkdir(path.join(directory, "node_modules"));
      await symlink(EFFECT_PACKAGE, path.join(directory, "node_modules", "effect"));
      await copyFile(RELAY, path.join(directory, "bin.mjs"));
      const backend = await mockBackend(() => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }),
      }));
      const relay = startRelay(
        { FUSE_DECK_MCP_ENDPOINT: backend.endpoint, FUSE_DECK_MCP_AUTHORIZATION: "Bearer token" },
        path.join(directory, "bin.mjs")
      );
      relay.send(INITIALIZE);
      const [line = ""] = await relay.linesAfter(1);
      expect(await relay.end()).toBe(0);
      expect(Schema.decodeSync(Message)(line).result).toEqual({ protocolVersion: "2025-11-25" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("logs each message it relays when asked, and never the token", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fuse-deck-relay-log-"));
    try {
      const log = path.join(directory, "mcp.log");
      const answer = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } });
      const backend = await mockBackend(() => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: answer,
      }));
      const relay = startRelay({
        FUSE_DECK_MCP_ENDPOINT: backend.endpoint,
        FUSE_DECK_MCP_AUTHORIZATION: "Bearer secret-token",
        FUSE_DECK_MCP_LOG: log,
      });
      relay.send(INITIALIZE);
      await relay.linesAfter(1);
      expect(await relay.end()).toBe(0);
      expect(await readFile(log, "utf8")).toBe(
        `outgoing\t${JSON.stringify(INITIALIZE)}\nincoming\t${answer}\n`
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exits 2 and writes nothing to stdout without its endpoint and token", async () => {
    const relay = startRelay({});
    expect(await relay.end()).toBe(2);
    expect(await relay.linesAfter(0)).toEqual([]);
    expect(relay.stray()).toBe("");
  });
});
