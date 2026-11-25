import { describe, expect, it } from "vitest";

import { SlideRevision } from "@elmeragroup/deck-core/deck/slide-edit";
import { SlideId } from "@elmeragroup/deck-core/deck/slide-id";

import { ScopeId } from "../src/contract/studio-rpc.ts";
import { slideReads } from "../src/renderer/state/slide-reads.ts";
import type { ReadKey } from "../src/renderer/state/slide-reads.ts";
import type { OpenOutcome } from "../src/renderer/state/studio-client.ts";

/** A read the test answers by hand, in any order. */
type PendingRead = { readonly answer: (source: string) => Promise<void> };

/**
 * The reads over a disk the test answers by hand, the editor's current key, and every source an
 * answer applied, in order.
 */
function harness(initial: ReadKey) {
  const pending: PendingRead[] = [];
  const applied: string[] = [];
  let current: ReadKey | null = initial;
  const reads = slideReads(
    () =>
      new Promise<OpenOutcome>((resolve) => {
        pending.push({
          answer: async (source) => {
            resolve({ _tag: "Opened", slide: { source, revision: SlideRevision.make(source) } });
            // Let the read's continuation run.
            await Promise.resolve();
            await Promise.resolve();
          },
        });
      }),
    () => current
  );
  return {
    pending,
    applied,
    read: (key: ReadKey) => {
      reads.read(key, (outcome) => {
        applied.push(outcome._tag === "Opened" ? outcome.slide.source : outcome._tag);
      });
    },
    move: (key: ReadKey | null) => {
      current = key;
    },
  };
}

const key: ReadKey = { session: 1, scopeId: ScopeId.make("scope-a"), id: SlideId.make("intro") };

describe("the Source tab's reads", () => {
  it("applies only the latest read, whichever answers first", async () => {
    const reads = harness(key);
    reads.read(key);
    reads.read(key);
    const [older, newer] = reads.pending;
    await newer?.answer("# Newer\n");
    await older?.answer("# Older\n");
    expect(reads.applied).toEqual(["# Newer\n"]);
  });

  it("drops an answer from an earlier session, deck scope or slide", async () => {
    for (const later of [
      { ...key, session: 2 },
      { ...key, scopeId: ScopeId.make("scope-b") },
      { ...key, id: SlideId.make("outro") },
    ]) {
      const reads = harness(key);
      reads.read(key);
      reads.move(later);
      await reads.pending[0]?.answer("# Stale\n");
      expect(reads.applied).toEqual([]);
    }
  });
});
