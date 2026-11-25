/**
 * The IPC channels between the renderer's preload and main, after t3code's
 * `apps/desktop/src/ipc/channels.ts`. The preload imports this file, so it holds only constants.
 */

/** Invoke: the current backend's address and session bearer. */
export const BACKEND_CONNECTION_CHANNEL = "fuse-deck-studio:backend-connection";

/** Invoke: ask the user for a deck directory. */
export const PICK_DECK_CHANNEL = "fuse-deck-studio:pick-deck";

/** Invoke: the deck to open at start. */
export const INITIAL_DECK_CHANNEL = "fuse-deck-studio:initial-deck";

/** Invoke: show the deck page at the given address in the fullscreen Present window. */
export const PRESENT_CHANNEL = "fuse-deck-studio:present";

/** Invoke: whether the Source tab holds a draft with edits. */
export const UNSAVED_DRAFT_CHANNEL = "fuse-deck-studio:unsaved-draft";

/** Send, main to the page: a quit or a window close waits for the page to settle its draft. */
export const LEAVE_REQUEST_CHANNEL = "fuse-deck-studio:leave-request";

/** Invoke: the page settled its draft; go on with the quit or the window close. */
export const LEAVE_CHANNEL = "fuse-deck-studio:leave";
