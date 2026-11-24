/**
 * Vite's dev server admits a request whose path lies lexically under the deck (or its `public`
 * directory) and follows symlinks when it opens the file, for static files and for modules alike.
 * A deck that ships a symlinked file or directory would let its own page read a file outside the
 * deck. This plugin answers such a request with 403 before any of Vite's middlewares sees it.
 */

import { lstatSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Plugin } from "vite";

import { containedFile, isInside } from "../deck/contained-file.ts";

/** The decoded path a request names, or none when it does not decode. */
function requestPath(request: IncomingMessage): string | undefined {
  try {
    return decodeURIComponent(new URL(request.url ?? "/", "http://deck.invalid").pathname);
  } catch {
    return undefined;
  }
}

/** Whether anything, a dangling symlink included, exists at `file`. */
function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a request reaches a path under the deck that is not a regular file or a directory inside
 * it. A path Vite serves from `/@fs/` is checked when it lies under the deck; any other `/@fs/` path
 * is left to Vite's `server.fs.allow`.
 *
 * @param root - The deck's canonical root.
 * @param pathname - The request's decoded path.
 * @returns Whether the request must be refused.
 */
function leavesDeck(root: string, pathname: string): boolean {
  const candidates = pathname.startsWith("/@fs/")
    ? [pathname.slice("/@fs".length)]
    : [path.join(root, pathname), path.join(root, "public", pathname)];
  return candidates.some((candidate) => {
    if (!isInside(root, path.resolve(candidate)) || !exists(candidate)) {
      return false;
    }
    const contained = containedFile(root, candidate);
    switch (contained._tag) {
      case "ContainedFile":
        return false;
      case "Missing":
      case "OutsideDeck":
        return true;
      case "NotAFile":
        // A directory inside the deck is Vite's to answer; it serves no listing.
        return !isDirectory(contained.real);
    }
  });
}

function isDirectory(file: string): boolean {
  try {
    return lstatSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The plugin that keeps the dev server inside the deck.
 *
 * @param root - The deck's root.
 * @returns The plugin.
 */
export function containedServingPlugin(root: string): Plugin {
  const realRoot = realpathSync(root);
  return {
    name: "fuse-deck:contained-serving",
    configureServer(server) {
      // Added here, before Vite adds its own, so it runs first.
      server.middlewares.use((request: IncomingMessage, response: ServerResponse, next: () => void) => {
        const pathname = requestPath(request);
        if (pathname !== undefined && !leavesDeck(realRoot, pathname)) {
          next();
          return;
        }
        response.statusCode = 403;
        response.end("fuse-deck serves only files inside the deck.");
      });
    },
  };
}
