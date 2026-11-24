import * as Schema from "effect/Schema";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** The built bin, the file the packed tarball ships. Turbo builds it before this suite runs. */
const BIN = fileURLToPath(new URL("../dist/bin.mjs", import.meta.url));

/** One JSON-RPC response: every line `mcp` writes to stdout must decode as one. */
const Response = Schema.fromJsonString(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Finite,
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Unknown),
  })
);

const Initialized = Schema.Struct({
  protocolVersion: Schema.String,
  serverInfo: Schema.Struct({ name: Schema.String }),
});

const ToolList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) });

const ToolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
});

/** A request's parameters, a JSON object. */
type RequestParams = { readonly [key: string]: string | RequestParams | Readonly<Record<string, never>> };

/** A `fuse-deck mcp` process, driven one request at a time. */
type McpProcess = {
  /** Send a request and decode its result with `schema`, once the answer arrives. */
  readonly request: <S extends Schema.Decoder<unknown>>(
    schema: S,
    method: string,
    params: RequestParams
  ) => Promise<S["Type"]>;
  readonly notify: (method: string) => void;
  /** Every line stdout carried that was not a response to a request this test sent. */
  readonly stray: () => readonly string[];
  /** End stdin and resolve with the exit code. */
  readonly close: () => Promise<number | null>;
};

function startMcp(cwd: string): McpProcess {
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing. Run \`pnpm turbo run build --filter=@elmeragroup/fuse-deck\` first.`);
  }
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [BIN, "mcp"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
  });
  const pending = new Map<number, (response: typeof Response.Type) => void>();
  const stray: string[] = [];
  let buffered = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const decoded = Schema.decodeOption(Response)(line);
      const resolve = decoded._tag === "Some" ? pending.get(decoded.value.id) : undefined;
      if (decoded._tag === "Some" && resolve !== undefined) {
        pending.delete(decoded.value.id);
        resolve(decoded.value);
      } else {
        stray.push(line);
      }
    }
  });
  let nextId = 1;
  return {
    request: (schema, method, params) => {
      const id = nextId++;
      const answered = new Promise<typeof Response.Type>((resolve, reject) => {
        pending.set(id, resolve);
        void exited.then(() => {
          reject(new Error(`mcp exited before answering ${method}: ${stderr}`));
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return answered.then((response) => {
        if (response.error !== undefined) {
          throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
        }
        return Schema.decodeUnknownSync(schema)(response.result);
      });
    },
    notify: (method) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    stray: () => (buffered === "" ? stray : [...stray, buffered]),
    close: () => {
      child.stdin.end();
      return exited;
    },
  };
}

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "fuse-deck-mcp-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("fuse-deck mcp", () => {
  it("serves the six deck tools over stdio for the deck it starts in, writes only MCP to stdout, and exits when stdin ends", async () => {
    const created = spawnSync(process.execPath, [BIN, "create", "talk", "--json"], {
      cwd: workspace,
      encoding: "utf8",
    });
    expect(created.status, created.stderr).toBe(0);
    const deck = path.join(workspace, "talk");
    // Started in a subdirectory, it finds the deck above, as every command does.
    const mcp = startMcp(path.join(deck, "slides"));

    const initialized = await mcp.request(Initialized, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "process-test", version: "1.0.0" },
    });
    expect(initialized).toEqual({ protocolVersion: "2025-06-18", serverInfo: { name: "fuse-deck" } });
    mcp.notify("notifications/initialized");

    const { tools } = await mcp.request(ToolList, "tools/list", {});
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "check",
      "describe",
      "slides_add",
      "slides_list",
      "slides_move",
      "slides_remove",
    ]);

    const added = await mcp.request(ToolResult, "tools/call", {
      name: "slides_add",
      arguments: { id: "agenda", title: "Agenda" },
    });
    expect(added).toEqual({
      isError: false,
      structuredContent: {
        _tag: "SlideAdded",
        id: "agenda",
        path: "slides/agenda.mdx",
        order: ["cover", "agenda"],
      },
    });
    expect(await readFile(path.join(deck, "slides", "agenda.mdx"), "utf8")).toBe("# Agenda\n");

    const listed = await mcp.request(ToolResult, "tools/call", { name: "slides_list", arguments: {} });
    expect(listed.isError).toBe(false);
    expect(listed.structuredContent).toMatchObject({
      _tag: "SlideList",
      slides: [
        { id: "cover" },
        { id: "agenda", path: "slides/agenda.mdx", title: "Agenda", layout: "content" },
      ],
    });

    // `check` runs Vite and the theme, whose logs must stay off stdout.
    const checked = await mcp.request(ToolResult, "tools/call", { name: "check", arguments: {} });
    expect(checked.structuredContent).toEqual({
      _tag: "DeckChecked",
      slides: 2,
      steps: 0,
      theme: "neutral-elma-private",
    });

    expect(await mcp.close()).toBe(0);
    expect(mcp.stray()).toEqual([]);
  });

  it("is in --help and in describe's commands", () => {
    const help = spawnSync(process.execPath, [BIN, "--help"], { cwd: workspace, encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(
      /^\s+mcp\s+Serve describe, slides list, add, move and remove, and check as MCP tools/m
    );
    const described = spawnSync(process.execPath, [BIN, "describe", "--json"], {
      cwd: workspace,
      encoding: "utf8",
    });
    const vocabulary = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({ commands: Schema.Array(Schema.Struct({ usage: Schema.String })) })
      )
    )(described.stdout);
    expect(vocabulary.commands.map((command) => command.usage)).toContain("fuse-deck mcp");
  });

  it("outside a deck, fails with DeckNotFound and exit 1 before it serves", () => {
    const run = spawnSync(process.execPath, [BIN, "mcp", "--json"], {
      cwd: workspace,
      encoding: "utf8",
      input: "",
    });
    expect(run.status).toBe(1);
    expect(
      Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })))(run.stdout)
    ).toEqual({
      _tag: "DeckNotFound",
    });
  });
});
