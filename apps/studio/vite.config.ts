/**
 * The renderer's Vite config: the React app in `src/renderer`, built to `dist/renderer` and served
 * on 127.0.0.1:5733 in development, where the desktop app's dev proxy reaches it.
 *
 * Fuse's first paint comes from the same theme functions a deck's does (deck-core's
 * `fuse-theme.ts`): the theme's document attributes on `<html>`, and Fuse's color-scheme bootstrap
 * as the external `color-scheme.js`, since the window's Content-Security-Policy runs no inline
 * script.
 */

import react from "@vitejs/plugin-react";
import * as Effect from "effect/Effect";
import path from "node:path";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

import { firstPaint, loadFuseTheme } from "@elmeragroup/deck-core/bundler/fuse-theme";
import type { FirstPaint } from "@elmeragroup/deck-core/bundler/fuse-theme";

/** The Fuse theme and density the studio's own UI uses. */
const STUDIO_THEME = { theme: "neutral-elma-private", density: "dense" } as const;

/** The dev server's port, which the desktop app's dev proxy targets. */
export const RENDERER_DEV_PORT = 5733;

const COLOR_SCHEME_FILE = "color-scheme.js";

/** Stamp Fuse's document attributes on `<html>` and serve the color-scheme bootstrap as a file. */
function studioFirstPaint(): Plugin {
  let paint: FirstPaint | undefined;
  const load = async (root: string) => {
    paint ??= await Effect.runPromise(
      loadFuseTheme(root).pipe(Effect.flatMap((fuse) => firstPaint(fuse, STUDIO_THEME)))
    );
    return paint;
  };
  return {
    name: "studio:first-paint",
    async configResolved(config) {
      await load(config.root);
    },
    configureServer(server) {
      server.middlewares.use(`/${COLOR_SCHEME_FILE}`, (_request, response, next) => {
        load(server.config.root).then((loaded) => {
          response.setHeader("Content-Type", "text/javascript");
          response.end(loaded.bootstrap);
        }, next);
      });
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: COLOR_SCHEME_FILE,
        source: (await load(process.cwd())).bootstrap,
      });
    },
    transformIndexHtml: {
      order: "post",
      async handler(html, context) {
        const { attributes } = await load(context.server?.config.root ?? process.cwd());
        const stamped = Object.entries(attributes)
          .map(([name, value]) => ` ${name}="${value}"`)
          .join("");
        return html.replace(/<html\b([^>]*)>/i, `<html$1${stamped}>`);
      },
    },
  };
}

export default defineConfig({
  root: path.join(import.meta.dirname, "src", "renderer"),
  base: "./",
  envDir: false,
  plugins: [react(), studioFirstPaint()],
  build: {
    outDir: path.join(import.meta.dirname, "dist", "renderer"),
    emptyOutDir: true,
    // The app loads from disk or the dev server, never over a network, so one bundle is fine.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    host: "127.0.0.1",
    port: RENDERER_DEV_PORT,
    strictPort: true,
    // The page runs on the app scheme behind the desktop app's proxy, so the HMR client cannot
    // derive the socket from its own address; it connects to the dev server directly.
    hmr: { protocol: "ws", host: "127.0.0.1", port: RENDERER_DEV_PORT, clientPort: RENDERER_DEV_PORT },
  },
});
