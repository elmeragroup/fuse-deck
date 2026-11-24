import { defineConfig } from "tsdown";

export default defineConfig({
  // The browser runtime the deck's Vite build compiles again. React, the JSX runtimes, Fuse and the
  // deck manifest stay external, so each resolves once, through the deck's Vite config, and the page
  // never holds two Reacts. It imports no Effect and no Node API. fuse-deck copies this directory
  // into its own `dist`.
  entry: { main: "src/runtime/main.tsx" },
  outDir: "dist/runtime",
  format: "esm",
  platform: "browser",
  tsconfig: "tsconfig.runtime.json",
  dts: false,
  clean: true,
  deps: {
    neverBundle: [/^react(?:-dom)?(?:\/.*)?$/, /^@elmeragroup\/fuse(?:\/.*)?$/, "virtual:fuse-deck"],
  },
  copy: [{ from: "src/runtime/deck.css", to: "dist/runtime" }],
});
