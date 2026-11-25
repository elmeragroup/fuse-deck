import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { pollDeck } from "../src/bundler/deck-poll.ts";

/**
 * A deck with one slide, a file outside it, links in the deck to that file and its directory, and a
 * link to the slide itself.
 */
const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "fuse-deck-poll-"));
    const deck = path.join(parent, "talk");
    const outside = path.join(parent, "outside");
    await mkdir(path.join(deck, "slides"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(deck, "slides", "cover.mdx"), "# Talk\n");
    await writeFile(path.join(outside, "secret.txt"), "one\n");
    await symlink(path.join(outside, "secret.txt"), path.join(deck, "slides", "linked.mdx"));
    await symlink(outside, path.join(deck, "linked"));
    await symlink(path.join(deck, "slides", "cover.mdx"), path.join(deck, "slides", "alias.mdx"));
    return { parent, deck, outside };
  }),
  ({ parent }) => Effect.promise(() => rm(parent, { recursive: true, force: true }))
);

describe("pollDeck", () => {
  it.live("reports no file through a symlink in the deck, inside it or out", () =>
    Effect.gen(function* () {
      const { deck, outside } = yield* fixture;
      const reported: string[] = [];
      const cover = path.join(deck, "slides", "cover.mdx");
      const coverChanges = [yield* Deferred.make<void>(), yield* Deferred.make<void>()] as const;
      let changes = 0;
      yield* pollDeck(deck, (event, file) => {
        reported.push(`${event} ${path.relative(deck, file)}`);
        if (file === cover) {
          const change = coverChanges[changes];
          changes += 1;
          if (change !== undefined) {
            Deferred.doneUnsafe(change, Effect.void);
          }
        }
      });
      yield* Effect.promise(async () => {
        await writeFile(path.join(outside, "secret.txt"), "two, longer\n");
        await writeFile(path.join(outside, "new.txt"), "new\n");
        await writeFile(cover, "# Talk, edited\n");
      });
      // A scan stats files concurrently, so the one that saw the slide's first change may have
      // seen the outside file before its write. The scan that sees the second change started after
      // that one ended, so after the outside write.
      yield* Deferred.await(coverChanges[0]);
      yield* Effect.promise(() => writeFile(cover, "# Talk, edited again\n"));
      yield* Deferred.await(coverChanges[1]);
      assert.deepStrictEqual(reported, ["change slides/cover.mdx", "change slides/cover.mdx"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
