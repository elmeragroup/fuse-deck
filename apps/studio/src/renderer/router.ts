/**
 * The renderer's router, after t3code's `apps/web/src/router.ts`. t3code generates its route
 * tree with TanStack's file-route plugin; the studio has two routes, so it writes the tree out
 * here and keeps kebab-case file names.
 */

import { createHashHistory, createRouter } from "@tanstack/react-router";

import { deckRoute } from "./routes/deck.tsx";
import { homeRoute } from "./routes/home.tsx";
import { rootRoute } from "./routes/root.tsx";

const routeTree = rootRoute.addChildren([homeRoute, deckRoute]);

/**
 * The studio's router. Routes live in the address's hash, so the page works the same on the app
 * scheme, behind the dev proxy and from a static test server.
 *
 * @returns The router.
 */
export function createStudioRouter() {
  return createRouter({ routeTree, history: createHashHistory() });
}

declare module "@tanstack/react-router" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- TanStack's router registers through interface merging
  interface Register {
    router: ReturnType<typeof createStudioRouter>;
  }
}
