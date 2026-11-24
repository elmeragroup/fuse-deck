// Derived from pingdotgg/t3code apps/desktop/src/app/DesktopState.ts at 2fe7febc.
// MIT licence, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// Changes: keeps only `quitting`; the backend's state lives in the backend manager, and updates
// come in S6.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly quitting: Ref.Ref<boolean>;
  }
>()("@elmeragroup/fuse-deck-studio/app/DesktopState") {}

const make = Effect.all({
  quitting: Ref.make(false),
});

export const layer = Layer.effect(DesktopState, make);
