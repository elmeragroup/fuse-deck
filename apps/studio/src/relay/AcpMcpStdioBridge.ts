// Copied close to verbatim from T3 Code's apps/server/src/mcp/AcpMcpStdioBridge.ts
// (pingdotgg/t3code at 2fe7febc, MIT licence, Copyright (c) 2026 T3 Tools Inc.; see
// apps/desktop/THIRD_PARTY_NOTICES.md). Changed: only the stdio bridge stays (no `mcpToolSession`,
// `acp-mcp-call` or CLI fast path; `bin.ts` is the entry), the response helpers come from the copy
// beside this file, the error messages name the studio, the exports carry JSDoc, and the
// diagnostics directive gives its reason.
// Relay JSON-RPC verbatim; schema decoding would reject foreign payloads.
// @effect-diagnostics globalJsonInEffect:off -- the relay forwards foreign JSON-RPC as it is
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { discardResponseBody, responsePayloads } from "./mcpResponsePayloads.ts";

/** ACP mandates stdio MCP support; HTTP/SSE support varies. */

const JsonRpcError = Schema.Struct({ code: Schema.Number, message: Schema.String });

/** The relay could not forward a message, or the endpoint refused it. */
export class AcpMcpBridgeError extends Schema.TaggedError<AcpMcpBridgeError>()("AcpMcpBridgeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  /** The JSON-RPC error the server answered with, when it answered. */
  rpcError: Schema.optional(JsonRpcError),
}) {}

const isAcpMcpBridgeError = Schema.is(AcpMcpBridgeError);

const bridgeError = (cause: unknown): AcpMcpBridgeError =>
  isAcpMcpBridgeError(cause)
    ? cause
    : new AcpMcpBridgeError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

/** Where the relay forwards to and what it reads and writes. */
export interface AcpMcpStdioBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: { write(chunk: string): unknown };
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

function asEnvelope(value: unknown): JsonRpcEnvelope | null {
  return typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
}

function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

/**
 * Relay newline-delimited JSON-RPC from `input` to the Streamable HTTP endpoint, and every payload
 * of each response to `output`, until `input` ends and the requests in flight have settled.
 */
export function runAcpMcpStdioBridge(options: AcpMcpStdioBridgeOptions): Effect.Effect<void> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Effect.gen(function* () {
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;
    const running = new Set<Fiber.Fiber<void>>();

    const writeMessage = (message: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        options.output.write(`${JSON.stringify(message)}\n`);
      });

    const handleServerPayload = Effect.fn("AcpMcpStdioBridge.handleServerPayload")(function* (
      payload: unknown
    ): Effect.fn.Return<void> {
      for (const entry of Array.isArray(payload) ? payload : [payload]) {
        protocolVersion = protocolVersionOf(entry) ?? protocolVersion;
        yield* writeMessage(entry);
      }
    });

    const respondWithError = (requestId: unknown, message: string, code = -32603): Effect.Effect<void> =>
      writeMessage({
        jsonrpc: "2.0",
        id: requestId ?? null,
        error: { code, message },
      });

    const forward: (line: string, envelope: JsonRpcEnvelope) => Effect.Effect<void> = Effect.fn(
      "AcpMcpStdioBridge.forward"
    )(
      function* (line: string, envelope: JsonRpcEnvelope) {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetchImplementation(options.endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: options.authorization,
                ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
                ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
              },
              body: line,
              signal,
            }),
          catch: bridgeError,
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          if (envelope.id !== undefined) {
            yield* respondWithError(
              envelope.id,
              `The studio's MCP endpoint responded with HTTP ${response.status}.`
            );
          }
          return yield* discardResponseBody(response);
        }
        yield* Stream.runForEach(responsePayloads(response, bridgeError), handleServerPayload);
      },
      (effect, _line, envelope) =>
        effect.pipe(
          Effect.catchCause((cause) => {
            if (envelope.id === undefined) return Effect.void;
            const error = Cause.squash(cause);
            return respondWithError(
              envelope.id,
              `The MCP relay's request failed: ${error instanceof Error ? error.message : String(error)}`
            );
          })
        )
    );

    // Order only session establishment; SSE responses must bypass it to avoid deadlock. Calls remain concurrent after initialization.
    let sessionBarrier: Effect.Effect<void> = Effect.void;
    let sessionBarrierPending = false;

    const launch = Effect.fn("AcpMcpStdioBridge.launch")(function* (
      task: Effect.Effect<void>
    ): Effect.fn.Return<void> {
      const fiber = yield* Effect.forkChild(task);
      running.add(fiber);
      yield* Effect.forkChild(
        Fiber.await(fiber).pipe(
          Effect.andThen(
            Effect.sync(() => {
              running.delete(fiber);
            })
          )
        )
      );
    });

    const dispatch = Effect.fn("AcpMcpStdioBridge.dispatch")(function* (
      line: string
    ): Effect.fn.Return<void> {
      if (line.trim().length === 0) return;
      const parsed = decodeJsonLine(line);
      if (Option.isNone(parsed)) {
        return yield* respondWithError(null, "Parse error", -32700);
      }
      const envelope = asEnvelope(parsed.value);
      if (envelope === null) return;
      const isResponse = envelope.id !== undefined && ("result" in envelope || "error" in envelope);
      const isSessionHandshake =
        envelope.method === "initialize" || envelope.method === "notifications/initialized";
      if (isResponse) {
        return yield* launch(forward(line, envelope));
      }
      if (isSessionHandshake) {
        const prior = sessionBarrier;
        const fiber = yield* Effect.forkChild(prior.pipe(Effect.andThen(forward(line, envelope))));
        running.add(fiber);
        const barrier = Fiber.await(fiber).pipe(Effect.asVoid);
        sessionBarrier = barrier;
        sessionBarrierPending = true;
        yield* Effect.forkChild(
          Fiber.await(fiber).pipe(
            Effect.andThen(
              Effect.sync(() => {
                running.delete(fiber);
                if (sessionBarrier === barrier) sessionBarrierPending = false;
              })
            )
          )
        );
        return;
      }
      const task = sessionBarrierPending
        ? sessionBarrier.pipe(Effect.andThen(forward(line, envelope)))
        : forward(line, envelope);
      return yield* launch(task);
    });

    // node:readline also splits on U+2028/U+2029, which JSON.stringify leaves raw inside strings.
    yield* Stream.fromAsyncIterable(options.input, bridgeError).pipe(
      Stream.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk)),
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(dispatch),
      Effect.ignoreCause
    );
    yield* Fiber.awaitAll(running);
  });
}
