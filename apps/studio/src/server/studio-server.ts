/**
 * The studio backend's program: read the launch document, serve the renderer's API on
 * 127.0.0.1, print `StudioReady`, and run until the parent closes stdin.
 *
 * Main keeps the backend's stdin open for as long as it runs. When main exits, however it exits,
 * the operating system closes the pipe, and the backend stops: a crashed main leaves no backend
 * behind, although the backend runs in its own process group. SIGTERM stops it the same way.
 *
 * Either stop runs one sequence: the RPC socket closes, the open deck drains its admitted calls
 * and closes, then the HTTP server stops. Nothing else ends the process early, since each deck's
 * Vite runs in middleware mode. If the sequence outlasts `BACKEND_STOP_DEADLINE`, the backend
 * exits anyway, before main's own deadline sends SIGKILL.
 */

import { NodeHttpServer } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { createServer } from "node:http";
import path from "node:path";

import { BACKEND_STOP_DEADLINE, MCP_PATH, StudioLaunch, StudioReady } from "../contract/studio-launch.ts";
import { ScopeId, StudioRpcs } from "../contract/studio-rpc.ts";
import { AgentChats, STOP_DEADLINE } from "./agent-chats.ts";
import { AgentLaunch } from "./agent-launch.ts";
import type { InheritedEnvironment } from "./agent-launch.ts";
import { DeckScopes, DRAIN_TIMEOUT } from "./deck-scopes.ts";
import { GO_DEADLINE } from "./deck-view.ts";
import { makeHttpApp } from "./http-app.ts";
import { McpTokens } from "./mcp-tokens.ts";
import { RecentDecks } from "./recent-decks.ts";
import { StudioRpcHandlers } from "./rpc-handlers.ts";
import { StudioAuth } from "./studio-auth.ts";
import { CurrentCaller, studioMcpLayer } from "./studio-tools.ts";

/** Stdin closed, or its first line was not a launch document. */
export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()("LaunchFailed", {
  message: Schema.String,
}) {}

/** How long a stopping backend waits for its connections to close. */
const SHUTDOWN_GRACE = Duration.seconds(1);

const decodeLaunch = Schema.decodeUnknownEffect(Schema.fromJsonString(StudioLaunch));
const encodeReady = Schema.encodeEffect(Schema.fromJsonString(StudioReady));

/** The files the backend ships beside its entry. */
export type BackendFiles = {
  /** The deck runtime's directory, which every deck's dev server loads. */
  readonly runtimeRoot: string;
  /** The MCP relay's entry, which each agent session runs on the backend's Node. */
  readonly relayEntry: string;
  /** The fuse-deck skill, which the `describe` tool names. */
  readonly skill: string;
};

/**
 * The agent chats, each session given the relay to this backend's `/mcp`. The relay runs on the
 * backend's own Node, Electron's binary in the desktop app.
 */
function chatsLayer(launch: StudioLaunch, files: BackendFiles, inherited: InheritedEnvironment) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const port = Option.getOrThrowWith(
        portOf(server.address),
        () => new Error("The server listens on no TCP port.")
      );
      return AgentChats.layer({
        stopDeadline: STOP_DEADLINE,
        mcpRelay: Option.some({
          command: inherited.node.executable,
          args: [files.relayEntry],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          endpoint: `http://127.0.0.1:${String(port)}${MCP_PATH}`,
        }),
      });
    })
  ).pipe(Layer.provide(AgentLaunch.layer(launch.userDataDirectory, inherited)));
}

/** The services one backend run serves with, built from its launch document. */
function studioLayer(launch: StudioLaunch, files: BackendFiles, inherited: InheritedEnvironment) {
  const recent = RecentDecks.layer(launch.userDataDirectory);
  return Layer.mergeAll(
    DeckScopes.layer({
      embedderOrigin: launch.origin,
      runtimeRoot: files.runtimeRoot,
      cacheRoot: path.join(launch.userDataDirectory, "deck-cache"),
      drainTimeout: DRAIN_TIMEOUT,
      goDeadline: GO_DEADLINE,
    }).pipe(Layer.provideMerge(recent), Layer.provide(chatsLayer(launch, files, inherited))),
    StudioAuth.layer(Redacted.make(launch.bootstrap)),
    RpcSerialization.layerJson
  ).pipe(
    Layer.provideMerge(McpTokens.layer),
    // Port 0: the operating system picks a free port, and StudioReady reports it. A stop closes
    // the renderer's socket and waits at most SHUTDOWN_GRACE for it.
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, {
        host: "127.0.0.1",
        port: 0,
        gracefulShutdownTimeout: SHUTDOWN_GRACE,
      })
    )
  );
}

/**
 * Run the backend until stdin closes.
 *
 * @param files - The deck runtime, the relay and the skill the backend ships.
 * @param inherited - The backend's own PATH and shell, which the agent's launch starts from.
 */
export const runStudioServer = Effect.fn("studio.server")(function* (
  files: BackendFiles,
  inherited: InheritedEnvironment
) {
  const stdio = yield* Stdio.Stdio;
  const firstLine = yield* Deferred.make<string>();
  const stdinClosed = yield* Deferred.make<void>();
  yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    // Only the first line is read; later ones are ignored until the pipe closes.
    Stream.runForEach((line) => Deferred.succeed(firstLine, line)),
    Effect.ignore,
    Effect.ensuring(Deferred.succeed(stdinClosed, undefined)),
    Effect.forkScoped
  );
  const line = yield* Deferred.await(firstLine).pipe(
    Effect.raceFirst(
      Deferred.await(stdinClosed).pipe(
        Effect.andThen(Effect.fail(new LaunchFailed({ message: "stdin closed before the launch document." })))
      )
    )
  );
  const launch = yield* decodeLaunch(line).pipe(
    Effect.mapError(
      (error) =>
        new LaunchFailed({ message: `stdin's first line is not a launch document: ${error.message}` })
    )
  );

  yield* Effect.gen(function* () {
    const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* RpcServer.make(StudioRpcs).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(StudioRpcHandlers),
      Effect.forkScoped
    );
    const mcp = yield* HttpRouter.toHttpEffect(studioMcpLayer(files.skill));
    // A revoked token's transport sessions end: a DELETE through the MCP endpoint terminates each
    // and interrupts its requests still in flight.
    const tokens = yield* McpTokens;
    yield* tokens.revokedTransports.pipe(
      Stream.runForEach((transportId) =>
        mcp.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`http://127.0.0.1${MCP_PATH}`, {
                method: "DELETE",
                headers: { "mcp-session-id": transportId },
              })
            )
          ),
          Effect.provideService(CurrentCaller, { scopeId: ScopeId.make("revoked"), sessionKey: "revoked" }),
          Effect.flatMap((response) =>
            response.status === 204
              ? Effect.logInfo("Ended the MCP transport session of a revoked token.")
              : Effect.logWarning(`Ending an MCP transport session answered ${String(response.status)}.`)
          ),
          Effect.ignore
        )
      ),
      Effect.forkScoped
    );
    const server = yield* HttpServer.HttpServer;
    // Interruptible, so a stop ends the RPC socket's handler instead of waiting for the client.
    yield* server.serve(
      Effect.interruptible(
        makeHttpApp(
          launch.origin,
          httpEffect,
          mcp.pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 })))
        )
      )
    );
    const port = Option.getOrThrowWith(
      portOf(server.address),
      () => new Error("The server listens on no TCP port.")
    );
    yield* Console.log(yield* encodeReady({ _tag: "StudioReady", url: `http://127.0.0.1:${String(port)}/` }));
    // Added last, so it runs first when the stop starts, whichever way it starts.
    yield* Effect.addFinalizer(() => exitAfterDeadline);
    yield* Deferred.await(stdinClosed);
    yield* Effect.logInfo("stdin closed; the studio backend stops.");
    // The server's fibers live in this inner scope, which closes before the layer's resources, the
    // HTTP server among them, are released.
  }).pipe(Effect.scoped, Effect.provide(studioLayer(launch, files, inherited)));
}, Effect.scoped);

/**
 * End the process once `BACKEND_STOP_DEADLINE` has passed, in a fiber outside every scope the stop
 * closes. A stop that finishes in time exits first, through the entry's teardown.
 */
const exitAfterDeadline = Effect.sleep(BACKEND_STOP_DEADLINE).pipe(
  Effect.andThen(
    Effect.logError(
      `The studio backend did not stop within ${Duration.format(BACKEND_STOP_DEADLINE)}; exiting.`
    )
  ),
  Effect.andThen(
    Effect.sync(() => {
      process.exit(1);
    })
  ),
  Effect.forkDetach,
  Effect.asVoid
);

/** The TCP port of a listening address. */
function portOf(address: HttpServer.HttpServer["Service"]["address"]): Option.Option<number> {
  return address._tag === "UnixPathAddress" ? Option.none() : Option.some(address.port);
}
