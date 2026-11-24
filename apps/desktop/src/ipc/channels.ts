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
