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
  /**
   * The deck to open at start, from `FUSE_DECK_STUDIO_DECK`, as a `PickedDeck`. Only the first call
   * gets it; a reloaded page gets null and keeps the deck the backend has open.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- an IPC value; the renderer decodes it with PickedDeck
  readonly initialDeck: () => Promise<unknown>;
  /**
   * Show the deck page at `url`, the open deck's 127.0.0.1 address with the position in its hash,
   * in a fullscreen window. Main asks the backend which deck is open and refuses any address on
   * another origin, another 127.0.0.1 port included.
   */
  readonly present: (url: string) => Promise<void>;
  /**
   * Tell main whether the Source tab holds a draft with edits. While it does, main asks the page
   * before it quits or closes the window, through `onLeaveRequest`.
   */
  readonly setUnsavedDraft: (unsaved: boolean) => Promise<void>;
  /**
   * Call `listener` with a `LeaveIntent` each time main holds back a quit or a window close for an
   * unsaved draft. The returned function stops it.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- an IPC value; the renderer decodes it with LeaveIntent
  readonly onLeaveRequest: (listener: (intent: unknown) => void) => () => void;
  /** Go on with the quit or the window close main held back, once the page settled the draft. */
  readonly leave: (intent: LeaveIntent) => Promise<void>;
};

/** What main held back for an unsaved draft: quitting the app, or closing its window. */
export const LeaveIntent = Schema.Literals(["quit", "close"]);

/** What main held back for an unsaved draft. */
export type LeaveIntent = typeof LeaveIntent.Type;

/** A deck directory, absolute, or null when there is none. */
export const PickedDeck = Schema.NullOr(Schema.String);

/** The window property the preload sets. */
export const BRIDGE_PROPERTY = "fuseDeckStudio";
