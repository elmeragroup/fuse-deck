/**
 * The S0 stub page: it shows the backend's status and frames the deck once the backend reports
 * its address. The studio's renderer replaces it in S2.
 */

import * as Schema from "effect/Schema";

import { BackendStatus } from "../backend/backend-status.ts";
import type { FuseDeckStudioBridge } from "../preload.ts";

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Augmenting the global Window needs an interface.
  interface Window {
    readonly fuseDeckStudio: FuseDeckStudioBridge;
  }
}

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) {
    throw new Error(`The stub page lacks #${id}.`);
  }
  return found;
}

const statusText = element("status", HTMLParagraphElement);
const frame = element("deck", HTMLIFrameElement);

function show(status: BackendStatus): void {
  switch (status._tag) {
    case "Ready": {
      // The page frames only a loopback dev server; the policy's `frame-src` says the same.
      const url = URL.parse(status.url);
      if (url?.protocol !== "http:" || url.hostname !== "127.0.0.1") {
        statusText.textContent = `The deck server reported an address the studio does not frame: ${status.url}`;
        return;
      }
      statusText.textContent = `Serving ${url.href}`;
      // A restart can bring the backend back on another port; reload the frame only then.
      if (frame.src !== url.href) {
        frame.src = url.href;
      }
      frame.hidden = false;
      return;
    }
    case "Restarting": {
      statusText.textContent = `The deck server stopped (${status.reason}). Restarting…`;
      return;
    }
    case "Starting": {
      statusText.textContent = "Starting the deck server…";
      return;
    }
  }
}

// Main and this page ship together, so a status that does not decode is a defect, and throws.
const decodeStatus = Schema.decodeUnknownSync(BackendStatus);

window.fuseDeckStudio.onBackendStatus((encoded) => {
  show(decodeStatus(encoded));
});
show(decodeStatus(await window.fuseDeckStudio.backendStatus()));
