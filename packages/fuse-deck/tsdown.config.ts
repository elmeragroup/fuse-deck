import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "tsdown";

/** deck-core's built runtime, which this package ships as its own `dist/runtime`. */
const deckCoreRuntime = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@elmeragroup/deck-core/package.json")),
  "dist",
  "runtime"
);

export default defineConfig({
  // The command line, bundled for Node, with deck-core inlined: deck-core is private and never
  // published. Every other dependency stays external, so the packed package installs it, and
  // `onlyBundle` fails the build when deck-core imports a package this one does not list in
  // `dependencies`. `package.json` is inlined for `--version`.
  entry: { bin: "src/bin.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  fixedExtension: true,
  dts: false,
  clean: true,
  deps: {
    alwaysBundle: [/^@elmeragroup\/deck-core(?:\/.*)?$/],
    onlyBundle: [],
  },
  copy: [{ from: deckCoreRuntime, to: "dist" }],
});
