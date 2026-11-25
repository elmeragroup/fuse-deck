/**
 * The studio's agent chats for tests, driving the scripted mock agent in `fixtures/mock-agent.ts`
 * through the local-command setting, as a user's `settings.json` would name a local agent.
 */

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import path from "node:path";

import { AgentChats } from "../src/server/agent-chats.ts";
import {
  AGENT_DIRECTORY,
  AgentLaunch,
  CLAUDE_ACP_PACKAGE,
  CLAUDE_ACP_VERSION,
  INSTALLED_MARKER,
  SETTINGS_FILE,
} from "../src/server/agent-launch.ts";

/** The scripted agent, which Node runs from source. */
export const MOCK_AGENT = path.join(import.meta.dirname, "fixtures", "mock-agent.ts");

/** How the mock agent behaves; see `fixtures/mock-agent.ts`. */
export type MockAgentOptions = {
  readonly embedded?: boolean;
  readonly mode?: "normal" | "stuck" | "none";
  /** The file the agent appends `start <pid>`, `prompt` and `cancel` lines to. */
  readonly log?: string;
  /** How long after Stop the agent may take; the app's 15 s by default. */
  readonly stopDeadline?: Duration.Duration;
};

const encodeSettings = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ agent: Schema.Struct({ command: Schema.String, args: Schema.Array(Schema.String) }) })
  )
);

/** Write a `settings.json` into `userData` that names the mock agent as the local agent command. */
export const writeMockSettings = Effect.fn("writeMockSettings")(function* (
  userData: string,
  options: MockAgentOptions = {}
) {
  const fs = yield* FileSystem.FileSystem;
  const args = [
    MOCK_AGENT,
    ...(options.embedded === true ? ["--embedded"] : []),
    ...(options.mode === undefined ? [] : [`--mode=${options.mode}`]),
    ...(options.log === undefined ? [] : [`--log=${options.log}`]),
  ];
  yield* fs.makeDirectory(userData, { recursive: true });
  const settings = yield* encodeSettings({ agent: { command: process.execPath, args } });
  yield* fs.writeFileString(path.join(userData, SETTINGS_FILE), `${settings}\n`);
});

/**
 * The chats, reading the agent command from `userData`'s settings, with this process's PATH.
 *
 * @param userData - The user data directory holding `settings.json`.
 * @param stopDeadline - How long after Stop the agent may take.
 */
export function mockAgentChats(userData: string, stopDeadline = Duration.seconds(15)) {
  return AgentChats.layer({ stopDeadline }).pipe(
    Layer.provide(AgentLaunch.layerWithPath(userData, process.env.PATH ?? "/usr/bin:/bin"))
  );
}

const encodeAdapterManifest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      bin: Schema.Record(Schema.String, Schema.String),
    })
  )
);

/**
 * Install `entry` as the pinned claude-acp adapter in `userData`'s agent directory, laid out as
 * npm lays it out, so a test launches the adapter without the registry.
 *
 * @param userData - The user data directory.
 * @param entry - The adapter's entry file, CommonJS.
 * @param install - Whether npm finished, which records the install, or was cut short.
 * @returns The entry file's path.
 */
export const seedAdapter = Effect.fn("seedAdapter")(function* (
  userData: string,
  entry: string,
  install: "Complete" | "CutShort" = "Complete"
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = path.join(userData, AGENT_DIRECTORY, "node_modules", ...CLAUDE_ACP_PACKAGE.split("/"));
  yield* fs.makeDirectory(path.join(directory, "dist"), { recursive: true });
  const manifest = yield* encodeAdapterManifest({
    name: CLAUDE_ACP_PACKAGE,
    version: CLAUDE_ACP_VERSION,
    bin: { "claude-agent-acp": "dist/index.js" },
  });
  yield* fs.writeFileString(path.join(directory, "package.json"), `${manifest}\n`);
  const file = path.join(directory, "dist", "index.js");
  yield* fs.writeFileString(file, entry);
  if (install === "Complete") {
    yield* fs.writeFileString(
      path.join(userData, AGENT_DIRECTORY, INSTALLED_MARKER),
      `${CLAUDE_ACP_VERSION}\n`
    );
  }
  return file;
});
