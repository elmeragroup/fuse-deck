/**
 * The one owner of the Source tab's reads of a slide from disk. A read answers only while it is
 * the latest one started and the editor still shows what it read for: the same session, the same
 * deck scope and the same slide. Any other answer arrived late, after a newer read, a reconnect, a
 * reopened deck or a move to another slide, and it is dropped, so an old disk state never lands
 * over a newer one.
 */

import type { SlideId } from "@elmeragroup/deck-core/deck/slide-id";

import type { ScopeId } from "../../contract/studio-rpc.ts";
import type { OpenOutcome } from "./studio-client.ts";

/** What a read is for: the session that sent it, the deck scope and the slide. */
export type ReadKey = {
  readonly session: number;
  readonly scopeId: ScopeId;
  readonly id: SlideId;
};

/** The Source tab's reads. */
export type SlideReads = {
  /**
   * Read `key`'s slide, and call `apply` with the outcome if, when it arrives, no read started
   * after this one and `current()` still names `key`.
   */
  readonly read: (key: ReadKey, apply: (outcome: OpenOutcome) => void) => void;
};

/**
 * The reads, over `openSlide`.
 *
 * @param openSlide - Reads a slide of a deck scope from disk.
 * @param current - What the editor shows now, or null when it shows no slide.
 * @returns The reads.
 */
export function slideReads(
  openSlide: (scopeId: ScopeId, id: SlideId) => Promise<OpenOutcome>,
  current: () => ReadKey | null
): SlideReads {
  let latest = 0;
  return {
    read: (key, apply) => {
      latest += 1;
      const generation = latest;
      void openSlide(key.scopeId, key.id).then((outcome) => {
        const now = current();
        if (
          generation === latest &&
          now !== null &&
          now.session === key.session &&
          now.scopeId === key.scopeId &&
          now.id === key.id
        ) {
          apply(outcome);
        }
      });
    },
  };
}
