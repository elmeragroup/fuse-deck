/**
 * The MCP relay's entry. An agent session starts it as its stdio MCP server, on the backend's own
 * Node with `ELECTRON_RUN_AS_NODE=1`; it forwards each message to the backend's `/mcp` with the
 * session's token. It imports only Effect, Node built-ins and the relay, no Vite and no deck-core,
 * so it starts at once. Diagnostics go to stderr; stdout carries only MCP messages.
 */

import * as Effect from "effect/Effect";
import { appendFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import { runAcpMcpStdioBridge } from "./AcpMcpStdioBridge.ts";
import {
  RELAY_AUTHORIZATION_VARIABLE,
  RELAY_ENDPOINT_VARIABLE,
  RELAY_LOG_VARIABLE,
} from "./relay-environment.ts";

const endpoint = process.env[RELAY_ENDPOINT_VARIABLE];
const authorization = process.env[RELAY_AUTHORIZATION_VARIABLE];
const log = process.env[RELAY_LOG_VARIABLE];

/** Append each complete line of `text` to the log, marked with its direction. */
function logLines(direction: "incoming" | "outgoing", text: string): void {
  if (log === undefined) {
    return;
  }
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      appendFileSync(log, `${direction}\t${line}\n`);
    }
  }
}

if (endpoint === undefined || authorization === undefined) {
  process.stderr.write(`The relay needs ${RELAY_ENDPOINT_VARIABLE} and ${RELAY_AUTHORIZATION_VARIABLE}.\n`);
  process.exitCode = 2;
} else {
  // The agent's messages, as the relay reads them; each is one line, so each chunk logs whole lines
  // once the stream has split them.
  const input = new PassThrough();
  let pending = "";
  process.stdin.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    const end = pending.lastIndexOf("\n");
    if (end !== -1) {
      logLines("outgoing", pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
    input.write(chunk);
  });
  process.stdin.on("end", () => {
    logLines("outgoing", pending);
    input.end();
  });
  await Effect.runPromise(
    runAcpMcpStdioBridge({
      endpoint,
      authorization,
      input,
      output: {
        write: (chunk: string) => {
          logLines("incoming", chunk);
          return process.stdout.write(chunk);
        },
      },
    })
  );
}
