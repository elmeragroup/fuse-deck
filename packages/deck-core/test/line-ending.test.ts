import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import * as LineEnding from "../src/deck/line-ending.ts";

/** Text built from words, spaces and every kind of line break. */
const text = fc.string({ unit: fc.constantFrom("a", "b", " ", "\n", "\r\n", "\r") });

describe("line endings", () => {
  it("detects the ending most lines use, and LF for a tie or no line break", () => {
    expect(LineEnding.detect("# A\r\n\r\nText\r\n")).toBe("CRLF");
    expect(LineEnding.detect("# A\r\n\r\nText\n")).toBe("CRLF");
    expect(LineEnding.detect("# A\r\nText\n")).toBe("LF");
    expect(LineEnding.detect("# A\nText\n")).toBe("LF");
    expect(LineEnding.detect("# A")).toBe("LF");
  });

  it("writes every line with the file's ending", () => {
    expect(LineEnding.toFile("# A\n\nText\n", "CRLF")).toBe("# A\r\n\r\nText\r\n");
    expect(LineEnding.toFile("# A\r\nText\n", "LF")).toBe("# A\nText\n");
  });

  it("round-trips: a file written with an ending reads back as the same editor text, with that ending", () => {
    fc.assert(
      fc.property(text, fc.constantFrom<LineEnding.LineEnding>("LF", "CRLF"), (source, ending) => {
        const written = LineEnding.toFile(source, ending);
        expect(LineEnding.toEditor(written)).toBe(LineEnding.toEditor(source));
        expect(written.replaceAll("\r\n", "").includes("\r")).toBe(false);
        if (LineEnding.toEditor(source).includes("\n")) {
          expect(LineEnding.detect(written)).toBe(ending);
        }
      })
    );
  });
});
