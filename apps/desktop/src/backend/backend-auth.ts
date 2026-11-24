/**
 * Main's side of the renderer's authentication, after t3code's `DesktopLocalEnvironmentAuth`
 * (pingdotgg/t3code `apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts` at 2fe7febc, MIT
 * licence, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md).
 *
 * The backend manager trades each run's bootstrap credential for the session bearer as part of
 * the run's readiness, so a ready run always has one. The renderer asks for the connection on
 * every connection attempt, so after a restart it gets the new run's address and bearer, never a
 * stale one. The bootstrap credential itself never leaves main.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { BackendConnection } from "@elmeragroup/fuse-deck-studio/contract/studio-launch";

import { BackendManager } from "./backend-manager.ts";
import type { BackendStatus } from "./backend-status.ts";

type ReadyRun = Extract<BackendStatus, { readonly _tag: "Ready" }>;

/** Hands the renderer the current backend's address and bearer. */
export class BackendAuth extends Context.Service<
  BackendAuth,
  {
    /** The running backend's address and bearer, once it is ready; it waits through a restart. */
    readonly connection: Effect.Effect<BackendConnection>;
  }
>()("@elmeragroup/fuse-deck-studio/backend/BackendAuth") {
  /** The service over the backend manager's status. */
  static readonly layer = Layer.effect(
    BackendAuth,
    Effect.gen(function* () {
      const { status } = yield* BackendManager;
      const connection = SubscriptionRef.changes(status).pipe(
        Stream.filter((current): current is ReadyRun => current._tag === "Ready"),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
        // The status stream never ends while the manager runs, so a Ready always comes.
        Effect.orDie,
        Effect.map((run) => ({ url: run.url, bearer: Redacted.value(run.bearer) }))
      );
      return BackendAuth.of({ connection: connection.pipe(Effect.withSpan("BackendAuth.connection")) });
    })
  );
}
