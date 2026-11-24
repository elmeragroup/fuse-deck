/**
 * The renderer's preload. It exposes `window.fuseDeckStudio`, the bridge the studio's contract
 * declares (`@elmeragroup/fuse-deck-studio/contract/desktop-bridge`), after t3code's
 * `desktopBridge` (pingdotgg/t3code `apps/desktop/src/preload.ts` at 2fe7febc, MIT licence,
 * Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md), cut to three calls.
 *
 * It runs sandboxed, where Effect's bundle does not load (it redeclares `setImmediate`), so it
 * imports only `electron` and constants, and passes main's values through as it gets them. The
 * renderer decodes them. Main answers only the main window's main frame.
 */

import { contextBridge, ipcRenderer } from "electron";

import type { FuseDeckStudioBridge } from "@elmeragroup/fuse-deck-studio/contract/desktop-bridge";

import { BACKEND_CONNECTION_CHANNEL, INITIAL_DECK_CHANNEL, PICK_DECK_CHANNEL } from "./ipc/channels.ts";

const bridge: FuseDeckStudioBridge = {
  connection: () => ipcRenderer.invoke(BACKEND_CONNECTION_CHANNEL),
  pickDeck: () => ipcRenderer.invoke(PICK_DECK_CHANNEL),
  initialDeck: () => ipcRenderer.invoke(INITIAL_DECK_CHANNEL),
};

// The studio contract's BRIDGE_PROPERTY; importing it would bring Effect's Schema into the preload.
contextBridge.exposeInMainWorld("fuseDeckStudio", bridge);
