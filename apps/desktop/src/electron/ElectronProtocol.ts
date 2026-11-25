// Derived from pingdotgg/t3code apps/desktop/src/electron/ElectronProtocol.ts at 2fe7febc.
// MIT licence, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// Changes: renames the schemes; `makeDesktopContentSecurityPolicy` builds the studio's packaged
// policy; only the asset handler remains, since S0 has no dev renderer server to proxy.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Mime from "effect/http/Mime";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export const DESKTOP_HOST = "app";
const DESKTOP_PRODUCTION_SCHEME = "fuse-deck-studio";
const DESKTOP_DEVELOPMENT_SCHEME = "fuse-deck-studio-dev";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}

export class ElectronProtocolRegistrationError extends Schema.TaggedError<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedError<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

export type DesktopProtocolRegistrationInput = {
  readonly scheme: string;
  readonly assetDirectory: string;
};

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@elmeragroup/fuse-deck-studio/electron/ElectronProtocol") {}

// The packaged policy from the studio plan (D3). No inline script: the page's scripts are files.
// Inline styles stay allowed for Fuse. Decks are framed from their own 127.0.0.1 dev servers, on
// whichever port each one gets, so neither opening a deck nor restarting the backend changes the
// policy. Framing grants no read access to the deck.
export function makeDesktopContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "img-src 'self' data: blob:",
    "frame-src http://127.0.0.1:*",
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Must run synchronously before Electron emits ready.
function registerDesktopSchemePrivilegesSync(): void {
  Electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_PRODUCTION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        // Custom schemes must opt into V8 caching; dev URLs serve changing code.
        codeCache: true,
      },
    },
    {
      scheme: DESKTOP_DEVELOPMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

const registerDesktopSchemePrivileges = Effect.sync(registerDesktopSchemePrivilegesSync).pipe(
  Effect.withSpan("desktop.electron.protocol.registerSchemePrivileges"),
);

export const layerSchemePrivileges = Layer.effectDiscard(registerDesktopSchemePrivileges);

const serveDesktopAsset = Effect.fn("desktop.protocol.serveAsset")(function* (
  request: Request,
  assetDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const url = new URL(request.url);
  if (url.host !== DESKTOP_HOST) return new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  const pathname = Option.getOrNull(Option.liftThrowable(decodeURIComponent)(url.pathname));
  if (pathname === null || pathname.includes("\0")) return new Response(null, { status: 400 });
  const root = path.resolve(assetDirectory);
  const assetPath = path.resolve(root, `.${pathname}`);
  if (assetPath !== root && !assetPath.startsWith(root + path.sep)) {
    return new Response(null, { status: 404 });
  }
  const stat = yield* fileSystem.stat(assetPath).pipe(Effect.orElseSucceed(() => null));
  let filePath = assetPath;
  if (stat?.type !== "File") {
    const wantsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
    if (path.extname(assetPath) !== "" && !wantsHtml) {
      return new Response(null, { status: 404 });
    }
    filePath = path.join(root, "index.html");
  }
  const contents = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
  if (contents === null) return new Response(null, { status: 404 });
  return new Response(request.method === "HEAD" ? null : new Uint8Array(contents), {
    headers: {
      "content-type": Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream"),
    },
  });
});

/** @public */
export const make = Effect.gen(function* () {
  const registered = yield* Ref.make(false);
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runPromise = Effect.runPromiseWith(context);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy();

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, async (request) =>
              withContentSecurityPolicy(
                await runPromise(serveDesktopAsset(request, input.assetDirectory)),
                contentSecurityPolicy,
              ),
            );
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.try({
            try: () => Electron.protocol.unhandle(input.scheme),
            catch: (cause) =>
              new ElectronProtocolUnregistrationError({
                scheme: input.scheme,
                cause,
              }),
          }).pipe(Effect.andThen(Ref.set(registered, false)), Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
