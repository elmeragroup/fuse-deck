import * as Schema from "effect/Schema";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The built bin, the file the packed tarball ships. Turbo builds it before this suite runs. */
declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- only an interface merges into the DOM's Window
  interface Window {
    /** The view transitions the page started, recorded by the init script in `deckPage`. */
    viewTransitions?: ViewTransition[];
    /** For each view transition, the pseudo-elements it animates once it is ready. */
    viewTransitionPseudos?: Promise<string[]>[];
    /** Main-canvas clearRect calls recorded by init scripts in reduced-motion render tests. */
    ghostFiberClears?: number;
  }
}

const BIN = fileURLToPath(new URL("../dist/bin.mjs", import.meta.url));

const SLIDES = {
  cover: '---\nlayout: cover\n---\n\n<Morph name="logo"> <span>Fuse</span> </Morph>\n\n# Talk\n',
  intro:
    '# Why Fuse\n\n<Morph name="logo"><span>Fuse</span></Morph>\n\n<Step>One library</Step>\n\n<Step>[Every brand](#brands)</Step>\n\n<Step>Both densities</Step>\n',
  outro:
    '---\nlayout: section\n---\n\nimport { Button } from "@elmeragroup/fuse/button";\n\n# Thanks\n\n<Button>Ask a question</Button>\n\n<div role="slider" tabIndex={0} aria-label="Volume" aria-valuenow={5} onKeyDown={(event) => event.preventDefault()} />\n',
};

let workspace = "";
let site = "";
let browser: Browser;
let close: () => Promise<void> = () => Promise.resolve();

function fuseDeck(cwd: string, args: readonly string[]): void {
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

/** Serves the built deck, the way any static host would. */
async function serve(root: string): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
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

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "fuse-deck-browser-"));
  fuseDeck(workspace, ["create", "talk", "--brief", "Show Fuse."]);
  const deck = path.join(workspace, "talk");
  fuseDeck(deck, ["slides", "add", "intro"]);
  fuseDeck(deck, ["slides", "add", "outro"]);
  for (const [id, text] of Object.entries(SLIDES)) {
    await writeFile(path.join(deck, "slides", `${id}.mdx`), text);
  }
  fuseDeck(deck, ["build"]);
  const server = await serve(path.join(deck, "dist"));
  site = server.url;
  close = server.close;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser.close();
  await close();
  await rm(workspace, { recursive: true, force: true });
});

/** A page that counts the view transitions the document starts. */
async function deckPage(hash = "", colorScheme: "light" | "dark" = "light"): Promise<Page> {
  const page = await browser.newPage({ colorScheme });
  await page.addInitScript(() => {
    const started: ViewTransition[] = [];
    const pseudos: Promise<string[]>[] = [];
    window.viewTransitions = started;
    window.viewTransitionPseudos = pseudos;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (...args: Parameters<typeof start>) => {
      const transition = start(...args);
      started.push(transition);
      pseudos.push(
        transition.ready.then(() =>
          document
            .getAnimations()
            .map((animation) =>
              animation.effect instanceof KeyframeEffect ? animation.effect.pseudoElement : null
            )
            .filter((pseudo): pseudo is string => pseudo !== null)
        )
      );
      return transition;
    };
  });
  await page.goto(`${site}${hash}`);
  await page.locator("[aria-roledescription=slide]").waitFor();
  return page;
}

/** The pseudo-elements each view transition animated, in order. */
function viewTransitionPseudos(page: Page): Promise<string[][]> {
  return page.evaluate(() => Promise.all(window.viewTransitionPseudos ?? []));
}

/** How many view transitions the page has started, once every one has finished. */
function viewTransitionCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const started = window.viewTransitions ?? [];
    await Promise.all(started.map((transition) => transition.finished.catch(() => undefined)));
    return started.length;
  });
}

async function at(page: Page, hash: string): Promise<void> {
  await page.waitForFunction((expected) => location.hash === expected, hash);
}

/** Which of the slide's steps are revealed, in document order. */
function revealed(page: Page): Promise<boolean[]> {
  return page
    .locator("[aria-roledescription=slide] [inert], [aria-roledescription=slide] [data-revealed]")
    .evaluateAll((steps) => steps.map((step) => step.hasAttribute("data-revealed")));
}

describe("a built deck", () => {
  it("animates slide changes and never step changes, from the keyboard", async () => {
    const page = await deckPage();
    expect(await viewTransitionCount(page)).toBe(0);
    await page.keyboard.press("ArrowRight");
    await at(page, "#/intro");
    expect(await viewTransitionCount(page)).toBe(1);
    for (const step of [1, 2, 3]) {
      await page.keyboard.press("ArrowRight");
      await at(page, `#/intro/${String(step)}`);
    }
    expect(await revealed(page)).toEqual([true, true, true]);
    expect(await viewTransitionCount(page)).toBe(1);
    await page.keyboard.press("ArrowRight");
    await at(page, "#/outro");
    expect(await viewTransitionCount(page)).toBe(2);
    await expect.poll(() => page.locator("[aria-live]").textContent()).toBe("Slide 3 of 3");
    await page.close();
  });

  it("moves a Morph to its partner on the next slide, and lets an unpaired one fade", async () => {
    const page = await deckPage();
    await page.keyboard.press("ArrowRight");
    await at(page, "#/intro");
    await page.keyboard.press("End");
    await at(page, "#/outro");
    const morph = "::view-transition-group(deck-morph-logo)";
    const [toIntro, toOutro] = await viewTransitionPseudos(page);
    expect([toIntro?.includes(morph), toOutro?.includes(morph)]).toEqual([true, false]);
    await page.close();
  });

  it("opens a deep link at its step, with no view transition", async () => {
    const page = await deckPage("#/intro/2");
    expect(await page.locator("[aria-roledescription=slide]").getAttribute("aria-label")).toBe("Why Fuse");
    expect(await revealed(page)).toEqual([true, true, false]);
    expect(await page.locator("[aria-live]").textContent()).toBe("Slide 2 of 3");
    expect(await viewTransitionCount(page)).toBe(0);
    await page.close();
  });

  it("animates Back and Forward across slides, and not across steps", async () => {
    const page = await deckPage("#/intro/2");
    await page.keyboard.press("ArrowRight");
    await at(page, "#/intro/3");
    await page.keyboard.press("ArrowRight");
    await at(page, "#/outro");
    expect(await viewTransitionCount(page)).toBe(1);

    await page.goBack();
    await at(page, "#/intro/3");
    await expect
      .poll(() => page.locator("[aria-roledescription=slide]").getAttribute("aria-label"))
      .toBe("Why Fuse");
    expect(await viewTransitionCount(page)).toBe(2);

    await page.goBack();
    await at(page, "#/intro/2");
    await expect.poll(() => revealed(page)).toEqual([true, true, false]);
    expect(await viewTransitionCount(page)).toBe(2);

    await page.goForward();
    await expect.poll(() => revealed(page)).toEqual([true, true, true]);
    expect(await viewTransitionCount(page)).toBe(2);

    await page.goForward();
    await at(page, "#/outro");
    await expect
      .poll(() => page.locator("[aria-roledescription=slide]").getAttribute("aria-label"))
      .toBe("Thanks");
    expect(await viewTransitionCount(page)).toBe(3);
    await page.close();
  });

  it("corrects an address past the last step in place, so Back leaves it", async () => {
    const page = await deckPage("#/intro");
    await page.evaluate(() => {
      location.hash = "#/intro/99";
    });
    await at(page, "#/intro/3");
    await page.goBack();
    await at(page, "#/intro");
    await expect.poll(() => revealed(page)).toEqual([false, false, false]);
    await page.close();
  });

  it("keeps unrevealed steps out of focus and out of sight", async () => {
    const page = await deckPage("#/intro/1");
    const link = page.getByRole("link", { name: "Every brand", includeHidden: true });
    const step = page
      .locator("[aria-roledescription=slide] :is([inert], [data-revealed])")
      .filter({ has: link });
    expect(
      await step.evaluate((element) => [
        element instanceof HTMLElement && element.inert,
        getComputedStyle(element).opacity,
      ])
    ).toEqual([true, "0"]);
    await link.focus();
    expect(await link.evaluate((element) => element === document.activeElement)).toBe(false);

    await page.keyboard.press("ArrowRight");
    await at(page, "#/intro/2");
    await link.focus();
    expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  });

  it("leaves keys to a focused control that uses them, and renders a Fuse component a slide imports", async () => {
    const page = await deckPage("#/outro");
    const button = page.getByRole("button", { name: "Ask a question" });
    expect(await button.getAttribute("data-slot")).toBe("button");
    await button.evaluate((element) => {
      element.addEventListener("click", () => {
        element.dataset.clicks = String(Number(element.dataset.clicks ?? 0) + 1);
      });
    });
    await button.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press(" ");
    expect(await button.getAttribute("data-clicks")).toBe("2");
    expect(await page.evaluate(() => location.hash)).toBe("#/outro");
    // The slider handles its arrows and prevents their default, so the deck stays put.
    await page.getByRole("slider", { name: "Volume" }).focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Home");
    expect(await page.evaluate(() => location.hash)).toBe("#/outro");
    await button.focus();
    await page.keyboard.press("ArrowLeft");
    await at(page, "#/intro/3");
    await page.close();
  });

  it("paints the theme and each color scheme's background before any module runs", async () => {
    const backgrounds: string[] = [];
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ colorScheme });
      await page.route("**/*.js", (route) => route.abort());
      await page.goto(site);
      const paint = await page.evaluate(() => ({
        identity: document.documentElement.dataset.themeIdentity,
        brand: document.documentElement.dataset.themeBrand,
        segment: document.documentElement.dataset.themeSegment,
        density: document.documentElement.dataset.density,
        scheme: document.documentElement.dataset.theme,
        background: getComputedStyle(document.body).backgroundColor,
        rendered: document.querySelector("[aria-roledescription=slide]") !== null,
      }));
      expect(paint).toMatchObject({
        identity: "neutral",
        brand: "elma",
        segment: "private",
        density: "comfortable",
        scheme: colorScheme,
        rendered: false,
      });
      backgrounds.push(paint.background);
      await page.close();
    }
    expect(backgrounds).not.toContain("rgba(0, 0, 0, 0)");
    expect(new Set(backgrounds).size).toBe(2);

    const html = await (await fetch(site)).text();
    const stylesheet = html.search(/<link[^>]*rel="stylesheet"/);
    const bootstrap = html.indexOf("<script>");
    const entry = html.search(/<script[^>]*type="module"/);
    expect(stylesheet).toBeGreaterThan(-1);
    expect([stylesheet < bootstrap, bootstrap < entry]).toEqual([true, true]);
  });
});

describe("a deck in dev", () => {
  it("loads a slide that imports a Fuse component with one optimizer run, and no reload", async () => {
    const deck = path.join(workspace, "talk");
    // A fresh cache, so the start optimizes every dependency anew.
    const child = spawn(process.execPath, [BIN, "dev", "--json"], {
      cwd: deck,
      env: { ...process.env, XDG_CACHE_HOME: path.join(workspace, "dev-cache") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes("\n")) {
            resolve(stdout.slice(0, stdout.indexOf("\n")));
          }
        });
        child.on("exit", () => reject(new Error(`dev exited before it was ready: ${stderr}`)));
      });
      const { url } = Schema.decodeSync(
        Schema.fromJsonString(Schema.TaggedStruct("DevServerReady", { url: Schema.String }))
      )(line);
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          errors.push(message.text());
        }
      });
      await page.goto(`${url}#/outro`);
      await page.getByRole("button", { name: "Ask a question" }).waitFor();
      await page.waitForLoadState("networkidle");
      await page.close();
      // Without the slides in the first run, Vite found the slide's Fuse import late, re-optimized
      // and reloaded the page, which meanwhile held two copies of React.
      expect({ errors, reloaded: stderr.includes("optimized dependencies changed") }).toEqual({
        errors: [],
        reloaded: false,
      });
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  });
});

/** Valid 16x16 H.264 MP4 fixture (0.1 s), kept inline so tests need no media encoder in CI. */
const TINY_MP4 = Buffer.from(
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANdbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAHgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAod0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAB4AAAEAAABAAAAAAH/bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAABgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABqm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAWpzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2My4yNC4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAL7iAAAAAAAAABhzdHRzAAAAAAAAAAEAAAADAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAKGN0dHMAAAAAAAAAAwAAAAEAAAQAAAAAAQAABgAAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAwAAAAEAAAAgc3RzegAAAAAAAAAAAAAAAwAAAsUAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAONAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2My4xNi4xMDAAAAAIZnJlZQAAAuVtZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAD2WIhAAz//727L4FNhTIwQAAAAhBmiJsQr/+wAAAAAgBnkF5Cv/EgQ==",
  "base64"
);

const MULTILINE_TAGLINE =
  "Preferred by more customers across every Nordic energy market, every single day of the year, delivering reliable power and transparent service.";
const UNBROKEN_TAGLINE = "elmeragroupnordic202".repeat(10);
const NARROW_SPLIT_TAGLINE =
  "Preferred by more customers across every Nordic energy market, every single day of the year, delivering reliable power, transparent service, and lasting clarity.";

async function centerPixelRgba(page: Page, locator: Locator): Promise<readonly number[] | null> {
  const screenshot = await locator.screenshot();
  const dataUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
  return page.evaluate(async (url) => {
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
    const pixel = ctx.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;
    return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, pixel[3] ?? 0];
  }, dataUrl);
}

describe("a built deck with video and blank slides", () => {
  let mediaSite = "";
  let closeMedia: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    fuseDeck(workspace, ["create", "media-talk"]);
    const deck = path.join(workspace, "media-talk");
    await mkdir(path.join(deck, "assets"), { recursive: true });
    await writeFile(path.join(deck, "assets", "clip.mp4"), TINY_MP4);
    fuseDeck(deck, ["slides", "add", "demo", "--layout", "center"]);
    fuseDeck(deck, ["slides", "add", "raw", "--layout", "blank"]);
    fuseDeck(deck, ["slides", "add", "chart"]);
    fuseDeck(deck, ["slides", "add", "elmera", "--layout", "center"]);
    fuseDeck(deck, ["slides", "add", "elmera-fiber", "--layout", "center"]);
    fuseDeck(deck, ["slides", "add", "elmera-sibling", "--layout", "center"]);
    fuseDeck(deck, ["slides", "add", "elmera-wrapped-sibling", "--layout", "center"]);
    fuseDeck(deck, ["slides", "add", "elmera-multiline", "--layout", "center"]);
    fuseDeck(deck, ["slides", "add", "elmera-unbroken", "--layout", "center"]);
    fuseDeck(deck, ["slides", "add", "elmera-narrow-split", "--layout", "center"]);
    fuseDeck(deck, ["slides", "add", "elmera-no-tagline", "--layout", "center"]);
    fuseDeck(deck, ["slides", "add", "elmera-step", "--layout", "center"]);
    fuseDeck(deck, ["slides", "add", "elmera-nested-step", "--layout", "center"]);
    fuseDeck(deck, ["slides", "add", "elmera-negative-z", "--layout", "center"]);
    const deckJson = path.join(deck, "deck.json");
    const rawManifest = await readFile(deckJson, "utf8");
    await writeFile(
      deckJson,
      rawManifest.replace('"aspect": "16:9",', '"aspect": "16:9",\n  "locale": "nb-NO",')
    );
    await writeFile(
      path.join(deck, "slides", "demo.mdx"),
      '---\nlayout: center\n---\n\nimport clip from "../assets/clip.mp4";\n\n<Video src={clip} title="Product demo" muted />\n'
    );
    await writeFile(
      path.join(deck, "slides", "raw.mdx"),
      '---\nlayout: blank\n---\n\nimport clip from "../assets/clip.mp4";\n\n<video src={clip} controls muted />\n'
    );
    await writeFile(
      path.join(deck, "slides", "chart.mdx"),
      [
        'import { LiveLineChart } from "@elmeragroup/fuse/chart";',
        "",
        "export const points = [",
        "  { time: Date.now() - 20_000, value: 12 },",
        "  { time: Date.now() - 10_000, value: 48 },",
        "  { time: Date.now(), value: 96 },",
        "];",
        "",
        "# Velocity",
        "",
        '<Split ratio="2:3" align="center">',
        "  <div>",
        "    <p>Steady pace</p>",
        "  </div>",
        '  <LiveLineChart.Root data={points} windowMs={30_000} timeZone="Europe/Oslo" paused aria-label="Weekly velocity">',
        '    <LiveLineChart.Grid variant="dashed" />',
        '    <LiveLineChart.Area variant="solid" curve="monotone" />',
        '    <LiveLineChart.Line curve="monotone" />',
        '    <LiveLineChart.LiveDot variant="default" />',
        "    <LiveLineChart.Badge />",
        "    <LiveLineChart.XAxis />",
        "    <LiveLineChart.YAxis />",
        "  </LiveLineChart.Root>",
        "</Split>",
        "",
      ].join("\n")
    );
    await writeFile(path.join(deck, "slides", "elmera.mdx"), "---\nlayout: center\n---\n\n<ElmeraCover />\n");
    await writeFile(
      path.join(deck, "slides", "elmera-fiber.mdx"),
      '---\nlayout: center\n---\n\n<ElmeraCover background="ghost-fiber" />\n'
    );
    await writeFile(
      path.join(deck, "slides", "elmera-sibling.mdx"),
      [
        "---",
        "layout: center",
        "---",
        "",
        "<Split>",
        '  <ElmeraCover background="ghost-fiber" />',
        '  <div data-swatch="black" style={{ width: "100%", height: "100%", backgroundColor: "rgb(0, 0, 0)" }} />',
        "</Split>",
        "",
      ].join("\n")
    );
    await writeFile(
      path.join(deck, "slides", "elmera-wrapped-sibling.mdx"),
      [
        "---",
        "layout: center",
        "---",
        "",
        "<Split>",
        '  <div style={{ position: "relative", width: "50%", height: "100%", zIndex: 1, display: "flex" }}>',
        '    <ElmeraCover background="ghost-fiber" />',
        "  </div>",
        '  <div data-swatch="black" style={{ width: "100%", height: "100%", backgroundColor: "rgb(0, 0, 0)" }} />',
        "</Split>",
        "",
      ].join("\n")
    );
    await writeFile(
      path.join(deck, "slides", "elmera-multiline.mdx"),
      [
        "---",
        "layout: center",
        "---",
        "",
        `<ElmeraCover tagline=${JSON.stringify(MULTILINE_TAGLINE)} />`,
        "",
      ].join("\n")
    );
    await writeFile(
      path.join(deck, "slides", "elmera-unbroken.mdx"),
      [
        "---",
        "layout: center",
        "---",
        "",
        `<ElmeraCover tagline=${JSON.stringify(UNBROKEN_TAGLINE)} />`,
        "",
      ].join("\n")
    );
    await writeFile(
      path.join(deck, "slides", "elmera-narrow-split.mdx"),
      [
        "---",
        "layout: center",
        "---",
        "",
        '<Split ratio="1:2">',
        `  <ElmeraCover tagline=${JSON.stringify(NARROW_SPLIT_TAGLINE)} />`,
        "  <div />",
        "</Split>",
        "",
      ].join("\n")
    );
    await writeFile(
      path.join(deck, "slides", "elmera-no-tagline.mdx"),
      "---\nlayout: center\n---\n\n<ElmeraCover tagline={null} />\n"
    );
    await writeFile(
      path.join(deck, "slides", "elmera-step.mdx"),
      [
        "---",
        "layout: center",
        "---",
        "",
        "<Step>",
        '  <ElmeraCover background="ghost-fiber" />',
        "</Step>",
        "",
      ].join("\n")
    );
    await writeFile(
      path.join(deck, "slides", "elmera-nested-step.mdx"),
      [
        "---",
        "layout: center",
        "---",
        "",
        "<Step>",
        "  Outer",
        "  <Step>",
        '    <ElmeraCover background="ghost-fiber" />',
        "  </Step>",
        "</Step>",
        "",
      ].join("\n")
    );
    await writeFile(
      path.join(deck, "slides", "elmera-negative-z.mdx"),
      [
        "---",
        "layout: center",
        "---",
        "",
        "<Split>",
        '  <ElmeraCover background="ghost-fiber" />',
        '  <div style={{ width: "100%", height: "100%" }}>',
        '    <div data-swatch="negative-z" style={{ position: "absolute", top: 0, right: 0, width: "50%", height: "100%", zIndex: -2, backgroundColor: "rgb(0, 0, 0)" }} />',
        "  </div>",
        "</Split>",
        "",
      ].join("\n")
    );
    fuseDeck(deck, ["build"]);
    const server = await serve(path.join(deck, "dist"));
    mediaSite = server.url;
    closeMedia = server.close;
  }, 120_000);

  afterAll(async () => {
    await closeMedia();
  });

  it("lazily opens <Video> into an overlay that keeps keyboard navigation until Escape or ended", async () => {
    const page = await browser.newPage();
    await page.goto(`${mediaSite}#/demo`);
    await page.locator("[aria-roledescription=slide]").waitFor();

    const play = page.getByRole("button", { name: "Play Product demo" });
    await play.waitFor();
    expect(await play.getAttribute("data-slot")).toBe("button");
    expect(await page.locator("video").count()).toBe(0);
    const font = await page.evaluate(async () => {
      await document.fonts.ready;
      const slide = document.querySelector("[aria-roledescription=slide]");
      return {
        family: slide ? getComputedStyle(slide).fontFamily : "",
        loaded: document.fonts.check('16px "Inter Variable"'),
      };
    });
    expect(font.family).toContain("Inter Variable");
    expect(font.loaded).toBe(true);

    await play.click();
    const dialog = page.getByRole("dialog", { name: "Product demo" });
    await dialog.waitFor();
    const video = dialog.locator("video");
    await video.waitFor();
    expect(await video.evaluate((element) => element === document.activeElement)).toBe(true);

    // While the overlay is open, Space and ArrowRight stay with the video instead of changing slides.
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => location.hash)).toBe("#/demo");

    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator("video").count()).toBe(0);
    expect(await play.evaluate((element) => element === document.activeElement)).toBe(true);

    // Ending playback returns to the resting trigger so ArrowRight advances cleanly.
    await play.click();
    await video.waitFor();
    await video.evaluate((element) => {
      element.dispatchEvent(new Event("ended"));
    });
    await expect.poll(() => page.locator("video").count()).toBe(0);
    expect(await play.evaluate((element) => element === document.activeElement)).toBe(true);

    await page.keyboard.press("ArrowRight");
    await at(page, "#/raw");
    await page.close();
  });

  it("leaves media keys to a focused raw <video> on a blank slide", async () => {
    const page = await browser.newPage();
    await page.goto(`${mediaSite}#/raw`);
    const slide = page.locator("[aria-roledescription=slide]");
    await slide.waitFor();
    expect(await slide.getAttribute("data-layout")).toBe("blank");

    const video = slide.locator("video");
    await video.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    expect(await page.evaluate(() => location.hash)).toBe("#/raw");
    await page.close();
  });

  it("composes prose beside a Fuse LiveLineChart inside <Split> without errors", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    await page.goto(`${mediaSite}#/chart`);
    const slide = page.locator("[aria-roledescription=slide]");
    await slide.waitFor();

    expect(await page.evaluate(() => document.documentElement.lang)).toBe("nb-NO");
    expect(await slide.locator("[data-ratio='2:3'][data-align='center']").count()).toBe(1);
    const figure = page.getByRole("figure", { name: "Weekly velocity" });
    await figure.waitFor();
    await expect.poll(() => figure.locator("svg path").count()).toBeGreaterThan(0);

    // Focusing the chart's plot lets ArrowLeft step readings instead of leaving the slide.
    const plot = figure.getByRole("listbox");
    await plot.focus();
    await page.keyboard.press("ArrowLeft");
    expect(await page.evaluate(() => location.hash)).toBe("#/chart");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("renders <ElmeraCover> with Fuse's Elmera Group logo and Inter tagline", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${mediaSite}#/elmera`);
    const slide = page.locator("[aria-roledescription=slide]");
    await slide.waitFor();

    const logo = slide.getByRole("img", { name: "Elmera Group" });
    await logo.waitFor();
    const tagline = slide.getByText("Preferred by more customers. Every day.");
    await tagline.waitFor();
    expect(await slide.locator("canvas").count()).toBe(0);
    expect(await tagline.evaluate((element) => getComputedStyle(element).fontFamily)).toContain(
      "Inter Variable"
    );
    expect(errors).toEqual([]);
    await page.close();
  });

  it("renders the opt-in monochrome ghost-fiber background edge-to-edge on <ElmeraCover>", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1600, height: 720 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${mediaSite}#/elmera-fiber`);
    const slide = page.locator("[aria-roledescription=slide]");
    await slide.waitFor();

    await slide.getByRole("img", { name: "Elmera Group" }).waitFor();
    const canvas = slide.locator("canvas");
    await canvas.waitFor();
    expect(await slide.locator("[data-background='ghost-fiber']").count()).toBeGreaterThan(0);
    const viewportBox = await page.locator(".deck-viewport").boundingBox();
    const slideBox = await slide.boundingBox();
    const canvasBox = await canvas.boundingBox();
    expect(viewportBox).not.toBeNull();
    expect(slideBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    if (viewportBox !== null && slideBox !== null && canvasBox !== null) {
      expect(canvasBox.width).toBeGreaterThan(slideBox.width);
      expect(Math.round(canvasBox.width)).toBe(Math.round(viewportBox.width));
      expect(Math.round(canvasBox.height)).toBe(Math.round(viewportBox.height));
    }
    expect(errors).toEqual([]);
    await page.close();
  });

  it("paints ghost-fiber behind sibling slide content so a black swatch keeps its exact color", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 720 },
    });
    await page.goto(`${mediaSite}#/elmera-sibling`);
    const slide = page.locator("[aria-roledescription=slide]");
    await slide.waitFor();
    await slide.locator("canvas").waitFor();

    const swatch = slide.locator("[data-swatch='black']");
    await swatch.waitFor();
    expect(await centerPixelRgba(page, swatch)).toEqual([0, 0, 0, 255]);
    await page.close();
  });

  it("keeps ghost-fiber viewport-sized and behind siblings when <ElmeraCover> is inside a positioned z-index wrapper", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1600, height: 720 },
    });
    await page.goto(`${mediaSite}#/elmera-wrapped-sibling`);
    const slide = page.locator("[aria-roledescription=slide]");
    await slide.waitFor();
    const canvas = slide.locator("canvas");
    await canvas.waitFor();
    const swatch = slide.locator("[data-swatch='black']");
    await swatch.waitFor();

    const viewportBox = await page.locator(".deck-viewport").boundingBox();
    const slideBox = await slide.boundingBox();
    const canvasBox = await canvas.boundingBox();
    expect(viewportBox).not.toBeNull();
    expect(slideBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    if (viewportBox !== null && slideBox !== null && canvasBox !== null) {
      expect(canvasBox.width).toBeGreaterThan(slideBox.width);
      expect(Math.round(canvasBox.x)).toBe(Math.round(viewportBox.x));
      expect(Math.round(canvasBox.y)).toBe(Math.round(viewportBox.y));
      expect(Math.round(canvasBox.width)).toBe(Math.round(viewportBox.width));
      expect(Math.round(canvasBox.height)).toBe(Math.round(viewportBox.height));
    }

    expect(await centerPixelRgba(page, swatch)).toEqual([0, 0, 0, 255]);
    await page.close();
  });

  it("keeps the <ElmeraCover> wordmark centered with multi-line and long unbroken taglines", async () => {
    const fixtures = [
      { hash: "#/elmera-multiline", text: MULTILINE_TAGLINE },
      { hash: "#/elmera-unbroken", text: UNBROKEN_TAGLINE },
    ] as const;

    for (const fixture of fixtures) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      try {
        await page.goto(`${mediaSite}${fixture.hash}`);
        const slide = page.locator("[aria-roledescription=slide]");
        await slide.waitFor();
        const logo = slide.getByRole("img", { name: "Elmera Group" });
        await logo.waitFor();
        const tagline = slide.getByText(fixture.text, { exact: true });
        await tagline.waitFor();

        const slideBox = await slide.boundingBox();
        const logoBox = await logo.boundingBox();
        const taglineBox = await tagline.boundingBox();
        expect(slideBox).not.toBeNull();
        expect(logoBox).not.toBeNull();
        expect(taglineBox).not.toBeNull();
        if (slideBox !== null && logoBox !== null && taglineBox !== null) {
          const slideMidX = slideBox.x + slideBox.width / 2;
          const slideMidY = slideBox.y + slideBox.height / 2;
          const logoMidX = logoBox.x + logoBox.width / 2;
          const logoMidY = logoBox.y + logoBox.height / 2;
          const deltaX = Math.abs(logoMidX - slideMidX);
          const deltaY = Math.abs(logoMidY - slideMidY);
          const taglineInsideHorizontally =
            taglineBox.x >= slideBox.x - 1 &&
            taglineBox.x + taglineBox.width <= slideBox.x + slideBox.width + 1;
          expect({
            hash: fixture.hash,
            centeredX: deltaX <= 2,
            centeredY: deltaY <= 2,
            taglineInsideHorizontally,
          }).toEqual({
            hash: fixture.hash,
            centeredX: true,
            centeredY: true,
            taglineInsideHorizontally: true,
          });
        }
      } finally {
        await page.close();
      }
    }
  });

  it('does not clip a wrapped tagline in a narrow <Split ratio="1:2"> column while keeping the wordmark centered', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await page.goto(`${mediaSite}#/elmera-narrow-split`);
      const slide = page.locator("[aria-roledescription=slide]");
      await slide.waitFor();
      const logo = slide.getByRole("img", { name: "Elmera Group" });
      await logo.waitFor();
      const tagline = slide.getByText(NARROW_SPLIT_TAGLINE, { exact: true });
      await tagline.waitFor();
      await page.evaluate(() => document.fonts.ready);

      const overflow = await tagline.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      const slideBox = await slide.boundingBox();
      const logoBox = await logo.boundingBox();
      const taglineBox = await tagline.boundingBox();
      expect(slideBox).not.toBeNull();
      expect(logoBox).not.toBeNull();
      expect(taglineBox).not.toBeNull();
      if (slideBox !== null && logoBox !== null && taglineBox !== null) {
        const slideMidY = slideBox.y + slideBox.height / 2;
        const logoMidY = logoBox.y + logoBox.height / 2;
        expect({
          unclipped: overflow.scrollHeight <= overflow.clientHeight,
          fitsInsideSlide: taglineBox.y + taglineBox.height <= slideBox.y + slideBox.height + 1,
          centeredY: Math.abs(logoMidY - slideMidY) <= 2,
        }).toEqual({
          unclipped: true,
          fitsInsideSlide: true,
          centeredY: true,
        });
      }
    } finally {
      await page.close();
    }
  });

  it("omits the tagline element when <ElmeraCover tagline={null} /> is passed", async () => {
    const page = await browser.newPage();
    await page.goto(`${mediaSite}#/elmera-no-tagline`);
    const slide = page.locator("[aria-roledescription=slide]");
    await slide.waitFor();
    await slide.getByRole("img", { name: "Elmera Group" }).waitFor();
    expect(await slide.locator(".deck-elmera-cover-tagline").count()).toBe(0);
    await page.close();
  });

  it("draws ghost-fiber once on mount and once on resize under reduced motion", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1600, height: 720 },
    });
    await page.addInitScript(() => {
      window.ghostFiberClears = 0;
      // oxlint-disable-next-line typescript/unbound-method -- saves prototype method and re-binds via .call(this, ...)
      const originalClearRect = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function clearRect(
        x: number,
        y: number,
        w: number,
        h: number
      ) {
        if (this.canvas.isConnected) {
          window.ghostFiberClears = (window.ghostFiberClears ?? 0) + 1;
        }
        originalClearRect.call(this, x, y, w, h);
      };
    });
    await page.goto(`${mediaSite}#/elmera-fiber`);
    const slide = page.locator("[aria-roledescription=slide]");
    await slide.waitFor();
    const canvas = slide.locator("canvas");
    await canvas.waitFor();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    );
    expect(await page.evaluate(() => window.ghostFiberClears)).toBe(1);

    await page.setViewportSize({ width: 1700, height: 720 });
    await page.waitForFunction(() => document.querySelector("canvas")?.width === 1700);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    );
    expect(await page.evaluate(() => window.ghostFiberClears)).toBe(2);
    await page.close();
  });

  it("initializes the glow buffer at 1280x720 so resizing away and back yields the exact same still frame", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 720 },
    });
    await page.goto(`${mediaSite}#/elmera-fiber`);
    const slide = page.locator("[aria-roledescription=slide]");
    await slide.waitFor();
    const canvas = slide.locator("canvas");
    await canvas.waitFor();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    );
    const initial = await canvas.evaluate((element) =>
      element instanceof HTMLCanvasElement ? element.toDataURL() : ""
    );
    expect(initial).not.toBe("");

    await page.setViewportSize({ width: 1600, height: 720 });
    await page.waitForFunction(() => document.querySelector("canvas")?.width === 1600);

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForFunction(() => document.querySelector("canvas")?.width === 1280);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    );
    const afterRoundTrip = await canvas.evaluate((element) =>
      element instanceof HTMLCanvasElement ? element.toDataURL() : ""
    );
    expect(afterRoundTrip).toBe(initial);
    await page.close();
  });

  it("defers mounting the ghost-fiber canvas until enclosing <Step> elements are revealed", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 720 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${mediaSite}#/elmera-step`);
      const slide = page.locator("[aria-roledescription=slide]");
      await slide.waitFor();
      expect(await slide.locator("canvas").count()).toBe(0);
      expect(await slide.locator(".deck-slide-backdrop").count()).toBe(0);

      await page.keyboard.press("ArrowRight");
      await at(page, "#/elmera-step/1");
      await slide.locator("canvas").waitFor();
      expect(await slide.locator("canvas").count()).toBe(1);

      await page.keyboard.press("ArrowLeft");
      await at(page, "#/elmera-step");
      await expect.poll(() => slide.locator("canvas").count()).toBe(0);
      expect(await slide.locator(".deck-slide-backdrop").count()).toBe(0);

      await page.goto(`${mediaSite}#/elmera-nested-step`);
      await slide.waitFor();
      expect(await slide.locator("canvas").count()).toBe(0);

      await page.keyboard.press("ArrowRight");
      await at(page, "#/elmera-nested-step/1");
      expect(await slide.locator("canvas").count()).toBe(0);

      await page.keyboard.press("ArrowRight");
      await at(page, "#/elmera-nested-step/2");
      await slide.locator("canvas").waitFor();
      expect(await slide.locator("canvas").count()).toBe(1);

      await page.keyboard.press("ArrowLeft");
      await at(page, "#/elmera-nested-step/1");
      await expect.poll(() => slide.locator("canvas").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("keeps a negative-z-index opaque sibling strictly above the ghost-fiber backdrop", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 720 },
    });
    try {
      await page.goto(`${mediaSite}#/elmera-negative-z`);
      const slide = page.locator("[aria-roledescription=slide]");
      await slide.waitFor();
      await slide.locator("canvas").waitFor();

      const swatch = slide.locator("[data-swatch='negative-z']");
      await swatch.waitFor();
      expect(await centerPixelRgba(page, swatch)).toEqual([0, 0, 0, 255]);
    } finally {
      await page.close();
    }
  });

  it("omits .deck-slide-backdrop on plain slides and keeps .deck-layout as :first-child", async () => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    try {
      await page.goto(`${mediaSite}#/elmera`);
      const slide = page.locator("[aria-roledescription=slide]");
      await slide.waitFor();
      expect(await slide.locator(".deck-slide-backdrop").count()).toBe(0);
      expect(await page.locator(".deck-slide > .deck-layout:first-child").count()).toBe(1);

      await page.goto(`${mediaSite}#/elmera-fiber`);
      await slide.waitFor();
      await slide.locator("canvas").waitFor();
      expect(await slide.locator(".deck-slide-backdrop").count()).toBe(1);
      expect(await page.locator(".deck-slide > .deck-layout:first-child").count()).toBe(1);
    } finally {
      await page.close();
    }
  });
});
