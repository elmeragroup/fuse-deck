/**
 * The renderer's preload. It exposes `window.fuseDeckStudio`, the bridge the studio's contract
 * declares (`@elmeragroup/fuse-deck-studio/contract/desktop-bridge`), after t3code's
 * `desktopBridge` (pingdotgg/t3code `apps/desktop/src/preload.ts` at 2fe7febc, MIT licence,
 * Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md), cut to the studio's calls.
 *
 * It runs sandboxed, where Effect's bundle does not load (it redeclares `setImmediate`), so it
 * imports only `electron` and constants, and passes main's values through as it gets them. The
 * renderer decodes them. Main answers only the main window's main frame.
 */

import { contextBridge, ipcRenderer } from "electron";

import type { FuseDeckStudioBridge } from "@elmeragroup/fuse-deck-studio/contract/desktop-bridge";

import {
  BACKEND_CONNECTION_CHANNEL,
  INITIAL_DECK_CHANNEL,
  LEAVE_CHANNEL,
  LEAVE_REQUEST_CHANNEL,
  PICK_DECK_CHANNEL,
  PRESENT_CHANNEL,
  UNSAVED_DRAFT_CHANNEL,
} from "./ipc/channels.ts";

const bridge: FuseDeckStudioBridge = {
  connection: () => ipcRenderer.invoke(BACKEND_CONNECTION_CHANNEL),
  pickDeck: () => ipcRenderer.invoke(PICK_DECK_CHANNEL),
  initialDeck: () => ipcRenderer.invoke(INITIAL_DECK_CHANNEL),
  present: (url) => ipcRenderer.invoke(PRESENT_CHANNEL, url),
  setUnsavedDraft: (unsaved) => ipcRenderer.invoke(UNSAVED_DRAFT_CHANNEL, unsaved),
  onLeaveRequest: (listener) => {
    // The page gets the intent alone, never the IPC event and its sender.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- an IPC value; the renderer decodes it with LeaveIntent
    const forward = (_event: Electron.IpcRendererEvent, intent: unknown) => {
      listener(intent);
    };
    ipcRenderer.on(LEAVE_REQUEST_CHANNEL, forward);
    return () => {
      ipcRenderer.off(LEAVE_REQUEST_CHANNEL, forward);
    };
  },
  leave: (intent) => ipcRenderer.invoke(LEAVE_CHANNEL, intent),
};

// The studio contract's BRIDGE_PROPERTY; importing it would bring Effect's Schema into the preload.
contextBridge.exposeInMainWorld("fuseDeckStudio", bridge);
