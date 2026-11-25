import { defineConfig } from "tsdown";
import type { UserConfig } from "tsdown";

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
  // The sandboxed preload can require only `electron`, so the channel names are inlined.
  { ...electronMain, entry: { preload: "src/preload.ts" } },
  {
    entry: { stub: "src/renderer/stub.ts" },
    outDir: "dist/renderer",
    format: "esm",
    platform: "browser",
    clean: false,
    tsconfig: "tsconfig.renderer.json",
    dts: false,
    copy: [
      { from: "src/renderer/index.html", to: "dist/renderer" },
      { from: "src/renderer/stub.css", to: "dist/renderer" },
    ],
  },
]);
