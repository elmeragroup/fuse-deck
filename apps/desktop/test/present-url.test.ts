import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import { presentableUrl } from "../src/window/present-url.ts";

const DECK = Option.some("http://127.0.0.1:4100/");

function presented(requested: string, openDeck: Option.Option<string> = DECK): string | null {
  return Option.getOrNull(Option.map(presentableUrl(requested, openDeck), (url) => url.href));
}

describe("presentableUrl", () => {
  it("accepts a page of the open deck, with the position in its hash", () => {
    expect(presented("http://127.0.0.1:4100/#/outro/2")).toBe("http://127.0.0.1:4100/#/outro/2");
  });

  it("refuses another port on 127.0.0.1, another host and another scheme", () => {
    expect(presented("http://127.0.0.1:4101/#/outro")).toBeNull();
    expect(presented("http://localhost:4100/")).toBeNull();
    expect(presented("https://127.0.0.1:4100/")).toBeNull();
    expect(presented("http://user:secret@127.0.0.1:4100/")).toBeNull();
    expect(presented("not a url")).toBeNull();
  });

  it("refuses every address while no deck is open", () => {
    expect(presented("http://127.0.0.1:4100/", Option.none())).toBeNull();
  });
});
