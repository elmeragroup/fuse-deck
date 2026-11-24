/**
 * The stub page's preload. It exposes `window.fuseDeckStudio`: the backend's status and its
 * changes. The pattern is t3code's `desktopBridge` (pingdotgg/t3code `apps/desktop/src/preload.ts`
 * at 2fe7febc, MIT licence, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md), cut to
 * one call and one event.
 *
 * It runs sandboxed, where Effect's bundle does not load (it redeclares `setImmediate`), so it
 * imports only `electron` and the channel names and passes main's values through as it gets them.
 * The page decodes them with the `BackendStatus` schema.
 */

import { contextBridge, ipcRenderer } from "electron";

import { BACKEND_STATUS_CHANGED_CHANNEL, BACKEND_STATUS_CHANNEL } from "./ipc/channels.ts";

/** What the preload exposes as `window.fuseDeckStudio`. Values arrive encoded, as IPC carried them. */
export type FuseDeckStudioBridge = {
  /** The backend's current status, encoded. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- An IPC value; the page decodes it with BackendStatus.
  readonly backendStatus: () => Promise<unknown>;
  /** Call `listener` with each status change, encoded; the returned function stops it. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- An IPC value; the page decodes it with BackendStatus.
  readonly onBackendStatus: (listener: (encoded: unknown) => void) => () => void;
};

const bridge: FuseDeckStudioBridge = {
  backendStatus: () => ipcRenderer.invoke(BACKEND_STATUS_CHANNEL),
  onBackendStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: ReadonlyArray<unknown>) => {
      listener(args[0]);
    };
    ipcRenderer.on(BACKEND_STATUS_CHANGED_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(BACKEND_STATUS_CHANGED_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld("fuseDeckStudio", bridge);
