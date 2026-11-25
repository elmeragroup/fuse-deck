/**
 * Serves the built renderer from its own 127.0.0.1 origin, as a browser tab would load it, under
 * the policy the desktop app sends with every renderer response (apps/desktop's
 * `makeDesktopContentSecurityPolicy`, restated here so the test does not read it from the app).
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER = fileURLToPath(new URL("../dist/renderer", import.meta.url));

/** The desktop app's packaged renderer policy. */
export const RENDERER_POLICY = [
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

function contentType(file: string): string {
  switch (path.extname(file)) {
    case ".html":
      return "text/html";
    case ".js":
      return "text/javascript";
    case ".css":
      return "text/css";
    default:
      return "application/octet-stream";
  }
}

/** A running renderer server. */
export type RendererServer = {
  /** The renderer's origin, `http://127.0.0.1:<port>`. */
  readonly origin: string;
  readonly close: () => Promise<void>;
};

/**
 * Serve the built renderer.
 *
 * @returns The server, listening.
 */
export async function serveRenderer(): Promise<RendererServer> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://renderer").pathname;
    const file = path.join(RENDERER, pathname === "/" ? "index.html" : pathname);
    readFile(file).then(
      (body) => {
        response.writeHead(200, {
          "content-type": contentType(file),
          "content-security-policy": RENDERER_POLICY,
        });
        response.end(body);
      },
      () => {
        response.writeHead(404).end();
      }
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a TCP server listening on a port reports an AddressInfo, never a pipe name or null.
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
