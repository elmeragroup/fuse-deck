import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "tsdown";
import type { UserConfig } from "tsdown";

/** The studio's built renderer, which the app serves on its scheme from `dist/renderer`. */
const studioRenderer = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@elmeragroup/fuse-deck-studio/package.json")),
  "dist",
  "renderer"
);

// The build script empties dist first; the configs share dist/electron, so none of them cleans.
// Electron loads CommonJS from `main`. Every dependency is bundled, so the packaged app carries no
// node_modules; only `electron` stays external. Rolldown's code splitting stays off, so each entry
// is one file.
const electronMain = {
  format: "cjs",
  platform: "node",
  outDir: "dist/electron",
  fixedExtension: true,
  dts: false,
  clean: false,
  outputOptions: { codeSplitting: false },
  deps: { alwaysBundle: [/.*/], neverBundle: ["electron"] },
} satisfies UserConfig;

export default defineConfig([
  // `boot` requires the other two at run time, as in t3code, so the compile cache is on before the
  // main bundle loads.
  {
    ...electronMain,
    entry: { boot: "src/boot.ts", compileCache: "src/compileCache.ts" },
    outputOptions: {},
    deps: { neverBundle: ["./compileCache.cjs", "./main.cjs"] },
  },
  { ...electronMain, entry: { main: "src/main.ts" } },
  // The sandboxed preload can require only `electron`, so the channel names are inlined. The
  // renderer is the studio's, copied in beside the bundles.
  { ...electronMain, entry: { preload: "src/preload.ts" }, copy: [{ from: studioRenderer, to: "dist" }] },
]);
