import { Button } from "@elmeragroup/fuse/button";
import { Empty } from "@elmeragroup/fuse/empty";

import { useStudio } from "../state/use-studio.ts";

/** No deck is open: open one with the system dialog, or pick a recent one. */
export function EmptyState() {
  const { client, snapshot } = useStudio();
  return (
    <main className="studio-empty">
      <Empty.Root>
        <Empty.Header>
          <Empty.Title role="heading" aria-level={1}>
            No deck open
          </Empty.Title>
          <Empty.Description>Open a deck directory, one that holds a deck.json.</Empty.Description>
        </Empty.Header>
        <Empty.Content>
          <Button onClick={client.pickDeck}>Open deck…</Button>
        </Empty.Content>
      </Empty.Root>
      {snapshot.recent.length > 0 ? (
        <section aria-labelledby="recent-decks" className="studio-recent">
          <h2 id="recent-decks">Recent decks</h2>
          <ul>
            {snapshot.recent.map((deck) => (
              <li key={deck.root}>
                <Button
                  variant="ghost"
                  className="studio-recent-deck"
                  onClick={() => {
                    client.openDeck(deck.root);
                  }}>
                  <span className="studio-recent-title">{deck.title}</span>
                  <span className="studio-recent-root">{deck.root}</span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
