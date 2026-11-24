import { useCallback, useRef } from "react";

import { createRoute, Navigate } from "@tanstack/react-router";

import type { SlideId } from "@elmeragroup/deck-core/deck/slide-id";
import { Sidebar } from "@elmeragroup/fuse/sidebar";

import { Preview, showSlide } from "../components/preview.tsx";
import { SlideList } from "../components/slide-list.tsx";
import { deckOf } from "../state/studio-client.ts";
import { useStudio } from "../state/use-studio.ts";
import { rootRoute } from "./root.tsx";

/**
 * The open deck: the slide list on the left, the preview in the middle. While the backend
 * reconnects, the view stays, so a restart does not throw the user back to the start view.
 */
function DeckWorkspace() {
  const { snapshot } = useStudio();
  const frame = useRef<HTMLIFrameElement | null>(null);
  const { connection } = snapshot;
  const deck = connection._tag === "Connected" ? deckOf(connection.studio) : null;
  const show = useCallback(
    (slideId: SlideId) => {
      if (deck !== null) {
        showSlide(frame.current, deck, slideId);
      }
    },
    [deck]
  );
  if (connection._tag === "Connected" && connection.studio._tag === "Empty") {
    return <Navigate to="/" />;
  }
  if (deck === null) {
    return <main className="studio-waiting" aria-busy="true" />;
  }
  return (
    <Sidebar.Provider bounds="container" className="studio-workspace">
      <SlideList deck={deck} onShow={show} />
      <Sidebar.Inset className="studio-preview">
        <Preview deck={deck} frame={frame} />
      </Sidebar.Inset>
    </Sidebar.Provider>
  );
}

/** `/deck`, the open deck. */
export const deckRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/deck",
  component: DeckWorkspace,
});
