/**
 * The agent sessions' MCP tokens, after t3code's `McpSessionRegistry` (pingdotgg/t3code
 * `apps/server/src/mcp/McpSessionRegistry.ts` at 2fe7febc, MIT licence, Copyright (c) 2026 T3 Tools
 * Inc.; see apps/desktop/THIRD_PARTY_NOTICES.md), ported without threads, provider instances,
 * capabilities or idle expiry.
 *
 * Each agent session gets one token when it opens, for the deck scope it opened. `/mcp` honors it
 * for that scope only, and nothing else in the backend accepts it. The token lives as long as its
 * session: it is revoked when the session ends, however it ends, and when its deck starts closing.
 * Stop keeps it, since the relay holds it for the next prompt.
 *
 * Each MCP transport session (`Mcp-Session-Id`) belongs to the agent session whose token opened
 * it. `/mcp` takes it only with that token, and revoking the token ends it: its id is published on
 * `revokedTransports`, where the server terminates it.
 *
 * Only SHA-256 hashes of the tokens stay in memory.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { ScopeId } from "../contract/studio-rpc.ts";

/** The session a token was minted for. */
export type McpCaller = {
  /** The deck scope the session opened. */
  readonly scopeId: ScopeId;
  /** The agent session, one per agent process. */
  readonly sessionKey: string;
};

/** A token as minted, for the relay's environment only. */
export type MintedToken = {
  readonly caller: McpCaller;
  readonly token: Redacted.Redacted<string>;
};

/** Mints, resolves and revokes the agent sessions' MCP tokens. */
export class McpTokens extends Context.Service<
  McpTokens,
  {
    /** Mint a token for a new agent session on the deck `scopeId` names. */
    readonly mint: (scopeId: ScopeId) => Effect.Effect<MintedToken>;
    /** The session a token belongs to, or none for an unknown or revoked one. */
    readonly resolve: (token: Redacted.Redacted<string>) => Effect.Effect<Option.Option<McpCaller>>;
    /** Revoke the token of the session `sessionKey`. */
    readonly revokeSession: (sessionKey: string) => Effect.Effect<void>;
    /** Revoke every token minted for the deck scope `scopeId`. */
    readonly revokeScope: (scopeId: ScopeId) => Effect.Effect<void>;
    /**
     * Record that the agent session `sessionKey` opened the MCP transport session `transportId`.
     * A session whose token is already revoked has it ended at once.
     */
    readonly bindTransport: (sessionKey: string, transportId: string) => Effect.Effect<void>;
    /** The agent session that opened `transportId`, while its token is live. */
    readonly transportOwner: (transportId: string) => Effect.Effect<Option.Option<string>>;
    /** The transport sessions to end, each once, as their tokens are revoked. */
    readonly revokedTransports: Stream.Stream<string>;
  }
>()("@elmeragroup/fuse-deck-studio/server/McpTokens") {
  /** The tokens of one backend run, all gone when it stops. */
  static readonly layer = Layer.effect(
    McpTokens,
    Effect.gen(function* () {
      const records = yield* Ref.make<ReadonlyMap<string, McpCaller>>(new Map());
      // Each transport session's id, by the agent session that opened it.
      const transports = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const ended = yield* PubSub.unbounded<string>();
      const live = (sessionKey: string) =>
        Effect.map(Ref.get(records), (current) =>
          [...current.values()].some((caller) => caller.sessionKey === sessionKey)
        );
      const revokeWhere = Effect.fnUntraced(function* (predicate: (caller: McpCaller) => boolean) {
        const revoked = yield* Ref.modify(records, (current) => {
          const keep = [...current].filter(([, caller]) => !predicate(caller));
          const gone = [...current.values()].filter(predicate).map((caller) => caller.sessionKey);
          return [new Set(gone), new Map(keep)] as const;
        });
        const closing = yield* Ref.modify(transports, (current) => {
          const keep = [...current].filter(([, sessionKey]) => !revoked.has(sessionKey));
          const gone = [...current].filter(([, sessionKey]) => revoked.has(sessionKey)).map(([id]) => id);
          return [gone, new Map(keep)] as const;
        });
        yield* PubSub.publishAll(ended, closing);
      });
      return McpTokens.of({
        mint: Effect.fn("McpTokens.mint")(function* (scopeId: ScopeId) {
          const token = Redacted.make(randomBytes(32).toString("base64url"));
          const caller: McpCaller = { scopeId, sessionKey: randomUUID() };
          yield* Ref.update(records, (current) => new Map([...current, [hash(token), caller]]));
          return { caller, token };
        }),
        resolve: (token) =>
          Effect.map(Ref.get(records), (current) => Option.fromUndefinedOr(current.get(hash(token)))),
        revokeSession: (sessionKey) => revokeWhere((caller) => caller.sessionKey === sessionKey),
        revokeScope: (scopeId) => revokeWhere((caller) => caller.scopeId === scopeId),
        bindTransport: Effect.fnUntraced(function* (sessionKey: string, transportId: string) {
          yield* Ref.update(transports, (current) => new Map([...current, [transportId, sessionKey]]));
          // Revoked between the request's check and now: end it as a revocation would.
          if (!(yield* live(sessionKey))) {
            yield* Ref.update(
              transports,
              (current) => new Map([...current].filter(([id]) => id !== transportId))
            );
            yield* PubSub.publish(ended, transportId);
          }
        }),
        transportOwner: Effect.fnUntraced(function* (transportId: string) {
          const owner = (yield* Ref.get(transports)).get(transportId);
          return owner !== undefined && (yield* live(owner)) ? Option.some(owner) : Option.none<string>();
        }),
        revokedTransports: Stream.fromPubSub(ended),
      });
    })
  );
}

/** A token's SHA-256, the only form of it this module keeps. */
function hash(token: Redacted.Redacted<string>): string {
  return createHash("sha256").update(Redacted.value(token)).digest("base64url");
}
