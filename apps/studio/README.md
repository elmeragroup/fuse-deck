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

### The agent chat

Each open deck has one agent chat (`src/server/agent-chats.ts`), which the renderer follows with
`agent.chat` and drives with `agent.prompt`, `agent.stop` and `agent.decide`.

- A deck is untrusted, so the agent's launch takes nothing from it. The first prompt installs
  `@agentclientprotocol/claude-agent-acp@0.109.0` into `<user data>/agent` with
  `npm install --ignore-scripts`, unless that release is there already, and runs the package's
  `bin` entry on the backend's own Node (Electron's, with `ELECTRON_RUN_AS_NODE=1`, in the desktop
  app). The agent runs from `<user data>/agent`, in its own process group, with
  `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1`, Claude Code's background tasks off
  (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`) and PATH from the login shell on macOS, cut to its
  absolute entries whose real path exists outside the deck; the install runs the first `npm` on
  that same PATH by its absolute path. Each session works in a directory of its own under
  `<user data>/agent-sessions`, removed when the session ends, since the adapter and the Claude CLI
  read the settings in a session's working directory, helper commands such as `apiKeyHelper`
  included. It holds only `.claude/settings.local.json` with `permissions.defaultMode: "default"`,
  which the adapter opens the session in; without it the adapter falls back to `auto`. The deck reaches the agent as the session's additional directory
  (`additionalDirectories` of `session/new`), with its path in the system prompt
  (`_meta.systemPrompt.append`). Its `_meta.claudeCode.options` keep Claude Code to the user's
  own settings (`settingSources: ["user"]`), the MCP servers the studio names (`strictMcpConfig`), Stop
  stopping background tasks, and no bypass mode, so the deck's `.claude` settings, hooks and
  `.mcp.json` never load. `settings.json` in the user data directory can name a local command
  instead, which runs from the same directory, and a file to log every ACP message to:
  `{ "agent": { "command", "args", "protocolLog" } }`.
- The studio speaks ACP through `@elmeragroup/effect-acp` and offers no client file system or
  terminal; the agent edits the deck with its own tools. The session runs in the `default`
  permission mode, set through its `mode` config option (ACP v2) or `session/set_mode` (v1). An
  agent that does not confirm that mode gets no prompt.
- A prompt carries the view as text, the slide id and step, after checking that the deck still
  has that slide. When the agent advertises embedded context, the slide's source goes along as a
  resource.
- One turn runs at a time. Each permission request shows the agent's choices and its diff, patch
  or named changes, and waits for the user. Stop, the end of the turn, the agent's exit, a closed
  connection and the agent dropping the request each settle it as cancelled.
- Stop sends `session/cancel` and keeps the turn `Stopping`, which keeps Source read-only, until
  the agent ends the turn. An agent that has not ended it 15 s after Stop is stopped with its
  process group; the next prompt starts a new one. The session otherwise stays for the next
  prompt.
- Closing or switching the deck ends the agent first: its process group gets SIGTERM, then
  SIGKILL a second later, before the deck's admitted calls drain.
- Each turn snapshots `deck.json` and `slides/*.mdx` as it starts, each through its real path and
  only when that is a regular file inside the deck, as the slide a prompt embeds is read. `changes.list` compares that
  snapshot with the disk: the Changes tab shows the result as observed changes, with no undo.

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
pnpm --filter @elmeragroup/fuse-deck-studio test           # deck scopes and agent chats in-process, the spawned backend
pnpm --filter @elmeragroup/fuse-deck-studio test:browser   # the built renderer and backend in Chromium
```
