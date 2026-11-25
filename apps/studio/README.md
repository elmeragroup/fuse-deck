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
- `slide.open` returns a slide's source with the revision of its bytes. `slide.save` saves over
  that revision through deck-core's `saveSlide`: under the deck lock it checks the revision and
  replaces the file by rename, and it compiles the saved text afterwards. A changed or deleted
  file fails with `SlideConflict`, which carries what the disk holds, and nothing is written.
  Invalid MDX still saves and comes back with its problem.
- Recent decks live in `recent-decks.json` in the user data directory.

## Renderer (`src/renderer`)

React 19, TanStack Router and Fuse components, built by Vite into `dist/renderer`, or served on
127.0.0.1:5733 with HMR by `pnpm dev`. In the desktop app it reaches main through the preload's
`window.fuseDeckStudio`. Without that bridge it is the browser-tab test harness, which reads
`#backend=…&bootstrap=…` (or `&bearer=…`, and `&deck=…`) from its address and clears it.

The center has two tabs, both kept mounted. Preview frames the deck's dev server. Source edits one
slide in a Fuse textarea: Save or Cmd/Ctrl+S saves it, a conflict keeps the draft beside the disk
state, and a `deck.changed` report about the open slide loads it into a draft without edits or
shows a notice. A save writes the line ending the file had when it was opened (the majority ending
of a mixed file). Opening another deck, closing this one or quitting the desktop app with unsaved
edits asks Save, Discard or Cancel first, and a draft stays while the backend restarts and the
deck reopens. Present opens the deck at the preview's position: a fullscreen window in the
desktop app, which main allows only on the origin the backend reports for the open deck, and the
browser's fullscreen on the preview frame in the harness.

The preview frames the deck's dev server. deck-core's runtime posts `{ scopeId, slideId, step }`
to the studio after each position change, and the studio accepts one only from the current
frame's window, the deck's origin and the current scope id.

## Tests

```sh
pnpm --filter @elmeragroup/fuse-deck-studio test           # deck scopes in-process, the spawned backend
pnpm --filter @elmeragroup/fuse-deck-studio test:browser   # the built renderer and backend in Chromium
```
