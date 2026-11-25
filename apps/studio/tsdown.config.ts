import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "tsdown";

/** deck-core's built runtime, which the backend serves to every deck as its own `dist/runtime`. */
const deckCoreRuntime = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@elmeragroup/deck-core/package.json")),
  "dist",
  "runtime"
);

export default defineConfig({
  // The backend, bundled for Node with deck-core inlined, as fuse-deck's CLI is. Every other
  // dependency stays external, so the staged install provides it, and `onlyBundle` fails the
  // build when deck-core imports a package this one does not list in `dependencies`. The renderer
  // is Vite's (vite.config.ts).
  entry: { "server/bin": "src/server/bin.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  fixedExtension: true,
  dts: false,
  clean: false,
  deps: {
    alwaysBundle: [/^@elmeragroup\/deck-core(?:\/.*)?$/],
    onlyBundle: [],
  },
  copy: [{ from: deckCoreRuntime, to: "dist" }],
});
