/**
 * The Changes tab: the deck files whose text differs from the snapshot the backend took when the
 * last agent turn started, as observed changes. It reads them again when it shows, when the deck's
 * watcher reports an edit and when a turn starts or ends. There is no undo.
 */

import { useEffect, useState } from "react";

import { Alert } from "@elmeragroup/fuse/alert";

import type { AgentTurn, ObservedChanges } from "../../contract/agent-chat.ts";
import type { OpenDeck } from "../../contract/studio-rpc.ts";
import { useStudio } from "../state/use-studio.ts";
import { FileChangeView } from "./diff-view.tsx";
import { RenderBoundary } from "./render-boundary.tsx";

type Loaded =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Read"; readonly changes: ObservedChanges }
  | { readonly _tag: "Failed"; readonly message: string };

/** The observed changes since the last turn started. */
export function ChangesView({
  deck,
  active,
  turn,
}: {
  readonly deck: OpenDeck;
  /** Whether the tab shows; a hidden tab reads nothing. */
  readonly active: boolean;
  /** The agent's turn, whose start and end read the changes again. */
  readonly turn: AgentTurn;
}) {
  const { client, snapshot } = useStudio();
  const [loaded, setLoaded] = useState<Loaded>({ _tag: "Loading" });
  const serial = snapshot.diskChange?.scopeId === deck.scopeId ? snapshot.diskChange.serial : 0;

  useEffect(() => {
    if (!active) {
      return;
    }
    let current = true;
    void client.listChanges(deck.scopeId).then((outcome) => {
      if (current) {
        setLoaded(outcome);
      }
    });
    return () => {
      current = false;
    };
  }, [client, deck.scopeId, active, serial, turn]);

  if (loaded._tag === "Loading") {
    return (
      <div className="studio-changes" aria-busy="true">
        <p className="studio-changes-message">Reading the deck…</p>
      </div>
    );
  }
  if (loaded._tag === "Failed") {
    return (
      <div className="studio-changes">
        <Alert.Root variant="destructive" role="none">
          <Alert.Title level={2}>The changes cannot be read</Alert.Title>
          <Alert.Description>{loaded.message}</Alert.Description>
        </Alert.Root>
      </div>
    );
  }
  const { changes } = loaded;
  return (
    <div className="studio-changes">
      <h2 className="studio-changes-heading">Observed changes</h2>
      <p className="studio-changes-message">
        {changes.turn === null
          ? "No agent turn has started yet. Once one starts, this tab shows the deck files that differ from how they were at its start."
          : changes.files.length === 0
            ? `No deck file differs from how it was when turn ${String(changes.turn)} started.`
            : `Deck files that differ on disk from how they were when turn ${String(changes.turn)} started, whoever changed them. There is no undo.`}
      </p>
      {changes.files.map((file) => (
        <section key={file.path} className="studio-changes-file" aria-label={file.path}>
          <RenderBoundary label="This diff">
            <FileChangeView name={file.path} before={file.before} after={file.after} />
          </RenderBoundary>
        </section>
      ))}
    </div>
  );
}
