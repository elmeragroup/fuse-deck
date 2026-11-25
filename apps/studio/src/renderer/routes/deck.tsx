import { useCallback, useEffect, useRef, useState } from "react";

import { createRoute, Navigate } from "@tanstack/react-router";
import { flushSync } from "react-dom";

import type { SlideId } from "@elmeragroup/deck-core/deck/slide-id";
import { Alert } from "@elmeragroup/fuse/alert";
import { Button } from "@elmeragroup/fuse/button";
import { Sidebar } from "@elmeragroup/fuse/sidebar";
import { Tabs } from "@elmeragroup/fuse/tabs";

import type { OpenDeck } from "../../contract/studio-rpc.ts";
import { Preview, showSlide } from "../components/preview.tsx";
import { SlideList } from "../components/slide-list.tsx";
import { SourceEditor } from "../components/source-editor.tsx";
import type { UnsavedDraft } from "../components/source-editor.tsx";
import { UnsavedDraftPrompt } from "../components/unsaved-draft-prompt.tsx";
import type { PendingLeave } from "../components/unsaved-draft-prompt.tsx";
import { deckOf } from "../state/studio-client.ts";
import type { PreviewPosition } from "../state/studio-client.ts";
import { useStudio } from "../state/use-studio.ts";
import { rootRoute } from "./root.tsx";

/** The center tabs. */
type CenterTab = "preview" | "source";

/**
 * The deck page at a position: the deck's address with `#/<slide>` or `#/<slide>/<step>`, the
 * deep link the deck runtime reads.
 */
function presentUrl(deck: OpenDeck, position: PreviewPosition | null): string {
  const url = new URL(deck.url);
  if (position !== null) {
    url.hash = position.step === 0 ? `/${position.slideId}` : `/${position.slideId}/${String(position.step)}`;
  }
  return url.href;
}

/**
 * The open deck: the slide list on the left, the Preview and Source tabs in the middle, and
 * Present. Both tab panels stay mounted, so the preview keeps its place and the editor its draft
 * while the other tab shows. While the backend reconnects, and while the client opens the same
 * deck again after the backend came back without it, the view stays, so a restart keeps the user
 * and the draft where they were. When that reopen fails while the draft has edits, the view stays
 * too, with the draft, and offers to retry, copy the draft or let the deck go. Otherwise only a
 * state that says the deck is gone leads to the start view.
 * The editor is keyed by the deck's directory, not its scope: a revision names bytes on disk, so a
 * draft stays valid when the same deck reopens.
 *
 * Opening another deck, closing this one and quitting the app ask first while the draft has edits.
 */
function DeckWorkspace() {
  const { client, snapshot } = useStudio();
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [tab, setTab] = useState<CenterTab>("preview");
  const { connection } = snapshot;
  const connected = connection._tag === "Connected" ? deckOf(connection.studio) : null;
  // While the socket is down the workspace stays, on the deck it last showed, so an unsaved draft
  // survives a dropped connection; a save tried meanwhile fails and keeps it.
  const [lastDeck, setLastDeck] = useState<OpenDeck | null>(null);
  if (connected !== null && connected !== lastDeck) {
    setLastDeck(connected);
  }
  const [unsavedDraft, setUnsavedDraft] = useState<UnsavedDraft | null>(null);
  const reopenFailed =
    lastDeck !== null && unsavedDraft !== null && snapshot.reopenFailed?.root === lastDeck.root
      ? snapshot.reopenFailed
      : null;
  const holding =
    connection._tag !== "Connected" ||
    (lastDeck !== null && snapshot.reopening === lastDeck.root) ||
    reopenFailed !== null;
  const deck = connected ?? (holding ? lastDeck : null);
  const position = deck !== null && snapshot.position?.scopeId === deck.scopeId ? snapshot.position : null;
  const slides = deck !== null && snapshot.slides?.scopeId === deck.scopeId ? snapshot.slides.slides : null;
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  /** Run `proceed` now, or after the prompt when it would drop a draft with edits. */
  const guarded = useCallback(
    (proceed: () => void) => {
      if (unsavedDraft === null) {
        proceed();
      } else {
        setPendingLeave({ draft: unsavedDraft, proceed });
      }
    },
    [unsavedDraft]
  );
  // Main asks before it quits or closes the window while a draft has edits.
  const unsaved = unsavedDraft !== null;
  useEffect(() => {
    client.reportUnsavedDraft(unsaved);
  }, [client, unsaved]);
  useEffect(
    () => () => {
      client.reportUnsavedDraft(false);
    },
    [client]
  );
  useEffect(
    () =>
      client.onLeaveRequest((intent) => {
        guarded(() => {
          client.leave(intent);
        });
      }),
    [client, guarded]
  );

  const show = useCallback(
    (slideId: SlideId) => {
      if (deck !== null) {
        showSlide(frame.current, deck, slideId);
      }
    },
    [deck]
  );
  if (deck === null && connection._tag === "Connected" && connection.studio._tag === "Empty") {
    return <Navigate to="/" />;
  }
  if (deck === null) {
    return <main className="studio-waiting" aria-busy="true" />;
  }
  // The editor opens the slide the preview shows, or the first slide before the preview reports.
  const reported = slides?.find(({ id }) => id === position?.slideId)?.id;
  const target = reported ?? slides?.[0]?.id ?? null;

  const present = () => {
    // The browser can only fullscreen the frame while its panel shows.
    flushSync(() => {
      setTab("preview");
    });
    client.present(presentUrl(deck, position), frame.current);
  };

  return (
    <Sidebar.Provider bounds="container" className="studio-workspace">
      <SlideList
        deck={deck}
        onShow={show}
        onOpenDeck={() => {
          guarded(client.pickDeck);
        }}
        onCloseDeck={() => {
          guarded(client.closeDeck);
        }}
      />
      <Sidebar.Inset className="studio-center">
        {reopenFailed === null || unsavedDraft === null ? null : (
          <ReopenFailed
            deck={deck}
            message={reopenFailed.message}
            draft={unsavedDraft}
            onRetry={client.retryReopen}
            onCopied={() => {
              client.announce(`Copied your draft of ${unsavedDraft.file}.`);
            }}
            onCopyFailed={() => {
              client.announce(`Could not copy your draft of ${unsavedDraft.file}.`);
            }}
            onDiscard={client.dismissReopenFailure}
          />
        )}
        <Tabs.Root
          className="studio-tabs"
          value={tab}
          onValueChange={(value) => {
            setTab(value === "source" ? "source" : "preview");
          }}>
          <div className="studio-center-bar">
            <Tabs.List aria-label="Deck view">
              <Tabs.Trigger value="preview">Preview</Tabs.Trigger>
              <Tabs.Trigger value="source">Source</Tabs.Trigger>
            </Tabs.List>
            <Button size="sm" variant="outline" onClick={present}>
              Present
            </Button>
          </div>
          <Tabs.Content value="preview" keepMounted className="studio-preview">
            <Preview deck={deck} frame={frame} />
          </Tabs.Content>
          <Tabs.Content value="source" keepMounted className="studio-source-panel">
            <SourceEditor
              key={deck.root}
              deck={deck}
              target={target}
              active={tab === "source"}
              onUnsavedDraft={setUnsavedDraft}
            />
          </Tabs.Content>
        </Tabs.Root>
      </Sidebar.Inset>
      <UnsavedDraftPrompt
        pending={pendingLeave}
        onSettled={() => {
          setPendingLeave(null);
        }}
        onSaveFailed={() => {
          setTab("source");
        }}
      />
    </Sidebar.Provider>
  );
}

/**
 * The deck could not be opened again after the backend came back without it, while the Source tab
 * holds a draft with edits: the draft stays, with a retry, a copy of it, or letting the deck go.
 */
function ReopenFailed({
  deck,
  message,
  draft,
  onRetry,
  onCopied,
  onCopyFailed,
  onDiscard,
}: {
  readonly deck: OpenDeck;
  readonly message: string;
  readonly draft: UnsavedDraft;
  readonly onRetry: () => void;
  readonly onCopied: () => void;
  readonly onCopyFailed: () => void;
  readonly onDiscard: () => void;
}) {
  return (
    <Alert.Root variant="destructive" role="alert" className="studio-reopen-failed">
      <Alert.Title level={2}>{deck.title} could not be opened again</Alert.Title>
      <Alert.Description>
        {message} Your draft of {draft.file} is kept until you discard it.
      </Alert.Description>
      <div className="studio-reopen-failed-actions">
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(draft.text).then(onCopied, onCopyFailed);
          }}>
          Copy draft
        </Button>
        <Button size="sm" variant="outline" onClick={onDiscard}>
          Discard draft
        </Button>
      </div>
    </Alert.Root>
  );
}

/** `/deck`, the open deck. */
export const deckRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/deck",
  component: DeckWorkspace,
});
