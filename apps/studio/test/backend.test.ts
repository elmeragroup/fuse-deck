import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SlideId } from "@elmeragroup/deck-core/deck/slide-id";

import { SESSION_PATH, SessionResponse } from "../src/contract/studio-launch.ts";
import { OpenRequestId } from "../src/contract/studio-rpc.ts";
import { startBackend } from "./backend.ts";
import type { Backend } from "./backend.ts";
import { DECK_A, writeDeck } from "./decks.ts";
import { connectRpc } from "./rpc-client.ts";

const ORIGIN = "fuse-deck-studio://app";

const decodeSession = Schema.decodeUnknownSync(Schema.fromJsonString(SessionResponse));
const decodeOrder = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ order: Schema.Array(Schema.String) }))
);
const slide = Schema.decodeSync(SlideId);

let workspace = "";
let backend: Backend | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "fuse-deck-studio-backend-"));
});

afterEach(async () => {
  await backend?.stop();
  backend = undefined;
  await rm(workspace, { recursive: true, force: true });
});

function exchange(url: string, bootstrap: string): Promise<Response> {
  return fetch(new URL(SESSION_PATH, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrap }),
  });
}

describe("the studio backend process", () => {
  it("listens on 127.0.0.1 and exits 0 when its parent closes stdin", async () => {
    backend = await startBackend(ORIGIN, workspace);
    expect(new URL(backend.url).hostname).toBe("127.0.0.1");
    backend.child.stdin.end();
    expect(await backend.exited).toBe(0);
  });

  it("trades the bootstrap credential for a bearer once", async () => {
    backend = await startBackend(ORIGIN, workspace);
    const wrong = await exchange(backend.url, "not-the-bootstrap");
    const first = await exchange(backend.url, backend.bootstrap);
    const second = await exchange(backend.url, backend.bootstrap);
    expect(wrong.status).toBe(401);
    expect(first.status).toBe(200);
    expect(decodeSession(await first.text()).bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.status).toBe(401);
  });

  it("refuses the bootstrap exchange from an origin other than the renderer's", async () => {
    backend = await startBackend(ORIGIN, workspace);
    const response = await fetch(new URL(SESSION_PATH, backend.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ bootstrap: backend.bootstrap }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    // The refused request did not spend the credential.
    expect((await exchange(backend.url, backend.bootstrap)).status).toBe(200);
  });

  it("finishes a reorder waiting on the deck lock before it exits on SIGTERM", async () => {
    const deck = await writeDeck(path.join(workspace, "deck"), DECK_A);
    backend = await startBackend(ORIGIN, path.join(workspace, "user-data"));
    const running = backend;
    // Another edit holds the deck's lock, so the reorder waits inside the backend, admitted.
    const lock = path.join(deck, ".fuse-deck.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "the-test-holds-it" }));

    const exitedAfterRelease = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* connectRpc(running, ORIGIN);
        const opened = yield* client["deck.open"]({
          path: deck,
          requestId: OpenRequestId.make("backend-test"),
        });
        yield* client["slides.move"]({
          scopeId: opened.scopeId,
          id: slide("a-one"),
          position: { _tag: "After", anchor: slide("a-three") },
        }).pipe(Effect.ignore, Effect.forkScoped);
        yield* client["studio.state"]().pipe(
          Stream.filter((state) => state._tag === "Open" && state.admitted === 1),
          Stream.runHead
        );
        running.child.kill("SIGTERM");
        // The stop closes the socket, which ends the call's handler; the reorder itself goes on,
        // and the deck waits for it.
        const draining = yield* Effect.promise(() =>
          Promise.race([
            running.stderrMatches(/once its 1 admitted calls settle/).then(() => "draining"),
            running.exited.then(() => "exited"),
          ])
        );
        const aliveWhileHeld = draining === "draining" && running.child.exitCode === null;
        yield* Effect.promise(() => unlink(lock));
        const code = yield* Effect.promise(() => running.exited);
        return { aliveWhileHeld, code };
      }).pipe(Effect.scoped)
    );
    backend = undefined;

    expect(exitedAfterRelease.aliveWhileHeld).toBe(true);
    expect(decodeOrder(await readFile(path.join(deck, "deck.json"), "utf8")).order).toEqual([
      "a-two",
      "a-three",
      "a-one",
    ]);
    expect(exitedAfterRelease.code).not.toBeNull();
  });
});
