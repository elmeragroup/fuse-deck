/**
 * An RPC client for a spawned backend, connected the way the renderer connects: main's bootstrap
 * exchange with no Origin, then a ticket and the socket upgrade with the renderer's Origin.
 */

import { NodeSocket } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import {
  SESSION_PATH,
  SessionResponse,
  SOCKET_PATH,
  TICKET_PATH,
  TicketResponse,
} from "../src/contract/studio-launch.ts";
import { StudioRpcs } from "../src/contract/studio-rpc.ts";
import type { Backend } from "./backend.ts";

const decodeSession = Schema.decodeUnknownSync(SessionResponse);
const decodeTicket = Schema.decodeUnknownSync(TicketResponse);

/** Trade the backend's bootstrap credential for its bearer, then the bearer for a ticket. */
async function ticketFor(backend: Backend, origin: string): Promise<string> {
  const session = await fetch(new URL(SESSION_PATH, backend.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrap: backend.bootstrap }),
  });
  const { bearer } = decodeSession(await session.json());
  const ticket = await fetch(new URL(TICKET_PATH, backend.url), {
    method: "POST",
    headers: { origin, authorization: `Bearer ${bearer}` },
  });
  return decodeTicket(await ticket.json()).ticket;
}

/**
 * A client of `backend`'s RPC socket, for a renderer at `origin`, open until the scope closes.
 *
 * @returns The client.
 */
export const connectRpc = Effect.fn("connectRpc")(function* (backend: Backend, origin: string) {
  const ticket = yield* Effect.promise(() => ticketFor(backend, origin));
  const socketUrl = new URL(SOCKET_PATH, backend.url);
  socketUrl.protocol = "ws:";
  socketUrl.searchParams.set("ticket", ticket);
  const protocol = yield* Layer.build(
    Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) })
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.effect(Socket.Socket, Socket.makeWebSocket(socketUrl.href, { headers: { origin } })).pipe(
            Layer.provide(NodeSocket.layerWebSocketConstructor)
          ),
          RpcSerialization.layerJson
        )
      )
    )
  );
  return yield* RpcClient.make(StudioRpcs).pipe(Effect.provide(protocol));
});
