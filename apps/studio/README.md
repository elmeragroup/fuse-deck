# fuse-deck studio

The studio's backend and renderer. The desktop app (`apps/desktop`) runs the backend, serves the
renderer and connects the two. Nothing here is published: the desktop app stages the packed
backend and ships the built renderer.

## Backend (`src/server`)

Node and Effect, bundled by tsdown into `dist/server/bin.mjs` with deck-core inlined. It reads one
launch document from stdin, listens on 127.0.0.1, prints `{"_tag":"StudioReady","url"}`, and
stops when stdin closes or on SIGTERM. A stop closes the RPC socket, drains the open deck and
stops the HTTP server, within `BACKEND_STOP_DEADLINE` (15 s).

- `POST /api/session` trades the one-use bootstrap credential for the session bearer.
- `POST /api/ticket` trades the bearer for a WebSocket ticket, good for one upgrade within 30 s.
- `GET /ws?ticket=` is the renderer's `effect/rpc` socket (`src/contract/studio-rpc.ts`).
- Each route takes only the renderer's exact Origin (the session exchange also takes none, as main
  sends it), CORS allows that origin alone, and nothing sets a cookie.
- The backend starts with no deck. `deck.open` closes the open deck first: it stops admitting
  calls, lets admitted ones settle for up to 10 s and cancels the rest, then stops its dev server.
  Each opening serves the deck on its own listener on a fresh 127.0.0.1 port, with Vite in
  middleware mode behind it, Vite's CORS off and `frame-ancestors` set to the renderer, and gets
  its own scope id, which every deck call carries. In middleware mode Vite installs none of the
  SIGTERM and stdin handlers that would end the process before the drain.
- `deck.changed` reports once as soon as it listens, then after each edit on disk. The slide list
  reads the deck on every report, so it follows the disk, the studio's own reorders included.
- Recent decks live in `recent-decks.json` in the user data directory.

## Renderer (`src/renderer`)

React 19, TanStack Router and Fuse components, built by Vite into `dist/renderer`, or served on
127.0.0.1:5733 with HMR by `pnpm dev`. In the desktop app it reaches main through the preload's
`window.fuseDeckStudio`. Without that bridge it is the browser-tab test harness, which reads
`#backend=…&bootstrap=…` (or `&bearer=…`, and `&deck=…`) from its address and clears it.

The preview frames the deck's dev server. deck-core's runtime posts `{ scopeId, slideId, step }`
to the studio after each position change, and the studio accepts one only from the current
frame's window, the deck's origin and the current scope id.

## Tests

```sh
pnpm --filter @elmeragroup/fuse-deck-studio test           # deck scopes in-process, the spawned backend
pnpm --filter @elmeragroup/fuse-deck-studio test:browser   # the built renderer and backend in Chromium
```
