/**
 * The preview bridge between a framed deck and the studio that frames it. Both directions carry
 * `{ scopeId, slideId, step }`: the deck reports each committed position, and the studio asks the
 * deck to go to one. Slide ids, not indexes, because a reorder changes every index after it. A
 * request may carry a `requestId`, and the deck reports the position it commits for that request
 * under the same id, so the studio can tell its answer from a move the user made.
 *
 * The bridge exists only when the studio served the deck and named itself in the manifest, and
 * only while a parent frame exists, so `fuse-deck dev`, `build` and a Present window never post.
 */

import type { ManifestEmbedder } from "./manifest.ts";
import type { NavigableSlide, Position } from "./position.ts";

/** One bridge message, in either direction. */
export type BridgeMessage = {
  /** The deck scope the studio opened; a message for another scope is not for this page. */
  readonly scopeId: string;
  /** The slide's id. */
  readonly slideId: string;
  /** How many of the slide's steps are revealed. */
  readonly step: number;
  /** The studio's request this message asks for, or the report answers, or null for none. */
  readonly requestId: string | null;
};

/** A position a studio message asks for, and the request it came under, if any. */
export type RequestedPosition = {
  readonly position: Position;
  readonly requestId: string | null;
};

/** The studio window a framed deck reports to, and the origin it must have. */
export type BridgeParent = {
  readonly window: Window;
  readonly embedder: ManifestEmbedder;
};

/**
 * The studio frame to report to, or none when the deck has no embedder or no parent frame.
 *
 * @param embedder - The manifest's embedder.
 * @returns The parent window and its expected origin, or null.
 */
export function bridgeParent(embedder: ManifestEmbedder | null): BridgeParent | null {
  if (embedder === null || window.parent === window) {
    return null;
  }
  return { window: window.parent, embedder };
}

/**
 * Report a committed position to the studio. `targetOrigin` is the embedder's, so the browser
 * drops the message when another page frames the deck.
 *
 * @param parent - The studio frame.
 * @param position - The committed position.
 * @param slides - The deck's slides.
 * @param requestId - The studio request that position answers, or null for any other move.
 */
export function reportPosition(
  parent: BridgeParent,
  position: Position,
  slides: readonly NavigableSlide[],
  requestId: string | null
): void {
  const slide = slides[position.slide];
  if (slide === undefined) {
    return;
  }
  const message: BridgeMessage = {
    scopeId: parent.embedder.scopeId,
    slideId: slide.id,
    step: position.step,
    requestId,
  };
  parent.window.postMessage(message, parent.embedder.origin);
}

/**
 * The position a studio message asks for, or null when the message is not the studio's: another
 * source or origin, another scope, an unknown slide, or a malformed payload. A step past the
 * slide's last is clamped to its last.
 *
 * @param parent - The studio frame.
 * @param event - The received message.
 * @param slides - The deck's slides.
 * @returns The position to go to and its request id, or null to ignore the message.
 */
export function requestedPosition(
  parent: BridgeParent,
  event: MessageEvent<unknown>,
  slides: readonly NavigableSlide[]
): RequestedPosition | null {
  if (event.source !== parent.window || event.origin !== parent.embedder.origin) {
    return null;
  }
  const message = messageFrom(event);
  if (message?.scopeId !== parent.embedder.scopeId) {
    return null;
  }
  const slide = slides.findIndex((each) => each.id === message.slideId);
  const target = slides[slide];
  if (target === undefined) {
    return null;
  }
  return {
    position: { slide, step: Math.min(target.steps, message.step) },
    requestId: message.requestId,
  };
}

/**
 * Read a bridge message from a received message. This is the bridge's input boundary: any page
 * can post to the deck's window, so the payload has no type until this reads it. The runtime ships
 * no schema library, so it checks each field's representation here, once.
 *
 * @param event - The received message.
 * @returns The message, or null when the payload is not one.
 */
function messageFrom(event: MessageEvent<unknown>): BridgeMessage | null {
  const { data } = event;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the postMessage boundary; see above
  if (data === null || typeof data !== "object") {
    return null;
  }
  const { scopeId, slideId, step, requestId } = Object.fromEntries(Object.entries(data));
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the postMessage boundary; see above
  if (typeof scopeId !== "string" || typeof slideId !== "string") {
    return null;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the postMessage boundary; see above
  if (typeof step !== "number" || !Number.isInteger(step) || step < 0) {
    return null;
  }
  if (requestId === undefined || requestId === null) {
    return { scopeId, slideId, step, requestId: null };
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the postMessage boundary; see above
  return typeof requestId === "string" ? { scopeId, slideId, step, requestId } : null;
}
