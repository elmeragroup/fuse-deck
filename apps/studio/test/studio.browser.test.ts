import * as Schema from "effect/Schema";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser, Frame, Page, WebSocketRoute } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_PATH,
  SessionResponse,
  SOCKET_PATH,
  TICKET_PATH,
  TicketResponse,
} from "../src/contract/studio-launch.ts";
import { startBackend } from "./backend.ts";
import type { Backend } from "./backend.ts";
import { DECK_A, DECK_B, writeDeck } from "./decks.ts";
import { serveRenderer } from "./renderer-server.ts";
import type { RendererServer } from "./renderer-server.ts";

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- only an interface merges into the DOM's Window
  interface Window {
    /** Each text the status line showed, in order, recorded by the init script in `openStudio`. */
    statusLog?: string[];
    /** Each slide row that became current, in order. */
    currentLog?: string[];
  }
}

const decodeSession = Schema.decodeUnknownSync(SessionResponse);
const decodeTicket = Schema.decodeUnknownSync(Schema.fromJsonString(TicketResponse));
const decodeOrder = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ order: Schema.Array(Schema.String) }))
);

let browser: Browser;
let renderer: RendererServer;
let workspace = "";
let deckA = "";
let deckB = "";
let backend: Backend;

beforeAll(async () => {
  browser = await chromium.launch();
  renderer = await serveRenderer();
});

afterAll(async () => {
  await browser.close();
  await renderer.close();
});

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "fuse-deck-studio-browser-"));
  deckA = await writeDeck(path.join(workspace, "a"), DECK_A);
  deckB = await writeDeck(path.join(workspace, "b"), DECK_B);
  backend = await startBackend(renderer.origin, path.join(workspace, "user-data"));
});

afterEach(async () => {
  await backend.stop();
  await rm(workspace, { recursive: true, force: true });
});

/** The bearer, traded for the bootstrap credential as Electron main trades it: with no Origin. */
async function exchangeBootstrap(): Promise<string> {
  const response = await fetch(new URL(SESSION_PATH, backend.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrap: backend.bootstrap }),
  });
  return decodeSession(await response.json()).bearer;
}

/**
 * The studio in a tab, with its credential in the fragment, and the init script that records the
 * status line and the current slide row as they change.
 */
async function openStudio(
  fragment: Record<string, string>,
  beforeLoad?: (page: Page) => Promise<void>
): Promise<Page> {
  const page = await browser.newPage();
  await beforeLoad?.(page);
  await page.addInitScript(() => {
    window.statusLog = [];
    window.currentLog = [];
    new MutationObserver(() => {
      const status = document.querySelector('[role="status"]')?.textContent ?? "";
      if (status !== "" && window.statusLog?.at(-1) !== status) {
        window.statusLog?.push(status);
      }
      // The row's last part is its title; the first is its number.
      const current = document.querySelector('[aria-current="true"] > :last-child')?.textContent ?? "";
      if (current !== "" && window.currentLog?.at(-1) !== current) {
        window.currentLog?.push(current);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await page.goto(
    `${renderer.origin}/#${new URLSearchParams({ backend: backend.url, ...fragment }).toString()}`
  );
  return page;
}

/** The preview frame of the deck titled `title`, once its slide `slide` shows. */
async function previewFrame(page: Page, title: string, slide: string): Promise<Frame> {
  const element = page.locator(`iframe[title="${title} preview"]`);
  await page.frameLocator(`iframe[title="${title} preview"]`).getByRole("region", { name: slide }).waitFor();
  const frame = await (await element.elementHandle()).contentFrame();
  if (frame === null) {
    throw new Error(`No frame for ${title}.`);
  }
  return frame;
}

/** Wait until the sidebar row of slide `title` is the current one. */
async function waitForCurrent(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: title }).and(page.locator('[aria-current="true"]')).waitFor();
}

async function readOrder(deck: string): Promise<ReadonlyArray<string>> {
  return decodeOrder(await readFile(path.join(deck, "deck.json"), "utf8")).order;
}

/** In the page: the status of a ticket request with this Authorization header, or the error a blocked one throws. */
function requestTicket(page: Page | Frame, authorization: string | null): Promise<number | string> {
  return page.evaluate(
    async ({ url, authorization }) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: authorization === null ? {} : { authorization },
        });
        return response.status;
      } catch (error) {
        return error instanceof Error ? error.name : String(error);
      }
    },
    { url: new URL(TICKET_PATH, backend.url).href, authorization }
  );
}

/** In the page: a fresh ticket for `bearer`. */
async function mintTicket(page: Page, bearer: string): Promise<string> {
  const body = await page.evaluate(
    async ({ url, bearer }) => {
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${bearer}` } });
      return response.text();
    },
    { url: new URL(TICKET_PATH, backend.url).href, bearer }
  );
  return decodeTicket(body).ticket;
}

/** In the page: whether a WebSocket with `ticket`, or with none, opens. */
function socketOpens(page: Page | Frame, ticket: string | null): Promise<boolean> {
  const url = new URL(SOCKET_PATH, backend.url);
  url.protocol = "ws:";
  if (ticket !== null) {
    url.searchParams.set("ticket", ticket);
  }
  return page.evaluate(
    (href) =>
      new Promise<boolean>((resolve) => {
        const socket = new WebSocket(href);
        socket.addEventListener("open", () => {
          socket.close();
          resolve(true);
        });
        socket.addEventListener("error", () => {
          resolve(false);
        });
      }),
    url.href
  );
}

/** One RPC socket between the page and the backend, as the test's proxy sees it. */
type ProxiedSocket = {
  /** The page's side. */
  readonly page: WebSocketRoute;
  /** The backend's side. */
  readonly server: WebSocketRoute;
};

/**
 * Proxy every RPC socket the page opens. `fromPage` and `fromServer` decide, for each message,
 * whether it passes; the first socket goes to `onSocket` too.
 */
async function proxySockets(
  page: Page,
  handlers: {
    readonly fromPage: (message: string, socket: ProxiedSocket) => boolean;
    readonly fromServer: (message: string, socket: ProxiedSocket) => boolean;
  }
): Promise<void> {
  await page.routeWebSocket(/\/ws\?ticket=/, (route) => {
    const socket = { page: route, server: route.connectToServer() };
    route.onMessage((message) => {
      if (handlers.fromPage(String(message), socket)) {
        socket.server.send(message);
      }
    });
    socket.server.onMessage((message) => {
      if (handlers.fromServer(String(message), socket)) {
        route.send(message);
      }
    });
  });
}

/** Whether an RPC message from the page asks to open the deck in `directory`. */
function opens(message: string, directory: string): boolean {
  return message.includes('"deck.open"') && message.includes(JSON.stringify(directory));
}

/** Answer the browser-tab harness's Open prompts with each of `decks` in turn. */
function answerPrompts(page: Page, decks: ReadonlyArray<string>): void {
  let next = 0;
  page.on("dialog", (dialog) => {
    void dialog.accept(decks[next] ?? "");
    next += 1;
  });
}

/** The text of the page's focused element: a slide row's number and title, or a button's label. */
function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.textContent ?? "");
}

describe("the studio renderer", () => {
  it("refuses a missing or bad bearer, a bad or spent ticket, and the deck's origin", async () => {
    const bearer = await exchangeBootstrap();
    const page = await openStudio({ bearer, deck: deckA });
    const deck = await previewFrame(page, "Deck A", "A one");

    expect(await requestTicket(page, null)).toBe(401);
    expect(await requestTicket(page, "Bearer not-the-bearer")).toBe(401);
    expect(await requestTicket(page, `Bearer ${bearer}`)).toBe(200);

    expect(await socketOpens(page, null)).toBe(false);
    expect(await socketOpens(page, "not-a-ticket")).toBe(false);
    const spent = await mintTicket(page, bearer);
    expect(await socketOpens(page, spent)).toBe(true);
    expect(await socketOpens(page, spent)).toBe(false);

    // The deck's own page, with the valid bearer and an unspent ticket, reaches neither route.
    const unspent = await mintTicket(page, bearer);
    expect(await requestTicket(deck, `Bearer ${bearer}`)).toBe("TypeError");
    expect(await socketOpens(deck, unspent)).toBe(false);
    const deckOrigin = new URL(deck.url()).origin;
    const preflight = await page.request.fetch(new URL(TICKET_PATH, backend.url).href, {
      method: "OPTIONS",
      headers: { origin: deckOrigin, "access-control-request-method": "POST" },
    });
    expect(preflight.status()).toBe(403);
    expect(preflight.headers()["access-control-allow-origin"]).toBeUndefined();
    const direct = await page.request.post(new URL(TICKET_PATH, backend.url).href, {
      headers: { origin: deckOrigin, authorization: `Bearer ${bearer}` },
    });
    expect(direct.status()).toBe(403);
    expect(direct.headers()["access-control-allow-origin"]).toBeUndefined();
    // The ticket the deck tried was still good: the origin check refused it before it was spent.
    expect(await socketOpens(page, unspent)).toBe(true);
  });

  it("moves the sidebar highlight as the preview's keyboard navigation moves the deck", async () => {
    const page = await openStudio({ bootstrap: backend.bootstrap, deck: deckA });
    const deck = await previewFrame(page, "Deck A", "A one");
    await waitForCurrent(page, "A one");
    await deck.getByRole("region", { name: "A one" }).click();
    await page.keyboard.press("ArrowRight");
    await waitForCurrent(page, "A two");
    await page.keyboard.press("End");
    await waitForCurrent(page, "A three");
    // And the other way: a row shows its slide in the preview.
    await page.getByRole("button", { name: "A one" }).click();
    await deck.getByRole("region", { name: "A one" }).waitFor();
    await waitForCurrent(page, "A one");
  });

  it("settles a reorder admitted for deck A before deck B opens, and takes no report from A for B", async () => {
    const page = await openStudio({ bootstrap: backend.bootstrap });
    // In the browser tab, Open asks for the deck's directory with a prompt.
    let nextDeck = deckA;
    page.on("dialog", (dialog) => {
      void dialog.accept(nextDeck);
    });
    await page.getByRole("heading", { name: "No deck open" }).waitFor();
    await page.getByRole("button", { name: "Open deck…" }).click();
    const frameA = await previewFrame(page, "Deck A", "A one");
    const scopeA = await page.locator('iframe[title="Deck A preview"]').getAttribute("data-scope-id");

    // Another edit holds deck A's lock, so the reorder waits inside the backend, admitted.
    const lock = path.join(deckA, ".fuse-deck.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "the-test-holds-it" }));
    await page.getByRole("button", { name: "A one" }).press("Alt+ArrowDown");
    await page.getByRole("status").getByText("Saving 1 change to Deck A…").waitFor();

    nextDeck = deckB;
    await page.getByRole("button", { name: "Open…" }).click();
    await page.getByRole("status").getByText("Finishing 1 change on Deck A before closing it…").waitFor();
    expect(frameA.isDetached()).toBe(false);
    await unlink(lock);

    const frameB = await previewFrame(page, "Deck B", "B one");
    await waitForCurrent(page, "B one");
    expect(await readOrder(deckA)).toEqual(["a-two", "a-one", "a-three"]);
    expect(await readOrder(deckB)).toEqual(DECK_B.slides);
    const statusLog = await page.evaluate(() => window.statusLog ?? []);
    const saving = statusLog.indexOf("Saving 1 change to Deck A…");
    const finishing = statusLog.indexOf("Finishing 1 change on Deck A before closing it…");
    const opening = statusLog.indexOf(`Opening ${deckB}…`);
    expect(saving).toBeGreaterThanOrEqual(0);
    expect(finishing).toBeGreaterThan(saving);
    expect(opening).toBeGreaterThan(finishing);

    // A report with A's scope from B's frame, and one with B's scope from outside the frame, are
    // both dropped; a report from B's frame with B's scope, posted after them, lands.
    const scopeB = await page.locator('iframe[title="Deck B preview"]').getAttribute("data-scope-id");
    expect(scopeA).not.toBe(scopeB);
    await frameB.evaluate((scopeId) => {
      parent.postMessage({ scopeId, slideId: "b-three", step: 0 }, "*");
    }, scopeA);
    await page.evaluate((scopeId) => {
      window.postMessage({ scopeId, slideId: "b-three", step: 0 }, "*");
    }, scopeB);
    await frameB.evaluate((scopeId) => {
      parent.postMessage({ scopeId, slideId: "b-two", step: 0 }, "*");
    }, scopeB);
    await waitForCurrent(page, "B two");
    const currentLog = await page.evaluate(() => window.currentLog ?? []);
    expect(currentLog.slice(currentLog.indexOf("B one"))).toEqual(["B one", "B two"]);
  });

  it("opens the deck the user switched to after a reconnect dropped the request", async () => {
    let dropped = false;
    const page = await openStudio({ bootstrap: backend.bootstrap, deck: deckA }, (page) =>
      proxySockets(page, {
        // The socket closes as the request to open B leaves, so the backend never sees it.
        fromPage: (message, socket) => {
          if (!dropped && opens(message, deckB)) {
            dropped = true;
            void socket.page.close();
            void socket.server.close();
            return false;
          }
          return true;
        },
        fromServer: () => true,
      })
    );
    answerPrompts(page, [deckB]);
    await previewFrame(page, "Deck A", "A one");
    await page.getByRole("button", { name: "Open…" }).click();
    // The next session finds A open and still opens B, which the user asked for last.
    await previewFrame(page, "Deck B", "B one");
    expect(dropped).toBe(true);
  });

  it("keeps a newer open request when an older one fails, across a reconnect", async () => {
    const missing = path.join(workspace, "no-deck-here");
    let sentMissing = false;
    let droppedB = false;
    const bDropped = Promise.withResolvers<void>();
    const held: string[] = [];
    const page = await openStudio({ bootstrap: backend.bootstrap }, (page) =>
      proxySockets(page, {
        fromPage: (message) => {
          sentMissing ||= opens(message, missing);
          if (!droppedB && opens(message, deckB)) {
            droppedB = true;
            bDropped.resolve();
            return false;
          }
          return true;
        },
        // The failure of the missing deck waits until B was asked for, then arrives, and then
        // the socket closes: B's request was lost with it.
        fromServer: (message, socket) => {
          if (message.includes("DeckOpenFailed") && held.length === 0) {
            held.push(message);
            void bDropped.promise.then(() => {
              socket.page.send(message);
              void socket.page.close();
              void socket.server.close();
            });
            return false;
          }
          return true;
        },
      })
    );
    answerPrompts(page, [missing, deckB]);
    await page.getByRole("heading", { name: "No deck open" }).waitFor();
    await page.getByRole("button", { name: "Open deck…" }).click();
    await expect.poll(() => sentMissing).toBe(true);
    await page.getByRole("button", { name: "Open deck…" }).click();
    await previewFrame(page, "Deck B", "B one");
    expect(held).toHaveLength(1);
  });

  it("updates the framed preview and the slide list after a slide is edited on disk", async () => {
    const page = await openStudio({ bootstrap: backend.bootstrap, deck: deckA });
    const deck = await previewFrame(page, "Deck A", "A one");
    await writeFile(path.join(deckA, "slides", "a-one.mdx"), "# A one, edited\n");
    // The deck's HMR socket runs on the studio's listener for the deck.
    await deck.getByRole("heading", { name: "A one, edited" }).waitFor();
    await page.getByRole("button", { name: "A one, edited" }).waitFor();
  });

  it("keeps focus on a moved row, move after move", async () => {
    const page = await openStudio({ bootstrap: backend.bootstrap, deck: deckA });
    await previewFrame(page, "Deck A", "A one");
    await page.getByRole("button", { name: "A one" }).press("Alt+ArrowDown");
    await page.getByRole("listitem").nth(1).getByRole("button", { name: "A one" }).waitFor();
    expect(await focusedName(page)).toBe("2A one");
    await page.keyboard.press("Alt+ArrowDown");
    await page.getByRole("listitem").nth(2).getByRole("button", { name: "A one" }).waitFor();
    expect(await focusedName(page)).toBe("3A one");
    expect(await readOrder(deckA)).toEqual(["a-two", "a-three", "a-one"]);
  });

  it("leaves focus where the user put it while a reorder waited", async () => {
    const page = await openStudio({ bootstrap: backend.bootstrap, deck: deckA });
    await previewFrame(page, "Deck A", "A one");
    const lock = path.join(deckA, ".fuse-deck.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "the-test-holds-it" }));
    await page.getByRole("button", { name: "A one" }).press("Alt+ArrowDown");
    await page.getByRole("status").getByText("Saving 1 change to Deck A…").waitFor();
    await page.getByRole("button", { name: "Open…" }).focus();
    await unlink(lock);
    // The list shows the move: A one is the second row.
    await page.getByRole("listitem").nth(1).getByRole("button", { name: "A one" }).waitFor();
    expect(await readOrder(deckA)).toEqual(["a-two", "a-one", "a-three"]);
    expect(await focusedName(page)).toBe("Open…");
  });

  it("gives the moved row no focus later when its reorder failed", async () => {
    const page = await openStudio({ bootstrap: backend.bootstrap, deck: deckA });
    const deck = await previewFrame(page, "Deck A", "A one");
    const lock = path.join(deckA, ".fuse-deck.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "the-test-holds-it" }));
    await page.getByRole("button", { name: "A one" }).press("Alt+ArrowDown");
    // The edit gives up on the lock after about five seconds.
    await page.getByText("is editing this deck").waitFor({ timeout: 30_000 });
    await unlink(lock);
    await deck.getByRole("region", { name: "A one" }).click();
    // Another edit moves A one on disk; the list follows it.
    const manifest = path.join(deckA, "deck.json");
    const text = await readFile(manifest, "utf8");
    await writeFile(manifest, text.replace('"a-one",\n    "a-two"', '"a-two",\n    "a-one"'));
    await page.getByRole("listitem").nth(1).getByRole("button", { name: "A one" }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");
  });
});
