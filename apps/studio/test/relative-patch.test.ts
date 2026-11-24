import { assert, describe, it } from "vitest";

import { relativePatch } from "../src/renderer/state/relative-patch.ts";

describe("relativePatch", () => {
  it("rewrites the absolute headers claude-acp sends to git's a/ and b/ form, relative to the deck", () => {
    // The shape claude-acp 0.109.0 sent in the S4 live session, under a deck at /work/deck.
    const sent = [
      "diff --git /work/deck/slides/intro.mdx /work/deck/slides/intro.mdx",
      "--- /work/deck/slides/intro.mdx",
      "+++ /work/deck/slides/intro.mdx",
      "@@ -2,4 +2,6 @@",
      " ",
      " # Intro",
      " ",
      "+Edited by the agent in the studio.",
      "+",
      " <Button>Ask</Button>",
      "",
    ].join("\n");
    assert.strictEqual(
      relativePatch(sent, "/work/deck"),
      [
        "diff --git a/slides/intro.mdx b/slides/intro.mdx",
        "--- a/slides/intro.mdx",
        "+++ b/slides/intro.mdx",
        "@@ -2,4 +2,6 @@",
        " ",
        " # Intro",
        " ",
        "+Edited by the agent in the studio.",
        "+",
        " <Button>Ask</Button>",
        "",
      ].join("\n")
    );
  });

  it("keeps a path with spaces whole, and leaves /dev/null and lines inside a hunk alone", () => {
    const sent = [
      "diff --git /work/deck/slides/my slide.mdx /work/deck/slides/my slide.mdx",
      "--- /dev/null",
      "+++ /work/deck/slides/my slide.mdx",
      "@@ -0,0 +1,2 @@",
      "+--- a rule, not a header",
      "+text",
      "@@ -9 +10 @@",
      "--- /work/deck/removed, a line that read -- /work/deck/removed",
      "+kept",
    ].join("\n");
    assert.strictEqual(
      relativePatch(sent, "/work/deck/"),
      [
        "diff --git a/slides/my slide.mdx b/slides/my slide.mdx",
        "--- /dev/null",
        "+++ b/slides/my slide.mdx",
        "@@ -0,0 +1,2 @@",
        "+--- a rule, not a header",
        "+text",
        "@@ -9 +10 @@",
        "--- /work/deck/removed, a line that read -- /work/deck/removed",
        "+kept",
      ].join("\n")
    );
  });

  it("shows a file outside the deck with ../, so it does not pass for a deck file", () => {
    assert.strictEqual(
      relativePatch(
        "diff --git /etc/hosts /etc/hosts\n--- /etc/hosts\n+++ /etc/hosts\n@@ -1 +1 @@\n-a\n+b\n",
        "/work/deck"
      ),
      "diff --git a/../../etc/hosts b/../../etc/hosts\n--- a/../../etc/hosts\n+++ b/../../etc/hosts\n@@ -1 +1 @@\n-a\n+b\n"
    );
  });

  it("passes a patch already in git's form through unchanged", () => {
    const git =
      "diff --git a/slides/a.mdx b/slides/a.mdx\n--- a/slides/a.mdx\n+++ b/slides/a.mdx\n@@ -1 +1 @@\n-# A\n+# B\n";
    assert.strictEqual(relativePatch(git, "/work/deck"), git);
  });
});
