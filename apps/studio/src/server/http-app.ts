/**
 * The backend's HTTP face: the two credential exchanges and the RPC socket. Every route checks the
 * request's Origin before its credential.
 *
 * - `POST /api/session` takes a request with no Origin (main's) or the renderer's exact origin
 *   (the browser-tab test harness's), with its CORS preflight.
 * - `POST /api/ticket` takes only the renderer's exact origin, with its CORS preflight; the bearer
 *   travels in `Authorization`, so a browser always preflights it.
 * - `GET /ws` takes only the renderer's exact origin and an unspent ticket.
 * - `GET /api/deck` takes only a request with no Origin (main's) and the bearer. It answers the
 *   open deck's address, the only page main lets Present show. Neither the renderer nor a deck
 *   page can ask, since a browser sends an Origin with a request that carries `Authorization`.
 *
 * CORS allows the renderer's origin alone, never `*`, and no response sets a cookie. A deck's dev
 * server is another origin, so a framed deck reaches none of these routes.
 */

import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import {
  DECK_PATH,
  SESSION_PATH,
  SessionRequest,
  SOCKET_PATH,
  TICKET_PATH,
} from "../contract/studio-launch.ts";
import { DeckScopes } from "./deck-scopes.ts";
import { StudioAuth } from "./studio-auth.ts";

/** Who may ask: no Origin at all, or exactly the renderer's. */
type OriginPolicy = "renderer-only" | "renderer-or-none";

/** How long a browser may reuse a preflight answer. */
const PREFLIGHT_MAX_AGE_SECONDS = "600";

const decodeSessionRequest = Schema.decodeUnknownEffect(SessionRequest);

/**
 * The backend's HTTP handler.
 *
 * @param rendererOrigin - The renderer's exact origin.
 * @param rpcSocket - Upgrades the current request to the RPC socket.
 * @returns The handler for every request.
 */
export const makeHttpApp = Effect.fnUntraced(function* (
  rendererOrigin: string,
  rpcSocket: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    Scope.Scope | HttpServerRequest.HttpServerRequest
  >
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* StudioAuth;
  const scopes = yield* DeckScopes;
  const url = new URL(request.url, "http://127.0.0.1");
  const origin = Option.fromUndefinedOr(request.headers.origin);
  const allowed = (policy: OriginPolicy) =>
    Option.match(origin, {
      onNone: () => policy === "renderer-or-none",
      onSome: (value) => value === rendererOrigin,
    });
  // CORS headers go only to the renderer's origin.
  const cors = Option.match(origin, {
    onNone: () => ({}),
    onSome: (value) =>
      value === rendererOrigin ? { "access-control-allow-origin": value, vary: "Origin" } : {},
  });
  const refuse = (status: 401 | 403 | 404 | 405 | 400) => HttpServerResponse.empty({ status, headers: cors });

  const preflight = (policy: OriginPolicy) =>
    Option.isSome(origin) && allowed(policy) && request.headers["access-control-request-method"] === "POST"
      ? HttpServerResponse.empty({
          status: 204,
          headers: {
            ...cors,
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-max-age": PREFLIGHT_MAX_AGE_SECONDS,
          },
        })
      : refuse(403);

  switch (url.pathname) {
    case SESSION_PATH: {
      if (request.method === "OPTIONS") {
        return preflight("renderer-or-none");
      }
      if (request.method !== "POST") {
        return refuse(405);
      }
      if (!allowed("renderer-or-none")) {
        return refuse(403);
      }
      const body = yield* Effect.option(Effect.flatMap(request.json, decodeSessionRequest));
      if (Option.isNone(body)) {
        return refuse(400);
      }
      return yield* auth.exchangeBootstrap(Redacted.make(body.value.bootstrap)).pipe(
        Effect.match({
          onFailure: () => refuse(401),
          onSuccess: (bearer) =>
            HttpServerResponse.jsonUnsafe({ bearer: Redacted.value(bearer) }, { headers: cors }),
        })
      );
    }
    case TICKET_PATH: {
      if (request.method === "OPTIONS") {
        return preflight("renderer-only");
      }
      if (request.method !== "POST") {
        return refuse(405);
      }
      if (!allowed("renderer-only")) {
        return refuse(403);
      }
      const bearer = bearerFrom(request.headers.authorization);
      if (Option.isNone(bearer)) {
        return refuse(401);
      }
      return yield* auth.issueTicket(bearer.value).pipe(
        Effect.match({
          onFailure: () => refuse(401),
          onSuccess: ({ ticket, expiresInMillis }) =>
            HttpServerResponse.jsonUnsafe(
              { ticket: Redacted.value(ticket), expiresInMillis },
              { headers: cors }
            ),
        })
      );
    }
    case SOCKET_PATH: {
      if (request.method !== "GET") {
        return refuse(405);
      }
      if (!allowed("renderer-only")) {
        return refuse(403);
      }
      const ticket = Option.fromNullOr(url.searchParams.get("ticket"));
      if (Option.isNone(ticket)) {
        return refuse(401);
      }
      const redeemed = yield* Effect.result(auth.redeemTicket(Redacted.make(ticket.value)));
      if (redeemed._tag === "Failure") {
        return refuse(401);
      }
      return yield* rpcSocket;
    }
    case DECK_PATH: {
      if (request.method !== "GET") {
        return refuse(405);
      }
      if (Option.isSome(origin)) {
        return refuse(403);
      }
      const bearer = bearerFrom(request.headers.authorization);
      if (Option.isNone(bearer)) {
        return refuse(401);
      }
      const accepted = yield* Effect.result(auth.checkBearer(bearer.value));
      if (accepted._tag === "Failure") {
        return refuse(401);
      }
      const url = yield* scopes.openUrl;
      return HttpServerResponse.jsonUnsafe({ url: Option.getOrNull(url) });
    }
    default:
      return refuse(404);
  }
});

/** The bearer in an `Authorization: Bearer <token>` header. */
function bearerFrom(header: string | undefined): Option.Option<Redacted.Redacted<string>> {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "");
  return Option.map(Option.fromUndefinedOr(match?.[1]), (token) => Redacted.make(token));
}
