// Derived from pingdotgg/t3code apps/desktop/src/compileCache.ts at 2fe7febc.
// MIT licence, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// Changes: drops the prepared backend cache (`server-compile-cache.ts`) and renames the cache
// directory.

// @effect-diagnostics nodeBuiltinImport:off -- Runs before main loads, with no Effect runtime.
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Linux /tmp is shared; macOS and Windows temp dirs are per user.
// AppImage mounts change paths each launch, so Node's path-keyed cache would miss and accumulate copies.
try {
  if (!process.env.APPIMAGE) {
    const cacheRoot =
      process.platform === "linux"
        ? process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache")
        : NodeOS.tmpdir();
    const directory = NodePath.join(cacheRoot, "fuse-deck-studio", "compile-cache");
    NodeModule.enableCompileCache(directory);
  }
} catch {}
