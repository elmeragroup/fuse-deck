import { createRoute, Navigate } from "@tanstack/react-router";

import { EmptyState } from "../components/empty-state.tsx";
import { deckOf } from "../state/studio-client.ts";
import { useStudio } from "../state/use-studio.ts";
import { rootRoute } from "./root.tsx";

/** The start view: the empty state, or the deck once the backend has one open. */
function Home() {
  const { snapshot } = useStudio();
  const { connection } = snapshot;
  if (connection._tag === "Connected" && deckOf(connection.studio) !== null) {
    return <Navigate to="/deck" />;
  }
  return <EmptyState />;
}

/** `/`, the start view. */
export const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });
