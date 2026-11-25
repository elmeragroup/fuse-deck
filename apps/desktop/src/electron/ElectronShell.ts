// Derived from pingdotgg/t3code apps/desktop/src/electron/ElectronShell.ts at 2fe7febc.
// MIT licence, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// Changes: only http and https links open externally: the editor deep links, app launch links and system settings panes are t3code features.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

const SAFE_WEB_PROTOCOLS = new Set(["http:", "https:"]);

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_WEB_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

/** Links that open in the browser, for callers such as popups that carry no identity. */
export const parseWebExternalUrl = (rawUrl: unknown): Option.Option<string> =>
  Option.filter(parseSafeExternalUrl(rawUrl), (url) =>
    SAFE_WEB_PROTOCOLS.has(new URL(url).protocol),
  );

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@elmeragroup/fuse-deck-studio/electron/ElectronShell") {}

/** @public */
export const make = ElectronShell.of({
  openExternal: Effect.fn("ElectronShell.openExternal")(function (rawUrl) {
    return Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    });
  }),
  copyText: Effect.fn("ElectronShell.copyText")(function (text) {
    return Effect.promise(() => Electron.clipboard.writeText(text).catch(() => undefined));
  }),
});

export const layer = Layer.succeed(ElectronShell, make);
