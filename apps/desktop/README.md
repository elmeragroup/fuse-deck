# fuse-deck studio desktop shell

The Electron shell of the fuse-deck studio. In this first phase it opens one deck: it runs
`fuse-deck dev --json` in the directory that `FUSE_DECK_STUDIO_DECK` names and frames the deck
in a stub page. The studio's own backend and renderer replace the stub in later phases.

## How it runs

- Main serves the stub page from `dist/renderer` on the `fuse-deck-studio://app` scheme, with a
  Content-Security-Policy on every response (`makeDesktopContentSecurityPolicy`).
- The backend is the packed fuse-deck, run on the app's own executable with
  `ELECTRON_RUN_AS_NODE=1`, so the app ships one runtime. Electron 44 embeds Node 24.22, which
  runs Vite 8.3 and Rolldown's native binding.
- The backend's readiness is the one `DevServerReady` document it prints on stdout. A backend that
  exits restarts after a delay that doubles from 500 ms to 10 s. Quitting the app stops it with
  SIGTERM, then SIGKILL after 5 s.
- The packaged app carries a production npm install of fuse-deck, React, React DOM and the pinned
  Fuse in `Contents/Resources/backend`, outside `app.asar`, with its `package-lock.json`.

## Commands

```sh
pnpm --filter @elmeragroup/fuse-deck-studio-desktop test     # backend manager, real processes
pnpm test:packaged                                            # package, then the packaged smoke test
```

`test:packaged` packages an unsigned macOS arm64 app into `.artifacts/release`, copies it and the
fixture deck in `test/fixtures/deck` to a temporary directory, and launches it there with
`PATH=/usr/bin:/bin`. It passes when the frame renders the slide's Fuse Button and the app exits 0
after its backend exits.

Code derived from T3 Code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
