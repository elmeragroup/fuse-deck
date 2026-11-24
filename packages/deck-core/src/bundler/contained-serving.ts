/**
 * Vite's dev server admits a request whose path lies lexically under the deck (or its `public`
 * directory) and follows symbolic links when it opens the file, for static files and for modules
 * alike. A deck holds no links (see `contained-file.ts`), and one made after the deck opened must
 * not let its page read through it, to a file outside the deck or inside it. This plugin answers
 * such a request with 403 before any of Vite's middlewares sees it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Plugin } from "vite";

import { deckEntrySync } from "../deck/contained-file.ts";

/** The decoded path a request names, or none when it does not decode. */
function requestPath(request: IncomingMessage): string | undefined {
  try {
    return decodeURIComponent(new URL(request.url ?? "/", "http://deck.invalid").pathname);
  } catch {
    return undefined;
  }
}

/**
 * Whether a request reaches a deck path that is a link, passes through one, or is neither a
 * regular file nor a directory. A path Vite serves from `/@fs/` is checked when it lies under the
 * deck; any other `/@fs/` path is left to Vite's `server.fs.allow`. A path that does not exist is
 * Vite's to answer.
 *
 * @param root - The deck's root.
 * @param pathname - The request's decoded path.
 * @returns Whether the request must be refused.
 */
function refused(root: string, pathname: string): boolean {
  const candidates = pathname.startsWith("/@fs/")
    ? [pathname.slice("/@fs".length)]
    : [path.join(root, pathname), path.join(root, "public", pathname)];
  return candidates.some((candidate) => {
    const entry = deckEntrySync(root, candidate, ["File", "Directory"]);
    return entry._tag === "Link" || entry._tag === "WrongKind";
  });
}

/**
 * The plugin that keeps the dev server inside the deck.
 *
 * @param root - The deck's root.
 * @returns The plugin.
 */
export function containedServingPlugin(root: string): Plugin {
  return {
    name: "fuse-deck:contained-serving",
    configureServer(server) {
      // Added here, before Vite adds its own, so it runs first.
      server.middlewares.use((request: IncomingMessage, response: ServerResponse, next: () => void) => {
        const pathname = requestPath(request);
        if (pathname !== undefined && !refused(root, pathname)) {
          next();
          return;
        }
        response.statusCode = 403;
        response.end("fuse-deck serves only the deck's own files, and a deck holds no symbolic links.");
      });
    },
  };
}
