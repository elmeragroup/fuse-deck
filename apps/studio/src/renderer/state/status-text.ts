/**
 * What the status line says about the connection and the open deck. Only writes to the deck count
 * as saves; a read is not announced.
 */

import type { Connection } from "./studio-client.ts";

function changes(count: number): string {
  return `${String(count)} ${count === 1 ? "change" : "changes"}`;
}

/**
 * The status line's text for `connection`.
 *
 * @param connection - Where the connection to the backend stands.
 * @returns The text, or an empty string when all is settled.
 */
export function statusText(connection: Connection): string {
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
        // Reads, such as opening a slide's source, are not announced.
        case "Open":
          return studio.writing === 0 ? "" : `Saving ${changes(studio.writing)} to ${studio.deck.title}…`;
        case "Closing":
          return studio.writing === 0
            ? `Closing ${studio.deck.title}…`
            : `Finishing ${changes(studio.writing)} on ${studio.deck.title} before closing it…`;
      }
    }
  }
}
