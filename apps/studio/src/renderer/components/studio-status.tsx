import type { Connection } from "../state/studio-client.ts";
import { useStudio } from "../state/use-studio.ts";

function changes(count: number): string {
  return `${String(count)} ${count === 1 ? "change" : "changes"}`;
}

/** What the status line says about the connection and the open deck, or nothing when all is settled. */
function statusText(connection: Connection): string {
  switch (connection._tag) {
    case "Connecting":
      return "Connecting to the studio backend…";
    case "Reconnecting":
      return `The studio backend is not reachable (${connection.reason}). Reconnecting…`;
    case "Connected": {
      const { studio } = connection;
      switch (studio._tag) {
        case "Empty":
          return "";
        case "Opening":
          return `Opening ${studio.path}…`;
        case "Open":
          return studio.admitted === 0 ? "" : `Saving ${changes(studio.admitted)} to ${studio.deck.title}…`;
        case "Closing":
          return studio.admitted === 0
            ? `Closing ${studio.deck.title}…`
            : `Finishing ${changes(studio.admitted)} on ${studio.deck.title} before closing it…`;
      }
    }
  }
}

/** The status line, and the last notice. Screen readers hear both as they change. */
export function StudioStatus() {
  const { snapshot } = useStudio();
  return (
    <div className="studio-status">
      <p role="status" className="studio-status-line">
        {statusText(snapshot.connection)}
      </p>
      <p aria-live="polite" className="studio-notice">
        {snapshot.notice ?? ""}
      </p>
    </div>
  );
}
