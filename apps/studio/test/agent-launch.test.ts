import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import path from "node:path";

import { AgentLaunch, trustedPath } from "../src/server/agent-launch.ts";
import { seedAdapter } from "./agent.ts";

/** A deck path for launches that never look inside it. */
const DECK = "/nonexistent/deck";

/** The launch settings in a fresh user data directory holding `settings`, if any, and the adapter. */
const launchWith = Effect.fn("launchWith")(function* (settings: string | null) {
  const fs = yield* FileSystem.FileSystem;
  const userData = yield* fs.makeTempDirectoryScoped({ prefix: "fuse-deck-studio-launch-" });
  if (settings !== null) {
    yield* fs.writeFileString(path.join(userData, "settings.json"), settings);
  }
  // The pinned adapter, installed as npm installs it, so no test reaches the registry.
  const entry = yield* seedAdapter(userData, "process.exit(0);\n");
  const services = yield* Layer.build(AgentLaunch.layerWithPath(userData, "/usr/bin:/bin"));
  return { launch: Context.get(services, AgentLaunch), userData, entry };
});

describe("AgentLaunch", () => {
  it.live(
    "runs the installed pinned claude-acp adapter on the backend's own Node, from the agent directory",
    () =>
      Effect.gen(function* () {
        const { launch, userData, entry } = yield* launchWith(null);
        assert.deepStrictEqual(yield* launch.command(DECK), {
          command: process.execPath,
          args: [entry],
          cwd: path.join(userData, "agent"),
          sessionsDirectory: path.join(userData, "agent-sessions"),
          env: { ELECTRON_RUN_AS_NODE: undefined },
          pathVariable: "/usr/bin:/bin",
          protocolLog: Option.none(),
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("runs the local command settings.json names from the agent directory, and logs where it says", () =>
    Effect.gen(function* () {
      const { launch, userData } = yield* launchWith(
        '{"agent":{"command":"/opt/agent/bin/agent","args":["--acp"],"protocolLog":"/tmp/acp.log"}}'
      );
      assert.deepStrictEqual(yield* launch.command(DECK), {
        command: "/opt/agent/bin/agent",
        args: ["--acp"],
        cwd: path.join(userData, "agent"),
        sessionsDirectory: path.join(userData, "agent-sessions"),
        env: { ELECTRON_RUN_AS_NODE: undefined },
        pathVariable: "/usr/bin:/bin",
        protocolLog: Option.some("/tmp/acp.log"),
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("falls back to the adapter when settings.json does not decode", () =>
    Effect.gen(function* () {
      const { launch } = yield* launchWith('{"agent":{"command":7}}');
      assert.strictEqual((yield* launch.command(DECK)).command, process.execPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("installs again over an install that was cut short, rather than run its entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const userData = yield* fs.makeTempDirectoryScoped({ prefix: "fuse-deck-studio-launch-" });
      yield* seedAdapter(userData, "process.exit(0);\n", "CutShort");
      // No npm on this PATH, so the install that must run fails without the registry.
      const services = yield* Layer.build(AgentLaunch.layerWithPath(userData, "/nonexistent"));
      const launched = yield* Effect.result(Context.get(services, AgentLaunch).command(DECK));
      assert.strictEqual(
        launched._tag === "Failure" ? launched.failure._tag : "Launched",
        "AgentInstallFailed"
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  /** A deck whose `bin` holds an `npm` that writes `sentinel`, an alias of that `bin`, and a bin outside. */
  const deckBin = Effect.fn("deckBin")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "fuse-deck-studio-path-" }));
    const deck = path.join(root, "talk");
    const sentinel = path.join(root, "deck-npm-ran");
    yield* fs.makeDirectory(path.join(deck, "bin"), { recursive: true });
    yield* fs.makeDirectory(path.join(root, "outside", "bin"), { recursive: true });
    yield* fs.writeFileString(path.join(deck, "bin", "npm"), `#!/bin/sh\ntouch ${sentinel}\nexit 1\n`);
    yield* fs.chmod(path.join(deck, "bin", "npm"), 0o755);
    yield* fs.symlink(path.join(deck, "bin"), path.join(root, "alias"));
    return { root, deck, sentinel };
  });

  it.live("keeps only PATH entries whose real path exists outside the deck", () =>
    Effect.gen(function* () {
      const { root, deck } = yield* deckBin();
      const pathVariable = [
        "node_modules/.bin",
        ".",
        "",
        path.join(deck, "bin"),
        path.join(root, "alias"),
        path.join(root, "missing"),
        path.join(root, "outside", "bin"),
      ].join(path.delimiter);
      assert.strictEqual(yield* trustedPath(pathVariable, deck), path.join(root, "outside", "bin"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live.each(["the deck's bin", "an alias of the deck's bin"])(
    "installs the adapter with no npm from %s",
    (name) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, deck, sentinel } = yield* deckBin();
        const userData = yield* fs.makeTempDirectoryScoped({ prefix: "fuse-deck-studio-launch-" });
        const entry = name === "the deck's bin" ? path.join(deck, "bin") : path.join(root, "alias");
        // No adapter is installed, so the launch installs it; no npm is left on this PATH.
        const services = yield* Layer.build(
          AgentLaunch.layerWithPath(userData, [entry, "/usr/bin", "/bin"].join(path.delimiter))
        );
        const launched = yield* Effect.result(Context.get(services, AgentLaunch).command(deck));
        assert.deepStrictEqual(
          {
            outcome: launched._tag === "Failure" ? launched.failure._tag : "Launched",
            deckNpmRan: yield* fs.exists(sentinel),
          },
          { outcome: "AgentInstallFailed", deckNpmRan: false }
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
