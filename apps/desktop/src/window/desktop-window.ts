/**
 * The studio's main window, with the navigation hardening ported from t3code's `DesktopWindow`
 * (pingdotgg/t3code `apps/desktop/src/window/DesktopWindow.ts` at 2fe7febc, MIT licence, Copyright
 * (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md). Bounds persistence, the WSL splash, the
 * preview webviews and the quit-shortcut hold are left out.
 *
 * Two departures from t3code: `webviewTag` is off, since the deck preview is an iframe, and every
 * permission request and check is denied, where t3code grants all but `openExternal`.
 *
 * The Present window shows the open deck fullscreen. It loads the deck's own 127.0.0.1 page, which
 * main has checked against the deck the backend reports open (`present-url.ts`), with no preload,
 * under the same hardening, and may navigate only within the deck's origin. Escape closes
 * it, and it closes with the main window.
 *
 * While the page reports a draft with edits, closing the main window asks the page first: main
 * sends the request on `LEAVE_REQUEST_CHANNEL`, and the page answers through `leave` once the user
 * saved or discarded the draft. A reload or a crashed page clears the report.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import type { LeaveIntent } from "@elmeragroup/fuse-deck-studio/contract/desktop-bridge";

import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { LEAVE_REQUEST_CHANNEL } from "../ipc/channels.ts";

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

/** The web preferences both windows share; only the main window adds its preload. */
const HARDENED_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: false,
} as const;

/** Opens and focuses the main window, and opens the Present window. */
export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    /** Create the main window and load the stub page; it shows once it has painted. */
    readonly open: Effect.Effect<void, ElectronWindow.ElectronWindowCreateError>;
    /** Focus the main window, or open one when none is left (macOS dock activation). */
    readonly activate: Effect.Effect<void>;
    /**
     * Show the deck page at `url` in a fullscreen window, closing an earlier one. Escape closes it.
     *
     * @param url - A page of the open deck, as `presentableUrl` checked it, with the position in its hash.
     */
    readonly present: (url: URL) => Effect.Effect<void, ElectronWindow.ElectronWindowCreateError>;
    /** Record whether the page reports a draft with edits. */
    readonly recordUnsavedDraft: (unsaved: boolean) => Effect.Effect<void>;
    /**
     * Ask the page to settle its draft before `intent` goes on, if it reported one with edits.
     *
     * @returns Whether the page was asked; when it was, the page calls `leave` to go on.
     */
    readonly askToLeave: (intent: LeaveIntent) => Effect.Effect<boolean>;
    /**
     * Go on with `intent` once the page settled its draft: forget the draft, and for a window
     * close, close the main window. The caller quits for a quit.
     */
    readonly leave: (intent: LeaveIntent) => Effect.Effect<void>;
    /**
     * Stop holding back window closes for good: a quit is under way, and Electron's own close of
     * the windows must not abort it.
     */
    readonly releaseForQuit: Effect.Effect<void>;
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
        let presenting: Electron.BrowserWindow | undefined;
        // What the page last reported about its draft. A new page or a crashed one has none.
        let unsavedDraft = false;
        // Set once a quit is under way; from then on no close is held back.
        let quitting = false;

        /**
         * Deny popups, permissions and webviews in `contents`, and keep its main frame on pages
         * `allowed` accepts. A popup or navigation to a web link opens in the system browser.
         */
        const harden = (contents: Electron.WebContents, allowed: (url: string) => boolean) => {
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
            if (allowed(url)) {
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
        };

        const closePresenting = () => {
          if (presenting !== undefined && !presenting.isDestroyed()) {
            presenting.close();
          }
          presenting = undefined;
        };

        const open = Effect.gen(function* () {
          const window = yield* electronWindow.create({
            width: 1280,
            height: 800,
            minWidth: 640,
            minHeight: 400,
            show: false,
            title: config.title,
            webPreferences: { ...HARDENED_PREFERENCES, preload: config.preloadPath },
          });
          harden(window.webContents, (url) => isSameOriginRendererNavigation(config.applicationUrl, url));
          window.once("ready-to-show", () => {
            runFork(electronWindow.reveal(window));
          });
          window.on("close", (event) => {
            if (unsavedDraft && !quitting) {
              event.preventDefault();
              window.webContents.send(LEAVE_REQUEST_CHANNEL, "close" satisfies LeaveIntent);
            }
          });
          window.webContents.on("did-navigate", () => {
            unsavedDraft = false;
          });
          window.webContents.on("render-process-gone", () => {
            unsavedDraft = false;
          });
          window.on("closed", () => {
            unsavedDraft = false;
            closePresenting();
            runFork(electronWindow.clearMain(Option.some(window)));
          });

          yield* electronWindow.setMain(window);
          yield* Effect.promise(() => window.loadURL(config.applicationUrl).catch(() => undefined));
        });

        const present = Effect.fn("DesktopWindow.present")(function* (url: URL) {
          closePresenting();
          // Auxiliary, so it never becomes the main window the IPC guard and activation key on.
          const window = yield* electronWindow.create(
            {
              title: config.title,
              fullscreen: true,
              show: false,
              backgroundColor: "#000000",
              webPreferences: HARDENED_PREFERENCES,
            },
            { auxiliary: true }
          );
          presenting = window;
          harden(window.webContents, (next) => {
            try {
              return new URL(next).origin === url.origin;
            } catch {
              return false;
            }
          });
          window.webContents.on("before-input-event", (event, input) => {
            if (input.type === "keyDown" && input.key === "Escape") {
              event.preventDefault();
              window.close();
            }
          });
          window.once("ready-to-show", () => {
            window.show();
          });
          window.on("closed", () => {
            if (presenting === window) {
              presenting = undefined;
            }
          });
          yield* Effect.promise(() => window.loadURL(url.href).catch(() => undefined));
        });

        const askToLeave = Effect.fn("DesktopWindow.askToLeave")(function* (intent: LeaveIntent) {
          const main = yield* electronWindow.main;
          if (!unsavedDraft || Option.isNone(main)) {
            return false;
          }
          main.value.webContents.send(LEAVE_REQUEST_CHANNEL, intent);
          return true;
        });

        const leave = Effect.fn("DesktopWindow.leave")(function* (intent: LeaveIntent) {
          unsavedDraft = false;
          const main = yield* electronWindow.main;
          if (intent === "close" && Option.isSome(main)) {
            main.value.close();
          }
        });

        return DesktopWindow.of({
          open,
          present,
          recordUnsavedDraft: (unsaved) =>
            Effect.sync(() => {
              unsavedDraft = unsaved;
            }),
          askToLeave,
          leave,
          releaseForQuit: Effect.sync(() => {
            quitting = true;
          }),
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
