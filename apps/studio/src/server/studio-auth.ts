/**
 * The renderer's credentials, after t3code's desktop bootstrap, session and WebSocket-ticket flow
 * (pingdotgg/t3code `apps/server/src/auth` at 2fe7febc, MIT licence, Copyright (c) 2026 T3 Tools
 * Inc.; see apps/desktop/THIRD_PARTY_NOTICES.md), ported without cookies, DPoP, pairing or scopes.
 *
 * - The bootstrap credential arrives on stdin at spawn and trades once for the session bearer.
 * - The session bearer lives as long as this process. Main holds it and hands it to the renderer.
 * - A ticket is good for one WebSocket upgrade within `TICKET_LIFETIME` of its issue.
 *
 * Only SHA-256 hashes of the credentials stay in memory, so nothing here can leak one.
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { createHash, randomBytes } from "node:crypto";

/** How long a WebSocket ticket is good for. A renderer asks for one right before it connects. */
export const TICKET_LIFETIME = Duration.seconds(30);

/** A credential was missing, unknown, already used or expired. The reason is safe to log. */
export class CredentialRefused extends Schema.TaggedError<CredentialRefused>()("CredentialRefused", {
  credential: Schema.Literals(["bootstrap", "bearer", "ticket"]),
  reason: Schema.Literals(["unknown", "used", "expired"]),
}) {
  override get message(): string {
    return `The ${this.credential} was refused: ${this.reason}.`;
  }
}

/** An issued WebSocket ticket. */
export type IssuedTicket = {
  readonly ticket: Redacted.Redacted<string>;
  readonly expiresInMillis: number;
};

/** Issues and checks the renderer's credentials. */
export class StudioAuth extends Context.Service<
  StudioAuth,
  {
    /** Trade the bootstrap credential for the session bearer. It works once. */
    readonly exchangeBootstrap: (
      credential: Redacted.Redacted<string>
    ) => Effect.Effect<Redacted.Redacted<string>, CredentialRefused>;
    /** Issue a one-use WebSocket ticket to a session bearer. */
    readonly issueTicket: (
      bearer: Redacted.Redacted<string>
    ) => Effect.Effect<IssuedTicket, CredentialRefused>;
    /** Accept a session bearer, or refuse an unknown one. */
    readonly checkBearer: (bearer: Redacted.Redacted<string>) => Effect.Effect<void, CredentialRefused>;
    /** Spend a ticket on one WebSocket upgrade. */
    readonly redeemTicket: (ticket: Redacted.Redacted<string>) => Effect.Effect<void, CredentialRefused>;
  }
>()("@elmeragroup/fuse-deck-studio/server/StudioAuth") {
  /**
   * The credentials for one backend run.
   *
   * @param bootstrap - The bootstrap credential main handed this process.
   */
  static readonly layer = (bootstrap: Redacted.Redacted<string>) =>
    Layer.effect(
      StudioAuth,
      Effect.gen(function* () {
        // The bootstrap's hash until it is spent, then null.
        const pendingBootstrap = yield* Ref.make<string | null>(hash(bootstrap));
        const bearers = yield* Ref.make<ReadonlySet<string>>(new Set());
        // Each unspent ticket's hash and the moment it expires.
        const tickets = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

        const exchangeBootstrap = Effect.fn("StudioAuth.exchangeBootstrap")(function* (
          credential: Redacted.Redacted<string>
        ) {
          const presented = hash(credential);
          const outcome = yield* Ref.modify(pendingBootstrap, (pending) =>
            pending === presented
              ? (["accepted", null] as const)
              : ([pending === null ? "used" : "unknown", pending] as const)
          );
          if (outcome !== "accepted") {
            return yield* new CredentialRefused({ credential: "bootstrap", reason: outcome });
          }
          const bearer = yield* newSecret;
          yield* Ref.update(bearers, (current) => new Set([...current, hash(bearer)]));
          return bearer;
        });

        const checkBearer = Effect.fn("StudioAuth.checkBearer")(function* (
          bearer: Redacted.Redacted<string>
        ) {
          if (!(yield* Ref.get(bearers)).has(hash(bearer))) {
            return yield* new CredentialRefused({ credential: "bearer", reason: "unknown" });
          }
        });

        const issueTicket = Effect.fn("StudioAuth.issueTicket")(function* (
          bearer: Redacted.Redacted<string>
        ) {
          yield* checkBearer(bearer);
          const now = yield* Clock.currentTimeMillis;
          const lifetime = Duration.toMillis(TICKET_LIFETIME);
          const ticket = yield* newSecret;
          yield* Ref.update(tickets, (current) => {
            // Expired tickets go as new ones come, so the map never grows past a minute of tickets.
            const kept = [...current].filter(([, expiresAt]) => expiresAt > now);
            return new Map([...kept, [hash(ticket), now + lifetime]]);
          });
          return { ticket, expiresInMillis: lifetime };
        });

        const redeemTicket = Effect.fn("StudioAuth.redeemTicket")(function* (
          ticket: Redacted.Redacted<string>
        ) {
          const presented = hash(ticket);
          const now = yield* Clock.currentTimeMillis;
          const expiresAt = yield* Ref.modify(tickets, (current) => {
            const found = current.get(presented);
            const rest = new Map(current);
            rest.delete(presented);
            return [found, rest] as const;
          });
          if (expiresAt === undefined) {
            return yield* new CredentialRefused({ credential: "ticket", reason: "unknown" });
          }
          if (expiresAt <= now) {
            return yield* new CredentialRefused({ credential: "ticket", reason: "expired" });
          }
        });

        return StudioAuth.of({ exchangeBootstrap, checkBearer, issueTicket, redeemTicket });
      })
    );
}

/** A fresh 256-bit secret, base64url. */
const newSecret = Effect.sync(() => Redacted.make(randomBytes(32).toString("base64url")));

/** A credential's SHA-256, the only form of it this module keeps. */
function hash(credential: Redacted.Redacted<string>): string {
  return createHash("sha256").update(Redacted.value(credential)).digest("base64url");
}
