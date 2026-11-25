/**
 * The IPC channels between the stub page's preload and main, after t3code's
 * `apps/desktop/src/ipc/channels.ts`. The preload imports this file, so it holds only constants.
 */

/** Invoke: the backend's current status. */
export const BACKEND_STATUS_CHANNEL = "fuse-deck-studio:backend-status";

/** Main to renderer: the backend's status changed. */
export const BACKEND_STATUS_CHANGED_CHANNEL = "fuse-deck-studio:backend-status-changed";
