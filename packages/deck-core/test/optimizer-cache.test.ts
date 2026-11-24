import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { optimizerCache } from "../src/bundler/optimizer-cache.ts";

/** The time every fixture file starts with. */
const FIXED_TIME = new Date("2026-01-01T00:00:00Z");

/**
 * A deck and an install in a temporary parent. The install holds `react` 19.2.1 and fuse-deck with
 * its runtime, and `lockfile`, when given, at its top.
 */
const fixture = (lockfile: Option.Option<string>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const parent = await mkdtemp(path.join(tmpdir(), "fuse-deck-cache-"));
      const deck = path.join(parent, "talk");
      const cacheRoot = path.join(parent, "user-cache");
      const install = path.join(parent, "install");
      const root = path.join(install, "node_modules", "react");
      const fuseDeck = path.join(install, "node_modules", "@elmeragroup", "fuse-deck");
      await mkdir(deck, { recursive: true });
      await mkdir(path.join(parent, "other-talk"), { recursive: true });
      await mkdir(root, { recursive: true });
      const runtimeEntry = path.join(fuseDeck, "dist", "runtime", "main.js");
      await mkdir(path.dirname(runtimeEntry), { recursive: true });
      await writeFile(runtimeEntry, 'import "react";\n');
      await writeFile(path.join(root, "package.json"), '{"name":"react","version":"19.2.1"}');
      await writeFile(path.join(root, "index.js"), "module.exports = require('./cjs/react.js');\n");
      if (Option.isSome(lockfile)) {
        await writeFile(path.join(install, lockfile.value), "scheduler@0.27.0\n");
      }
      // Whole-second times, which `utimes` restores exactly, so a rewrite that keeps them leaves
      // every stamp equal and only the bytes can tell the files apart.
      const files = [runtimeEntry, path.join(root, "package.json"), path.join(root, "index.js")];
      if (Option.isSome(lockfile)) files.push(path.join(install, lockfile.value));
      for (const file of files) await utimes(file, FIXED_TIME, FIXED_TIME);
      return {
        parent,
        deck,
        cacheRoot,
        root,
        install,
        fuseDeck,
        runtimeEntry,
        inputs: {
          packages: [{ root, entry: path.join(root, "index.js") }],
          runtimeEntry,
          install: fuseDeck,
        },
      };
    }),
    ({ parent }) => Effect.promise(() => rm(parent, { recursive: true, force: true }))
  );

/** Write `text` to `file` and give it back the times it had, as an installer that normalizes them does. */
async function rewriteKeepingTimes(file: string, text: string): Promise<void> {
  const before = await stat(file);
  await writeFile(file, text);
  await utimes(file, before.atime, before.mtime);
}

describe("optimizerCache", () => {
  it.effect("names one directory in the host's cache while the install is unchanged", () =>
    Effect.gen(function* () {
      const { deck, cacheRoot, install, inputs } = yield* fixture(Option.some("package-lock.json"));
      const first = yield* optimizerCache(cacheRoot, deck, inputs);
      assert.strictEqual((yield* optimizerCache(cacheRoot, deck, inputs)).directory, first.directory);
      assert.strictEqual(path.dirname(first.directory), path.join(cacheRoot, "vite"));
      assert.deepStrictEqual(first.lockfile, Option.some(path.join(install, "package-lock.json")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("names another directory for another deck in the same cache", () =>
    Effect.gen(function* () {
      const { parent, deck, cacheRoot, inputs } = yield* fixture(Option.some("package-lock.json"));
      const other = path.join(parent, "other-talk");
      assert.notStrictEqual(
        (yield* optimizerCache(cacheRoot, other, inputs)).directory,
        (yield* optimizerCache(cacheRoot, deck, inputs)).directory
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect.each([
    {
      name: "an upgrade that keeps package.json's size and times",
      lockfile: "package-lock.json",
      change: ({ root }: { root: string }) =>
        rewriteKeepingTimes(path.join(root, "package.json"), '{"name":"react","version":"19.2.2"}'),
    },
    {
      name: "a reinstall that changes the entry",
      lockfile: "package-lock.json",
      change: ({ root }: { root: string }) =>
        writeFile(path.join(root, "index.js"), "module.exports = require('./cjs/react.production.js');\n"),
    },
    {
      name: "a fuse-deck upgrade that keeps the runtime's size and times",
      lockfile: "package-lock.json",
      change: ({ runtimeEntry }: { runtimeEntry: string }) =>
        rewriteKeepingTimes(runtimeEntry, 'import "rea_t";\n'),
    },
    ...["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"].map((lockfile) => ({
      name: `an update of a dependency's dependency that only ${lockfile} records`,
      lockfile,
      change: ({ install }: { install: string }) =>
        rewriteKeepingTimes(path.join(install, lockfile), "scheduler@0.27.1\n"),
    })),
  ])("names another directory after $name", ({ change, lockfile }) =>
    Effect.gen(function* () {
      // Oracle: Vite must not reuse what it optimized from the old files.
      const installed = yield* fixture(Option.some(lockfile));
      const { deck, cacheRoot, inputs } = installed;
      const before = yield* optimizerCache(cacheRoot, deck, inputs);
      yield* Effect.promise(() => change(installed));
      assert.notStrictEqual((yield* optimizerCache(cacheRoot, deck, inputs)).directory, before.directory);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("finds no lockfile for an install without one, so the start re-optimizes", () =>
    Effect.gen(function* () {
      const { deck, cacheRoot, inputs } = yield* fixture(Option.none());
      assert.isTrue(Option.isNone((yield* optimizerCache(cacheRoot, deck, inputs)).lockfile));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
