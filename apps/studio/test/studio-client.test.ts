/**
 * The renderer's client, run in Node against spawned backends. Node's `fetch` and `WebSocket` send
 * no Origin, so the test's globals add the renderer's, as the browser does.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SESSION_PATH, SessionResponse } from "../src/contract/studio-launch.ts";
import type { BackendConnection } from "../src/contract/studio-launch.ts";
import type { StudioHost } from "../src/renderer/host.ts";
import { startStudioClient } from "../src/renderer/state/studio-client.ts";
import type { StudioClient, StudioSnapshot } from "../src/renderer/state/studio-client.ts";
import { RECENT_DECKS_FILE } from "../src/server/recent-decks.ts";
import { startBackend } from "./backend.ts";
import type { Backend } from "./backend.ts";
import { DECK_A, DECK_B, writeDeck } from "./decks.ts";

const ORIGIN = "fuse-deck-studio://app";

const decodeSession = Schema.decodeUnknownSync(SessionResponse);

const NodeWebSocket = globalThis.WebSocket;
const nodeFetch = globalThis.fetch;

/** Every socket the client opened, in order. */
const sockets: WebSocket[] = [];

beforeAll(() => {
  // Undici's WebSocket takes headers in an init object, past the DOM's constructor signature.
  globalThis.WebSocket = new Proxy(NodeWebSocket, {
    construct(target, [url, protocols]: [string | URL, (string | string[])?]) {
      const socket: unknown = Reflect.construct(target, [
        url,
        { protocols: protocols ?? [], headers: { origin: ORIGIN } },
      ]);
      if (!(socket instanceof NodeWebSocket)) {
        throw new TypeError("Reflect.construct did not build a WebSocket.");
      }
      sockets.push(socket);
      return socket;
    },
  });
  globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", ORIGIN);
    return nodeFetch(input, { ...init, headers });
  };
});

afterAll(() => {
  globalThis.WebSocket = NodeWebSocket;
  globalThis.fetch = nodeFetch;
});

let workspace = "";
const backends: Backend[] = [];

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "fuse-deck-studio-client-"));
});

afterEach(async () => {
  for (const backend of backends.splice(0)) {
    backend.child.kill("SIGKILL");
    await backend.exited;
  }
  await rm(workspace, { recursive: true, force: true });
});

/** A backend, and the connection main would hand over for it. */
async function launch(
  userData: string
): Promise<{ readonly backend: Backend; readonly connection: BackendConnection }> {
  const backend = await startBackend(ORIGIN, userData);
  backends.push(backend);
  // Main trades the bootstrap credential with no Origin.
  const response = await nodeFetch(new URL(SESSION_PATH, backend.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrap: backend.bootstrap }),
  });
  return { backend, connection: { url: backend.url, bearer: decodeSession(await response.json()).bearer } };
}

/** Resolves with the first snapshot, from now on, that `matches`. */
function snapshotWhere(
  client: StudioClient,
  matches: (snapshot: StudioSnapshot) => boolean
): Promise<StudioSnapshot> {
  return new Promise((resolve) => {
    const check = () => {
      const snapshot = client.snapshot();
      if (matches(snapshot)) {
        stop();
        resolve(snapshot);
      }
    };
    const stop = client.subscribe(check);
    check();
  });
}

const studioOf = (snapshot: StudioSnapshot) =>
  snapshot.connection._tag === "Connected" ? snapshot.connection.studio : undefined;

describe("the studio client", () => {
  it("opens the deck the user switched to when the connection drops mid-open and the backend restarts", async () => {
    const deckA = await realpath(await writeDeck(path.join(workspace, "a"), DECK_A));
    const deckB = await realpath(await writeDeck(path.join(workspace, "b"), DECK_B));
    const first = await launch(path.join(workspace, "user-data-1"));
    let connection = first.connection;
    const host: StudioHost = {
      connection: Effect.suspend(() => Effect.succeed(connection)),
      pickDeck: Effect.succeedNone,
      initialDeck: Effect.succeedSome(deckA),
    };
    const client = startStudioClient(host);
    await snapshotWhere(client, (snapshot) => {
      const studio = studioOf(snapshot);
      return studio?._tag === "Open" && studio.deck.root === deckA;
    });

    // The backend records a deck in the recent decks before it reports it open. A pipe in place of
    // that file holds B's open there, in Opening, until the backend goes away.
    const recent = path.join(workspace, "user-data-1", RECENT_DECKS_FILE);
    await rm(recent, { force: true });
    expect(spawnSync("mkfifo", [recent]).status).toBe(0);
    client.openDeck(deckB);
    await snapshotWhere(client, (snapshot) => studioOf(snapshot)?._tag === "Opening");

    // The connection drops; the next session finds B still opening.
    const sessions = sockets.length;
    sockets.at(-1)?.close();
    await snapshotWhere(client, (snapshot) => snapshot.connection._tag === "Reconnecting");
    await snapshotWhere(
      client,
      (snapshot) => sockets.length > sessions && studioOf(snapshot)?._tag === "Opening"
    );

    // Then the backend restarts, without B and without its open request.
    first.backend.child.kill("SIGKILL");
    await first.backend.exited;
    const second = await launch(path.join(workspace, "user-data-2"));
    connection = second.connection;
    // A client that dropped the request leaves the new backend empty, and this wait runs into the
    // test's timeout.
    const opened = await snapshotWhere(client, (snapshot) => {
      const studio = studioOf(snapshot);
      return studio?._tag === "Open" && sockets.length > sessions + 1;
    });
    const studio = studioOf(opened);
    expect(studio?._tag === "Open" ? studio.deck.root : undefined).toBe(deckB);
  });
});
