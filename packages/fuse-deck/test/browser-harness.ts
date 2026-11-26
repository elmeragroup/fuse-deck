import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "playwright";

/** The built bin, the file the packed tarball ships. Turbo builds it before this suite runs. */
export const BIN = fileURLToPath(new URL("../dist/bin.mjs", import.meta.url));

/** Runs the built `fuse-deck` CLI synchronously in `cwd`, throwing if it exits non-zero. */
export function fuseDeck(cwd: string, args: readonly string[]): void {
  const run = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(`fuse-deck ${args.join(" ")} exited ${String(run.status)}: ${run.stdout}${run.stderr}`);
  }
}

function contentType(extension: string): string {
  switch (extension) {
    case ".html":
      return "text/html";
    case ".js":
      return "text/javascript";
    case ".css":
      return "text/css";
    case ".mp4":
      return "video/mp4";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

/** Serves a built deck over loopback HTTP, the way any static host would. */
export async function serve(
  root: string
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://deck").pathname;
    const file = path.join(root, pathname === "/" ? "index.html" : pathname);
    stat(file).then(
      () => {
        response.writeHead(200, {
          "content-type": contentType(path.extname(file)),
        });
        createReadStream(file).pipe(response);
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
    url: `http://127.0.0.1:${String(port)}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Waits until the browser's `location.hash` matches `hash`. */
export async function at(page: Page, hash: string): Promise<void> {
  await page.waitForFunction((expected) => location.hash === expected, hash);
}

/**
 * Samples one RGBA pixel from a locator screenshot at normalized coordinates
 * (defaulting to the center `{ x: 0.5, y: 0.5 }`).
 */
export async function pixelRgba(
  page: Page,
  locator: Locator,
  point: { readonly x: number; readonly y: number } = { x: 0.5, y: 0.5 }
): Promise<readonly number[] | null> {
  const screenshot = await locator.screenshot();
  const dataUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
  return page.evaluate(
    async ({ url, x, y }) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const probe = document.createElement("canvas");
      probe.width = image.width;
      probe.height = image.height;
      const ctx = probe.getContext("2d");
      if (ctx === null) {
        return null;
      }
      ctx.drawImage(image, 0, 0);
      const px = Math.min(image.width - 1, Math.max(0, Math.floor(image.width * x)));
      const py = Math.min(image.height - 1, Math.max(0, Math.floor(image.height * y)));
      const pixel = ctx.getImageData(px, py, 1, 1).data;
      return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, pixel[3] ?? 0];
    },
    { url: dataUrl, x: point.x, y: point.y }
  );
}
