/**
 * The React side of the studio client: a context that carries it and a hook that reads its
 * snapshot through `useSyncExternalStore`.
 */

import { createContext, useContext, useSyncExternalStore } from "react";

import type { StudioClient, StudioSnapshot } from "./studio-client.ts";

/** The studio client for the tree below. */
export const StudioClientContext = createContext<StudioClient | null>(null);

/** What `useStudio` returns. */
export type StudioView = {
  readonly client: StudioClient;
  readonly snapshot: StudioSnapshot;
};

/**
 * The studio client and its current snapshot.
 *
 * @returns The client and the snapshot, which re-renders the caller on every change.
 * @throws When no `StudioClientContext` provider is above the caller, which only a wiring bug causes.
 */
export function useStudio(): StudioView {
  const client = useContext(StudioClientContext);
  if (client === null) {
    throw new Error("useStudio needs a StudioClientContext provider.");
  }
  const snapshot = useSyncExternalStore(client.subscribe, client.snapshot);
  return { client, snapshot };
}
