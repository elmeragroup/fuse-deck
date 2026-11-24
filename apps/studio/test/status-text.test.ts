import { describe, expect, it } from "vitest";

import { OpenRequestId, ScopeId } from "../src/contract/studio-rpc.ts";
import type { StudioState } from "../src/contract/studio-rpc.ts";
import { statusText } from "../src/renderer/state/status-text.ts";

const deck = {
  scopeId: ScopeId.make("scope-a"),
  requestId: OpenRequestId.make("request-a"),
  root: "/decks/a",
  title: "Deck A",
  url: "http://127.0.0.1:4100/",
};

function connected(studio: StudioState) {
  return statusText({ _tag: "Connected", studio });
}

describe("the status line", () => {
  it("shows nothing for admitted reads, and counts only the writes as saves", () => {
    expect(connected({ _tag: "Open", deck, admitted: 1, writing: 0 })).toBe("");
    expect(connected({ _tag: "Open", deck, admitted: 3, writing: 1 })).toBe("Saving 1 change to Deck A…");
  });

  it("names a closing deck, and the writes it waits for", () => {
    expect(connected({ _tag: "Closing", deck, admitted: 2, writing: 0 })).toBe("Closing Deck A…");
    expect(connected({ _tag: "Closing", deck, admitted: 3, writing: 2 })).toBe(
      "Finishing 2 changes on Deck A before closing it…"
    );
  });
});
