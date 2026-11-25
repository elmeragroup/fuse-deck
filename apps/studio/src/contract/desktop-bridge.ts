/**
 * What the desktop app's preload exposes to the renderer as `window.fuseDeckStudio`, after
 * t3code's `desktopBridge` (pingdotgg/t3code `apps/desktop/src/preload.ts` at 2fe7febc, MIT
 * licence, Copyright (c) 2026 T3 Tools Inc.; see apps/desktop/THIRD_PARTY_NOTICES.md).
 *
 * The sandboxed preload cannot load Effect, so values cross encoded and the renderer decodes them
 * with the schemas here. Main answers each call only for the main window's main frame.
 */

import * as Schema from "effect/Schema";

/** The preload's bridge. Every value arrives as IPC carried it. */
export type FuseDeckStudioBridge = {
  /**
   * The current backend's address and session bearer, as a `BackendConnection`. It waits while
   * the backend starts or restarts, so each call returns the bearer for the backend running now.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- an IPC value; the renderer decodes it with BackendConnection
  readonly connection: () => Promise<unknown>;
  /** Ask the user for a deck directory with the system dialog, as a `PickedDeck`. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- an IPC value; the renderer decodes it with PickedDeck
  readonly pickDeck: () => Promise<unknown>;
  /** The deck to open at start, from `FUSE_DECK_STUDIO_DECK`, as a `PickedDeck`. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- an IPC value; the renderer decodes it with PickedDeck
  readonly initialDeck: () => Promise<unknown>;
};

/** A deck directory, absolute, or null when there is none. */
export const PickedDeck = Schema.NullOr(Schema.String);

/** The window property the preload sets. */
export const BRIDGE_PROPERTY = "fuseDeckStudio";
