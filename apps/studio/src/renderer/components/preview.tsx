import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PreviewMessage } from "../../contract/preview-message.ts";
import type { OpenDeck } from "../../contract/studio-rpc.ts";
import { useStudio } from "../state/use-studio.ts";

const decodeMessage = Schema.decodeUnknownOption(PreviewMessage);

/**
 * The open deck, framed from its own dev server. The frame remounts for each deck scope, and a
 * position report counts only when it comes from the current frame's window, from the deck's
 * origin and for the current scope.
 *
 * It carries out the agent's go requests: it posts each to the frame with its request id, and posts
 * it again after each report that does not carry that id, until the frame reports the position it
 * committed under it, which is the go's answer. A page that has not loaded a slide the agent just
 * added ignores the request, and reports again once it reloads with it; a move the user makes
 * meanwhile answers nothing. A cancel drops the go it names, so a stopped or late go never moves the
 * preview.
 */
export function Preview({
  deck,
  frame,
}: {
  readonly deck: OpenDeck;
  readonly frame: RefObject<HTMLIFrameElement | null>;
}) {
  const { client } = useStudio();
  const deckOrigin = new URL(deck.url).origin;
  // The agent's go request the frame has not carried out yet, and its request id.
  const pendingGo = useRef<{ readonly message: PreviewMessage; readonly requestId: string } | null>(null);

  useEffect(() => {
    pendingGo.current = null;
    const post = (message: PreviewMessage) => {
      frame.current?.contentWindow?.postMessage(message, deckOrigin);
    };
    const unsubscribe = client.onViewRequest((request) => {
      if (request.scopeId !== deck.scopeId) {
        return;
      }
      if (request._tag === "Cancel") {
        if (pendingGo.current?.requestId === request.requestId) {
          pendingGo.current = null;
        }
        return;
      }
      const message: PreviewMessage = {
        scopeId: deck.scopeId,
        slideId: request.slideId,
        step: request.step,
        requestId: request.requestId,
      };
      pendingGo.current = { message, requestId: request.requestId };
      post(message);
    });
    const onMessage = (event: MessageEvent<unknown>) => {
      const source = frame.current?.contentWindow;
      if (source === undefined || source === null || event.source !== source || event.origin !== deckOrigin) {
        return;
      }
      Option.match(decodeMessage(event.data), {
        onNone: () => undefined,
        onSome: (message) => {
          if (message.scopeId !== deck.scopeId) {
            return;
          }
          const pending = pendingGo.current;
          const answers = pending !== null && message.requestId === pending.requestId;
          client.reportPosition(
            { scopeId: deck.scopeId, slideId: message.slideId, step: message.step },
            answers ? pending.requestId : null
          );
          if (answers) {
            pendingGo.current = null;
          } else if (pending !== null) {
            post(pending.message);
          }
        },
      });
    };
    window.addEventListener("message", onMessage);
    return () => {
      unsubscribe();
      window.removeEventListener("message", onMessage);
    };
  }, [client, deck.scopeId, deckOrigin, frame]);

  return (
    <iframe
      key={deck.scopeId}
      ref={frame}
      src={deck.url}
      title={`${deck.title} preview`}
      allow="autoplay; fullscreen"
      data-scope-id={deck.scopeId}
      className="studio-preview-frame"
    />
  );
}

/**
 * Ask the framed deck to show a slide from its first step.
 *
 * @param frame - The preview frame.
 * @param deck - The deck in the frame.
 * @param slideId - The slide to show.
 */
export function showSlide(frame: HTMLIFrameElement | null, deck: OpenDeck, slideId: string): void {
  const message: PreviewMessage = { scopeId: deck.scopeId, slideId, step: 0 };
  frame?.contentWindow?.postMessage(message, new URL(deck.url).origin);
}
