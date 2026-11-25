# fuse-deck studio desktop shell

The Electron shell of the fuse-deck studio. It runs the studio backend (`apps/studio`), serves the
studio renderer, and hands the renderer its credential.

## How it runs

- Main serves the renderer on the `fuse-deck-studio://app` scheme, from `dist/renderer` (the
  studio's build, copied in), with a Content-Security-Policy on every response
  (`makeDesktopContentSecurityPolicy`). With `FUSE_DECK_STUDIO_RENDERER_URL` set, it serves the
  dev scheme `fuse-deck-studio-dev://app` instead, proxied to the renderer's Vite dev server, and
  the policy also allows Vite's inline React Refresh preamble.
- The backend runs on the app's own executable with `ELECTRON_RUN_AS_NODE=1`, so the app ships
  one runtime. Electron 44 embeds Node 24.22, which runs Vite 8.3 and Rolldown's native binding.
- Each backend run gets a fresh launch document on stdin: a one-use bootstrap credential, the
  renderer's origin and the user data directory. Main keeps stdin open; the backend exits when
  it closes, so a crashed main leaves no backend behind.
- A run is ready once it has printed its one `StudioReady` document on stdout and main has traded
  the run's bootstrap credential for the session bearer. Main hands the renderer the address and
  bearer over IPC whenever it asks. The exchange runs once: if it fails, the answer may have been
  lost after the backend spent the credential, so main stops that run and starts one with a fresh
  credential. A backend that exits restarts after a delay that doubles from 500 ms to 10 s, and
  the renderer reconnects with the new run's bearer. Quitting the app stops the backend with
  SIGTERM; the backend finishes within its 15 s stop deadline, and SIGKILL follows only after
  20 s.
- `FUSE_DECK_STUDIO_DECK`, when set, names a deck the renderer opens at start. Without it the
  studio starts empty.
- The packaged app carries a production npm install of the studio backend, React, React DOM and
  the pinned Fuse in `Contents/Resources/backend`, outside `app.asar`, with its
  `package-lock.json`.

## Commands

```sh
pnpm --filter @elmeragroup/fuse-deck-studio-desktop test       # backend manager, real processes
pnpm exec turbo run dev --filter=@elmeragroup/fuse-deck-studio-desktop   # Electron + renderer HMR
pnpm test:packaged                                              # package, then the packaged smoke test
```

`test:packaged` packages an unsigned macOS arm64 app into `.artifacts/release`, copies it and the
fixture deck in `test/fixtures/deck` to a temporary directory, and launches it there with
`PATH=/usr/bin:/bin`. It passes when the frame renders the slide's Fuse Button, the window
recovers after the test kills the backend with an unsaved draft still in the Source tab, main
refuses to present another 127.0.0.1 port, Present opens the second slide fullscreen in a window
without the preload and Escape closes it, closing the window and quitting both ask about the draft
(Cancel keeps the window and the app, Save on a quit writes the draft), and the app exits 0 after
its backend exits.

Code derived from T3 Code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
