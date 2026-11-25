import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "tsdown";

/** deck-core's built runtime, which the backend serves to every deck as its own `dist/runtime`. */
const deckCoreRuntime = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@elmeragroup/deck-core/package.json")),
  "dist",
  "runtime"
);

/** fuse-deck's skill, which `describe` points an agent at. */
const fuseDeckSkill = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "packages",
  "fuse-deck",
  "skill",
  "SKILL.md"
);

/** What both builds share: Node ESM into `dist`, which the build script empties first. */
const node = {
  outDir: "dist",
  format: "esm",
  platform: "node",
  fixedExtension: true,
  dts: false,
  clean: false,
} as const;

export default defineConfig([
  {
    // The backend, bundled for Node with deck-core and effect-acp inlined, as fuse-deck's CLI
    // inlines deck-core. Every other dependency stays external, so the staged install provides it,
    // and `onlyBundle` fails the build when either imports a package this one does not list in
    // `dependencies`. The renderer is Vite's (vite.config.ts).
    ...node,
    entry: { "server/bin": "src/server/bin.ts" },
    deps: {
      alwaysBundle: [/^@elmeragroup\/deck-core(?:\/.*)?$/, /^@elmeragroup\/effect-acp(?:\/.*)?$/],
      onlyBundle: [],
    },
    copy: [
      { from: deckCoreRuntime, to: "dist" },
      // The skill the `describe` tool names, which ships with the backend.
      { from: fuseDeckSkill, to: "dist/skill" },
    ],
  },
  {
    // The MCP relay, a build of its own so it shares no chunk with the backend: it imports only
    // Effect, and an agent starts it for every session.
    ...node,
    entry: { "relay/bin": "src/relay/bin.ts" },
    deps: { onlyBundle: [] },
  },
]);
