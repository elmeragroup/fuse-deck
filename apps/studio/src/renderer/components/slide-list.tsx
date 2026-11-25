import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";

import type { SlideId } from "@elmeragroup/deck-core/deck/slide-id";
import { Button } from "@elmeragroup/fuse/button";
import { Kbd, KbdGroup } from "@elmeragroup/fuse/kbd";
import { Sidebar } from "@elmeragroup/fuse/sidebar";

import type { MovePosition, OpenDeck } from "../../contract/studio-rpc.ts";
import { useStudio } from "../state/use-studio.ts";

/** The move Alt with an arrow key asks for: before the slide above, or after the slide below. */
function moveFor(event: KeyboardEvent, index: number, ids: ReadonlyArray<SlideId>): MovePosition | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (event.key === "ArrowUp") {
    const above = ids[index - 1];
    return above === undefined ? null : { _tag: "Before", anchor: above };
  }
  if (event.key === "ArrowDown") {
    const below = ids[index + 1];
    return below === undefined ? null : { _tag: "After", anchor: below };
  }
  return null;
}

/** A moved row that takes focus back once the list shows it at its new place. */
type PendingFocus = { readonly id: SlideId; readonly index: number };

/**
 * The open deck's slides in a Fuse Sidebar. The row of the slide the preview shows is current.
 * A row shows its slide in the preview; Alt+ArrowUp and Alt+ArrowDown move it in the order. Focus
 * stays on the moved row unless it went elsewhere before the list showed the move; a move that
 * fails gives nothing focus later.
 */
export function SlideList({
  deck,
  onShow,
  onOpenDeck,
  onCloseDeck,
}: {
  readonly deck: OpenDeck;
  readonly onShow: (slideId: SlideId) => void;
  /** Open another deck; the workspace asks first when a draft would be dropped. */
  readonly onOpenDeck: () => void;
  /** Close this deck; the workspace asks first when a draft would be dropped. */
  readonly onCloseDeck: () => void;
}) {
  const { client, snapshot } = useStudio();
  const list = snapshot.slides?.scopeId === deck.scopeId ? snapshot.slides.slides : null;
  const current = snapshot.position?.scopeId === deck.scopeId ? snapshot.position.slideId : null;
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<PendingFocus | null>(null);

  // Focus that lands anywhere but the moved row before the move shows wins over the move.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const pending = pendingFocus.current;
      if (pending !== null && event.target !== rows.current.get(pending.id)) {
        pendingFocus.current = null;
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null || list === null) {
      return;
    }
    // A list without the move, after another edit, leaves the focus to come.
    if (list.findIndex(({ id }) => id === pending.id) === pending.index) {
      return;
    }
    pendingFocus.current = null;
    const row = rows.current.get(pending.id);
    // React moves the row's element to reorder it, and a moved element loses focus to the body.
    // Focus that went into the preview or another control stays there.
    const active = document.activeElement;
    if (row !== undefined && (active === row || active === null || active === document.body)) {
      row.focus();
    }
  }, [list]);

  const ids = list?.map(({ id }) => id) ?? [];

  return (
    <Sidebar.Root collapsible="none" className="studio-sidebar">
      <Sidebar.Header className="studio-sidebar-header">
        <h1 className="studio-deck-title">{deck.title}</h1>
        <div className="studio-deck-actions">
          <Button variant="ghost" size="sm" onClick={onOpenDeck}>
            Open…
          </Button>
          <Button variant="ghost" size="sm" onClick={onCloseDeck}>
            Close
          </Button>
        </div>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.GroupLabel id="slides-label">Slides</Sidebar.GroupLabel>
          <Sidebar.GroupContent>
            {list === null ? (
              <p className="studio-sidebar-loading">Loading slides…</p>
            ) : (
              <Sidebar.Menu aria-labelledby="slides-label">
                {list.map((slide, index) => (
                  <Sidebar.MenuItem key={slide.id}>
                    <Sidebar.MenuButton
                      ref={(element: HTMLButtonElement | null) => {
                        if (element === null) {
                          rows.current.delete(slide.id);
                        } else {
                          rows.current.set(slide.id, element);
                        }
                      }}
                      isActive={slide.id === current}
                      aria-current={slide.id === current ? "true" : undefined}
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                      onClick={() => {
                        onShow(slide.id);
                      }}
                      onKeyDown={(event: KeyboardEvent) => {
                        const move = moveFor(event, index, ids);
                        if (move !== null) {
                          event.preventDefault();
                          const pending = { id: slide.id, index };
                          pendingFocus.current = pending;
                          void client.moveSlide(slide.id, move).then((outcome) => {
                            if (outcome._tag === "NotMoved" && pendingFocus.current === pending) {
                              pendingFocus.current = null;
                            }
                          });
                        }
                      }}>
                      <span className="studio-slide-number" aria-hidden="true">
                        {String(index + 1)}
                      </span>
                      <span className="studio-slide-title">{slide.title ?? slide.id}</span>
                    </Sidebar.MenuButton>
                  </Sidebar.MenuItem>
                ))}
              </Sidebar.Menu>
            )}
          </Sidebar.GroupContent>
        </Sidebar.Group>
      </Sidebar.Content>
      <Sidebar.Footer className="studio-sidebar-footer">
        <KbdGroup aria-hidden="true">
          <Kbd>Alt</Kbd>
          <Kbd>↑</Kbd>
        </KbdGroup>
        <KbdGroup aria-hidden="true">
          <Kbd>Alt</Kbd>
          <Kbd>↓</Kbd>
        </KbdGroup>
        <span>move the slide</span>
      </Sidebar.Footer>
    </Sidebar.Root>
  );
}
