/**
 * How the studio launches its agent: the command, its working directory and the PATH it runs with.
 *
 * A deck is untrusted, so nothing about the launch comes from it. The command is the ACP registry's
 * pinned `claude-acp` adapter, installed with npm into a directory of the studio's own in the user
 * data directory, with install scripts off (neither the adapter nor its Claude Agent SDK has one),
 * and run from there by the backend's own Node: `process.execPath`, which in the desktop app is
 * Electron's binary with `ELECTRON_RUN_AS_NODE=1`. No `npx`, which would put a deck's
 * `node_modules/.bin` on PATH, and no `#!/usr/bin/env node` lookup. The agent process runs from
 * that studio directory, and each session works in a directory of its own under
 * `SESSION_DIRECTORY`, which holds only the studio's settings for it: the adapter and the Claude CLI read a session's settings from its working
 * directory, so the deck reaches the agent only as an additional directory of ACP's `session/new`.
 * `settings.json` in the user data directory can name a local command instead, which runs from the
 * same directory.
 *
 * A Finder-launched app gets launchd's PATH, which has no npm, so on macOS the PATH comes from the
 * user's login shell, read once per backend. This ports the capture in t3code's
 * `packages/shared/src/shell.ts` (`readEnvironmentFromLoginShell`, MIT licence, Copyright (c) 2026
 * T3 Tools Inc.), cut to PATH and POSIX shells. Either way npm and the agent get only its entries
 * whose real path exists outside the deck (see `trustedPath`), and npm itself is the first one found
 * there, run by its absolute path.
 */

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import path from "node:path";

import { isInside } from "@elmeragroup/deck-core/deck/contained-file";

/** The ACP registry's `claude-acp` adapter. */
export const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";

/** The adapter's release the studio is tested with. */
export const CLAUDE_ACP_VERSION = "0.109.0";

/**
 * The file in the agent directory that names the adapter release npm finished installing. An
 * install cut short, by Stop or a quit, can leave the adapter's own package without the Claude
 * CLI it depends on, so only this file says the install is whole.
 */
export const INSTALLED_MARKER = "installed.txt";

/** The adapter's command in its package's `bin`. */
const CLAUDE_ACP_BIN = "claude-agent-acp";

/** The settings file's name in the user data directory. */
export const SETTINGS_FILE = "settings.json";

/** The studio's agent directory in the user data directory: the adapter's install, and the agent process's working directory. */
export const AGENT_DIRECTORY = "agent";

/**
 * The directory in the user data directory that holds the agent sessions' working directories:
 * each session works in a directory of its own there, which holds only the studio's settings for
 * it and is removed when the session ends.
 * claude-agent-acp 0.109.0 reads a session's permission mode from the settings in its working
 * directory (`openQuery` in `dist/v2/agent.js`), and runs `claude auth status` there, which reads
 * that directory's settings with their helper commands (`runProbe` in `auth-status-reporter.js`).
 */
export const SESSION_DIRECTORY = "agent-sessions";

/** How long the login shell may take to print its PATH. */
const SHELL_TIMEOUT = Duration.seconds(5);

/** How much of npm's output a failed install quotes. */
const OUTPUT_TAIL = 2000;

const START = "__FUSE_DECK_STUDIO_PATH_START__";
const END = "__FUSE_DECK_STUDIO_PATH_END__";

/** The agent settings in `settings.json`. Every key is optional. */
const AgentSettings = Schema.Struct({
  agent: Schema.optionalKey(
    Schema.Struct({
      /** A local agent command to run in place of the registry's adapter. */
      command: Schema.optionalKey(Schema.String),
      args: Schema.optionalKey(Schema.Array(Schema.String)),
      /** A file to append every ACP message to, one JSON line each. Off unless set. */
      protocolLog: Schema.optionalKey(Schema.String),
    })
  ),
});

const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(AgentSettings));

/** The fields of the installed adapter's `package.json` the launch reads. */
const InstalledPackage = Schema.Struct({
  version: Schema.String,
  bin: Schema.Record(Schema.String, Schema.String),
});

const decodeInstalled = Schema.decodeUnknownOption(Schema.fromJsonString(InstalledPackage));

/** The agent directory's `package.json`, which pins the adapter for npm. */
const encodeManifest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      private: Schema.Boolean,
      description: Schema.String,
      dependencies: Schema.Record(Schema.String, Schema.String),
    })
  )
);

/** The Node that runs the adapter: the backend's own, never one found on PATH. */
export type TrustedNode = {
  /** An absolute path, `process.execPath`. */
  readonly executable: string;
  /** Whether it is Electron's binary, which runs as Node only with `ELECTRON_RUN_AS_NODE=1`. */
  readonly electron: boolean;
};

/** The backend's own environment, which the entry reads. */
export type InheritedEnvironment = {
  /** The backend's PATH, used as is off macOS and when the login shell gives none. */
  readonly pathVariable: string;
  /** The user's login shell, `$SHELL`. */
  readonly shell: string;
  readonly node: TrustedNode;
};

/** What the studio runs as its agent. */
export type AgentCommand = {
  /** An absolute executable, or the command `settings.json` names. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The agent process's working directory: the studio's agent directory, never the deck. */
  readonly cwd: string;
  /** Where each session makes its own working directory: `SESSION_DIRECTORY`, never the deck. */
  readonly sessionsDirectory: string;
  /** What the agent's environment sets on top of the backend's, `undefined` removing a variable. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The PATH the agent runs with: `trustedPath` of the login shell's or the backend's. */
  readonly pathVariable: string;
  /** Where to log the ACP messages, if anywhere. */
  readonly protocolLog: Option.Option<string>;
};

/** The adapter could not be installed. */
export class AgentInstallFailed extends Schema.TaggedError<AgentInstallFailed>()("AgentInstallFailed", {
  message: Schema.String,
}) {}

/** Resolves the agent command for each new session. */
export class AgentLaunch extends Context.Service<
  AgentLaunch,
  {
    /**
     * The command for a session on `deck`, read from the settings each time, so a change applies
     * to the next session. The adapter is installed first when its pinned release is not.
     */
    readonly command: (deck: string) => Effect.Effect<AgentCommand, AgentInstallFailed>;
  }
>()("@elmeragroup/fuse-deck-studio/server/AgentLaunch") {
  /**
   * The launch settings in `userDataDirectory`, with PATH from the login shell on macOS and from
   * the backend's own environment elsewhere.
   *
   * @param userDataDirectory - The app's user data directory.
   * @param inherited - The backend's own PATH, shell and Node.
   */
  static readonly layer = (userDataDirectory: string, inherited: InheritedEnvironment) =>
    Layer.effect(
      AgentLaunch,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const loginPath = yield* Effect.cached(
          process.platform === "darwin"
            ? loginShellPath(inherited).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
              )
            : Effect.succeed(inherited.pathVariable)
        );
        return yield* makeLaunch(userDataDirectory, inherited.node, loginPath);
      })
    );

  /**
   * Fixed launch settings with the given PATH and this process's Node, for tests.
   *
   * @param userDataDirectory - Where `settings.json` and the agent directory live.
   * @param pathVariable - The PATH the agent runs with.
   */
  static readonly layerWithPath = (userDataDirectory: string, pathVariable: string) =>
    Layer.effect(
      AgentLaunch,
      makeLaunch(
        userDataDirectory,
        { executable: process.execPath, electron: false },
        Effect.succeed(pathVariable)
      )
    );
}

const makeLaunch = Effect.fnUntraced(function* (
  userDataDirectory: string,
  node: TrustedNode,
  pathVariable: Effect.Effect<string>
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Two decks starting their agents at once install once.
  const installing = yield* Semaphore.make(1);
  const directory = path.join(userDataDirectory, AGENT_DIRECTORY);
  const sessionsDirectory = path.join(userDataDirectory, SESSION_DIRECTORY);
  return AgentLaunch.of({
    command: Effect.fnUntraced(
      function* (deck: string) {
        const settings = yield* readSettings(userDataDirectory);
        const pathValue = yield* trustedPath(yield* pathVariable, deck);
        const protocolLog = Option.fromUndefinedOr(settings.agent?.protocolLog);
        yield* Effect.forEach(
          [directory, sessionsDirectory],
          (made) =>
            fs
              .makeDirectory(made, { recursive: true })
              .pipe(
                Effect.mapError(
                  (error) => new AgentInstallFailed({ message: `Could not make ${made}: ${error.message}` })
                )
              ),
          { concurrency: 1, discard: true }
        );
        const local = settings.agent?.command;
        if (local !== undefined) {
          return {
            command: local,
            args: settings.agent?.args ?? [],
            cwd: directory,
            sessionsDirectory,
            // The backend runs as Electron's Node; a local agent does not inherit that switch.
            env: { ELECTRON_RUN_AS_NODE: undefined },
            pathVariable: pathValue,
            protocolLog,
          } satisfies AgentCommand;
        }
        const entry = yield* installing.withPermits(1)(installedAdapter(directory, pathValue));
        return {
          command: node.executable,
          args: [entry],
          cwd: directory,
          sessionsDirectory,
          env: { ELECTRON_RUN_AS_NODE: node.electron ? "1" : undefined },
          pathVariable: pathValue,
          protocolLog,
        } satisfies AgentCommand;
      },
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
    ),
  });
});

type Settings = typeof AgentSettings.Type;

/** The settings, or none when the file is missing or does not decode. */
const readSettings = Effect.fn("AgentLaunch.readSettings")(function* (userDataDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(path.join(userDataDirectory, SETTINGS_FILE))
    .pipe(Effect.orElseSucceed(() => ""));
  return Option.getOrElse(decodeSettings(text), (): Settings => ({}));
});

/** The installed adapter's entry file, if the pinned release is installed in `directory`. */
const adapterEntry = Effect.fn("AgentLaunch.adapterEntry")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const marker = yield* fs
    .readFileString(path.join(directory, INSTALLED_MARKER))
    .pipe(Effect.orElseSucceed(() => ""));
  if (marker.trim() !== CLAUDE_ACP_VERSION) {
    return Option.none<string>();
  }
  const packageDirectory = path.join(directory, "node_modules", ...CLAUDE_ACP_PACKAGE.split("/"));
  const installed = decodeInstalled(
    yield* fs.readFileString(path.join(packageDirectory, "package.json")).pipe(Effect.orElseSucceed(() => ""))
  );
  if (Option.isNone(installed) || installed.value.version !== CLAUDE_ACP_VERSION) {
    return Option.none<string>();
  }
  const bin = installed.value.bin[CLAUDE_ACP_BIN];
  if (bin === undefined) {
    return Option.none<string>();
  }
  const entry = path.join(packageDirectory, bin);
  return (yield* fs.exists(entry).pipe(Effect.orElseSucceed(() => false)))
    ? Option.some(entry)
    : Option.none<string>();
});

/**
 * The adapter's entry file, installed first when the pinned release is not: npm installs the pin
 * that `package.json` in `directory` names, from that directory, with install scripts off.
 */
const installedAdapter = Effect.fn("AgentLaunch.installedAdapter")(function* (
  directory: string,
  pathVariable: string
) {
  const present = yield* adapterEntry(directory);
  if (Option.isSome(present)) {
    return present.value;
  }
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const npm = yield* findExecutable("npm", pathVariable);
  if (Option.isNone(npm)) {
    return yield* new AgentInstallFailed({
      message: `No npm on PATH outside the deck to install ${CLAUDE_ACP_PACKAGE}@${CLAUDE_ACP_VERSION} with.`,
    });
  }
  const manifest = yield* encodeManifest({
    private: true,
    description: "fuse-deck studio's agent adapter.",
    dependencies: { [CLAUDE_ACP_PACKAGE]: CLAUDE_ACP_VERSION },
  }).pipe(Effect.mapError((error) => new AgentInstallFailed({ message: error.message })));
  yield* fs
    .writeFileString(path.join(directory, "package.json"), `${manifest}\n`)
    .pipe(
      Effect.mapError(
        (error) =>
          new AgentInstallFailed({ message: `Could not write ${directory}/package.json: ${error.message}` })
      )
    );
  let output = "";
  const code = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          npm.value,
          ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
          {
            cwd: directory,
            // npm's own `#!/usr/bin/env node` finds Node on this PATH too.
            env: { PATH: pathVariable, ELECTRON_RUN_AS_NODE: undefined },
            extendEnv: true,
            stdin: "ignore",
          }
        )
      );
      yield* Stream.merge(handle.stdout, handle.stderr).pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            output = (output + chunk).slice(-OUTPUT_TAIL);
          })
        ),
        Effect.forkScoped
      );
      return yield* handle.exitCode;
    })
  ).pipe(
    Effect.mapError((error) => new AgentInstallFailed({ message: `npm did not start: ${error.message}` }))
  );
  if (code === 0) {
    yield* fs
      .writeFileString(path.join(directory, INSTALLED_MARKER), `${CLAUDE_ACP_VERSION}\n`)
      .pipe(
        Effect.mapError(
          (error) => new AgentInstallFailed({ message: `Could not record the install: ${error.message}` })
        )
      );
  }
  const installed = yield* adapterEntry(directory);
  if (code !== 0 || Option.isNone(installed)) {
    return yield* new AgentInstallFailed({
      message: `npm could not install ${CLAUDE_ACP_PACKAGE}@${CLAUDE_ACP_VERSION} (exit code ${String(code)}). ${output.trim()}`,
    });
  }
  return installed.value;
});

/**
 * The PATH npm and the agent run with: the entries of `pathVariable` that are absolute and whose
 * real path exists outside the deck's real directory. An empty or relative entry would resolve
 * against a working directory, an entry in the deck, by any spelling, would run what the deck ships,
 * and one that does not resolve could be created there later.
 *
 * @param pathVariable - A PATH.
 * @param deck - The deck's directory.
 * @returns The PATH with only those entries, in order.
 */
export const trustedPath = Effect.fn("AgentLaunch.trustedPath")(function* (
  pathVariable: string,
  deck: string
) {
  const fs = yield* FileSystem.FileSystem;
  const realDeck = yield* fs.realPath(deck).pipe(Effect.orElseSucceed(() => path.resolve(deck)));
  const inDeck = (entry: string) => [realDeck, path.resolve(deck)].some((root) => isInside(root, entry));
  const kept: string[] = [];
  for (const entry of pathVariable.split(path.delimiter)) {
    if (!path.isAbsolute(entry) || inDeck(entry)) {
      continue;
    }
    const real = yield* fs.realPath(entry).pipe(Effect.option);
    if (Option.isSome(real) && !inDeck(real.value)) {
      kept.push(entry);
    }
  }
  return kept.join(path.delimiter);
});

/** The first executable regular file named `name` in a trusted PATH's entries, by its absolute path. */
const findExecutable = Effect.fn("AgentLaunch.findExecutable")(function* (
  name: string,
  pathVariable: string
) {
  const fs = yield* FileSystem.FileSystem;
  for (const entry of pathVariable.split(path.delimiter).filter((each) => each !== "")) {
    const file = path.join(entry, name);
    const info = yield* fs.stat(file).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0) {
      return Option.some(file);
    }
  }
  return Option.none<string>();
});

/**
 * PATH as the user's interactive login shell sets it, or the backend's own when the shell fails, times
 * out or prints no PATH. The shell runs detached, so job control on an inherited terminal cannot
 * stop it, and a DEBUG trap that echoes commands is cleared first so it cannot print the markers.
 */
const loginShellPath = Effect.fn("AgentLaunch.loginShellPath")(function* (inherited: InheritedEnvironment) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const script = [
    "(trap - DEBUG) 2>/dev/null && trap - DEBUG",
    `printf '%s\\n' '${START}'`,
    "printenv PATH",
    `printf '%s\\n' '${END}'`,
  ].join("; ");
  const output = yield* spawner
    .string(
      ChildProcess.make(inherited.shell, ["-ilc", script], {
        detached: true,
        stdin: "ignore",
        stderr: "ignore",
        forceKillAfter: Duration.seconds(1),
      })
    )
    .pipe(
      Effect.timeoutOption(SHELL_TIMEOUT),
      Effect.map(Option.flatMap(pathBetweenMarkers)),
      Effect.orElseSucceed(() => Option.none<string>())
    );
  return Option.getOrElse(output, () => inherited.pathVariable);
});

/** The line between the markers, if the output holds a nonempty one. */
function pathBetweenMarkers(output: string): Option.Option<string> {
  const start = output.lastIndexOf(START);
  const end = output.lastIndexOf(END);
  if (start < 0 || end < start) {
    return Option.none();
  }
  const value = output.slice(start + START.length, end).trim();
  return value.length > 0 ? Option.some(value) : Option.none();
}
