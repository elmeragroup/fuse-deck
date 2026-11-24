# Third-party notices

Parts of this package derive from the T3 Code source code
(https://github.com/pingdotgg/t3code, commit 2fe7febc). fuse-deck studio is an unofficial project
and is not affiliated with, endorsed by or maintained by T3 Tools Inc. It uses none of T3 Code's
names, logos, icons or branding.

## Files

Copied close to verbatim, under upstream's file names, from `apps/desktop/src`. Each file's header
names what changed.

- `src/boot.ts`
- `src/compileCache.ts`
- `src/electron/ElectronApp.ts`
- `src/electron/ElectronProtocol.ts`
- `src/electron/ElectronShell.ts`
- `src/electron/ElectronWindow.ts`
- `src/ipc/DesktopIpc.ts`
- `src/app/DesktopLifecycle.ts`
- `src/app/DesktopShutdown.ts`
- `src/app/DesktopState.ts`
- `src/app/stdioErrors.ts`

Ported, written to this repository's rules after the named upstream file:

- `src/backend/backend-manager.ts`, after `apps/desktop/src/backend/DesktopBackendManager.ts`
- `src/backend/backend-auth.ts`, after `apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts`
- `src/window/desktop-window.ts`, after `apps/desktop/src/window/DesktopWindow.ts`
- `src/app/desktop-app.ts`, after `apps/desktop/src/app/DesktopApp.ts`
- `src/main.ts`, after `apps/desktop/src/main.ts`
- `src/preload.ts`, after `apps/desktop/src/preload.ts`

In `apps/studio`, also ported after the named upstream file:

- `src/server/studio-auth.ts`, after `apps/server/src/auth` (the bootstrap, session and
  WebSocket-ticket flow)
- `src/contract/desktop-bridge.ts`, after `apps/desktop/src/preload.ts`
- `src/renderer/state/studio-client.ts`, after `packages/client-runtime/src/rpc/session.ts`
- `src/renderer/router.ts`, after `apps/web/src/router.ts`
- `src/server/agent-launch.ts`, the login-shell PATH capture, after `packages/shared/src/shell.ts`
- `src/server/mcp-tokens.ts`, after `apps/server/src/mcp/McpSessionRegistry.ts`

In `apps/studio`, copied close to verbatim under upstream's file names (each header names what
changed):

- `src/relay/AcpMcpStdioBridge.ts`, from `apps/server/src/mcp/AcpMcpStdioBridge.ts`
- `src/relay/mcpResponsePayloads.ts`, from `packages/shared/src/mcpResponsePayloads.ts`

The studio backend's bundle inlines `@elmeragroup/effect-acp`, which is T3 Code's
`packages/effect-acp` copied close to verbatim (`packages/effect-acp/README.md` lists the edits).

## Packages bundled into the renderer

The renderer bundles `@pierre/words`, `@pierre/diffs` and `@pierre/highlights`, each under the
Apache License 2.0. Their licence and notice files ship with the app in `dist/renderer/third-party/`.

## T3 Code licence

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
