import { useEffect } from "react";
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

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const source = frame.current?.contentWindow;
      if (source === undefined || source === null || event.source !== source || event.origin !== deckOrigin) {
        return;
      }
      Option.match(decodeMessage(event.data), {
        onNone: () => undefined,
        onSome: (message) => {
          if (message.scopeId === deck.scopeId) {
            client.reportPosition({ scopeId: deck.scopeId, slideId: message.slideId, step: message.step });
          }
        },
      });
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [client, deck.scopeId, deckOrigin, frame]);

  return (
    <iframe
      key={deck.scopeId}
      ref={frame}
      src={deck.url}
      title={`${deck.title} preview`}
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
