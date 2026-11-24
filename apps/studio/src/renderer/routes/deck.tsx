import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { createRoute, Navigate } from "@tanstack/react-router";
import { flushSync } from "react-dom";

import type { SlideId } from "@elmeragroup/deck-core/deck/slide-id";
import { Alert } from "@elmeragroup/fuse/alert";
import { Button } from "@elmeragroup/fuse/button";
import { Kbd, KbdGroup } from "@elmeragroup/fuse/kbd";
import { Sheet } from "@elmeragroup/fuse/sheet";
import { Sidebar } from "@elmeragroup/fuse/sidebar";
import { Tabs } from "@elmeragroup/fuse/tabs";

import type { OpenDeck } from "../../contract/studio-rpc.ts";
import { AgentChat } from "../components/agent-chat.tsx";
import { ChangesView } from "../components/changes-view.tsx";
import { Preview, showSlide } from "../components/preview.tsx";
import { RenderBoundary } from "../components/render-boundary.tsx";
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
type CenterTab = "preview" | "source" | "changes";

/** The width from which the chat is a panel beside the deck; below it, a sheet over it (Fuse's `lg`). */
const WIDE_QUERY = "(min-width: 64rem)";

/** Where the chat panel's open state is kept between launches, per viewer. */
const PANEL_KEY = "fuse-deck-studio:agent-panel";

/** Whether the window is at least Fuse's `lg` wide. */
function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE_QUERY);
      query.addEventListener("change", onChange);
      return () => {
        query.removeEventListener("change", onChange);
      };
    },
    () => window.matchMedia(WIDE_QUERY).matches
  );
}

/** The chat panel's open state, kept in local storage when the page may use it. */
function usePanelOpen(): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(PANEL_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(PANEL_KEY, next ? "open" : "closed");
    } catch {
      // A page without storage keeps the state for this session only.
    }
  }, []);
  return [open, set];
}

/** Whether a key event is the chat panel's shortcut, Cmd+J or Ctrl+J. */
function isPanelShortcut(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === "j" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
  );
}

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
 *
 * The agent chat is a panel on the right with its own open state, kept between launches, and a
 * shortcut, Cmd/Ctrl+J. Below Fuse's `lg` width it is a sheet over the deck, closed until asked for. While an agent turn runs, Source is
 * read-only. The Changes tab shows what changed on disk since the last turn started.
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
  const chat = deck !== null && snapshot.chat?.scopeId === deck.scopeId ? snapshot.chat : null;
  const wide = useWide();
  // The panel's state is kept; the sheet starts closed, so it never covers the deck unasked.
  const [panelOpen, setPanelOpen] = usePanelOpen();
  const [sheetOpen, setSheetOpen] = useState(false);
  const chatOpen = wide ? panelOpen : sheetOpen;
  const toggleChat = useCallback(() => {
    if (wide) {
      setPanelOpen(!panelOpen);
    } else {
      setSheetOpen(!sheetOpen);
    }
  }, [wide, panelOpen, setPanelOpen, sheetOpen]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isPanelShortcut(event)) {
        event.preventDefault();
        toggleChat();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [toggleChat]);
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
            setTab(value === "source" ? "source" : value === "changes" ? "changes" : "preview");
          }}>
          <div className="studio-center-bar">
            <Tabs.List aria-label="Deck view">
              <Tabs.Trigger value="preview">Preview</Tabs.Trigger>
              <Tabs.Trigger value="source">Source</Tabs.Trigger>
              <Tabs.Trigger value="changes">Changes</Tabs.Trigger>
            </Tabs.List>
            <div className="studio-center-actions">
              <Button size="sm" variant="outline" onClick={present}>
                Present
              </Button>
              <Button
                size="sm"
                variant={chatOpen ? "secondary" : "outline"}
                aria-expanded={chatOpen}
                aria-controls={wide && chatOpen ? "studio-agent-panel" : undefined}
                aria-keyshortcuts="Meta+J Control+J"
                onClick={toggleChat}>
                Agent
                <KbdGroup aria-hidden="true">
                  <Kbd>⌘</Kbd>
                  <Kbd>J</Kbd>
                </KbdGroup>
              </Button>
            </div>
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
              agentTurn={chat?.turn ?? "Idle"}
              onUnsavedDraft={setUnsavedDraft}
            />
          </Tabs.Content>
          <Tabs.Content value="changes" keepMounted className="studio-changes-panel">
            <RenderBoundary key={deck.scopeId} label="The Changes tab">
              <ChangesView deck={deck} active={tab === "changes"} turn={chat?.turn ?? "Idle"} />
            </RenderBoundary>
          </Tabs.Content>
        </Tabs.Root>
      </Sidebar.Inset>
      {wide ? (
        panelOpen ? (
          <aside id="studio-agent-panel" className="studio-agent-panel" aria-label="Agent chat">
            <RenderBoundary key={deck.scopeId} label="The agent chat">
              <AgentChat deck={deck} chat={chat} position={position} />
            </RenderBoundary>
          </aside>
        ) : null
      ) : (
        <Sheet.Root open={sheetOpen} onOpenChange={setSheetOpen}>
          <Sheet.Content className="studio-agent-sheet">
            <Sheet.Header>
              <Sheet.Title>Agent chat</Sheet.Title>
            </Sheet.Header>
            <Sheet.Body className="studio-agent-sheet-body">
              <RenderBoundary key={deck.scopeId} label="The agent chat">
                <AgentChat deck={deck} chat={chat} position={position} />
              </RenderBoundary>
            </Sheet.Body>
          </Sheet.Content>
        </Sheet.Root>
      )}
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
