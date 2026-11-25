/**
 * The studio's main window, with the navigation hardening ported from t3code's `DesktopWindow`
 * (pingdotgg/t3code `apps/desktop/src/window/DesktopWindow.ts` at 2fe7febc, MIT licence, Copyright
 * (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md). Bounds persistence, the WSL splash, the
 * preview webviews and the quit-shortcut hold are left out.
 *
 * Two departures from t3code: `webviewTag` is off, since the deck preview is an iframe, and every
 * permission request and check is denied, where t3code grants all but `openExternal`.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

/** What the window loads. */
export type DesktopWindowConfig = {
  /** The stub page's address on the app scheme. */
  readonly applicationUrl: string;
  readonly preloadPath: string;
  readonly title: string;
};

/**
 * Whether a main-frame navigation stays on the app's own scheme and host. Node serializes a custom
 * scheme's origin as "null", so this compares the scheme and host, as t3code does.
 */
function isSameOriginRendererNavigation(applicationUrl: string, navigationUrl: string): boolean {
  try {
    const application = new URL(applicationUrl);
    const navigation = new URL(navigationUrl);
    return (
      application.host !== "" &&
      navigation.protocol === application.protocol &&
      navigation.host === application.host
    );
  } catch {
    return false;
  }
}

/** Opens and focuses the main window. */
export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    /** Create the main window and load the stub page; it shows once it has painted. */
    readonly open: Effect.Effect<void, ElectronWindow.ElectronWindowCreateError>;
    /** Focus the main window, or open one when none is left (macOS dock activation). */
    readonly activate: Effect.Effect<void>;
  }
>()("@elmeragroup/fuse-deck-studio/window/DesktopWindow") {
  /**
   * The window service for `config`.
   *
   * @param config - The page and preload the window loads.
   */
  static readonly layer = (config: DesktopWindowConfig) =>
    Layer.effect(
      DesktopWindow,
      Effect.gen(function* () {
        const electronWindow = yield* ElectronWindow.ElectronWindow;
        const electronShell = yield* ElectronShell.ElectronShell;
        const runFork = Effect.runForkWith(yield* Effect.context<never>());

        const open = Effect.gen(function* () {
          const window = yield* electronWindow.create({
            width: 1280,
            height: 800,
            minWidth: 640,
            minHeight: 400,
            show: false,
            title: config.title,
            webPreferences: {
              preload: config.preloadPath,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webviewTag: false,
            },
          });
          const contents = window.webContents;

          // Popups from any frame arrive here with no caller, so only web links leave, and only to
          // the system browser.
          contents.setWindowOpenHandler(({ url }) => {
            if (Option.isSome(ElectronShell.parseWebExternalUrl(url))) {
              runFork(electronShell.openExternal(url));
            }
            return { action: "deny" };
          });
          contents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
            callback(false);
          });
          contents.session.setPermissionCheckHandler(() => false);
          // Main frame only: the deck iframe reloads itself when Vite re-optimizes, and stays on
          // its own origin under the page's `frame-src`.
          contents.on("will-navigate", (event, url) => {
            if (isSameOriginRendererNavigation(config.applicationUrl, url)) {
              return;
            }
            event.preventDefault();
            if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
              runFork(electronShell.openExternal(url));
            }
          });
          contents.on("will-attach-webview", (event) => {
            event.preventDefault();
          });
          window.once("ready-to-show", () => {
            runFork(electronWindow.reveal(window));
          });
          window.on("closed", () => {
            runFork(electronWindow.clearMain(Option.some(window)));
          });

          yield* electronWindow.setMain(window);
          yield* Effect.promise(() => window.loadURL(config.applicationUrl).catch(() => undefined));
        });

        return DesktopWindow.of({
          open,
          activate: Effect.gen(function* () {
            const main = yield* electronWindow.main;
            if (Option.isSome(main)) {
              return yield* electronWindow.reveal(main.value);
            }
            yield* open.pipe(Effect.catch((error) => Effect.logError(error.message)));
          }),
        });
      })
    );
}
