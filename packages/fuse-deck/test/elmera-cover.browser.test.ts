import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { at, fuseDeck, pixelRgba, serve } from "./browser-harness.ts";

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- only an interface merges into the DOM's Window
  interface Window {
    /** Main-canvas clearRect calls recorded by init scripts in reduced-motion render tests. */
    ghostFiberClears?: number;
  }
}

const MULTILINE_TAGLINE =
  "Preferred by more customers across every Nordic energy market, every single day of the year, delivering reliable power and transparent service.";
const UNBROKEN_TAGLINE = "elmeragroupnordic202".repeat(10);
const NARROW_SPLIT_TAGLINE =
  "Preferred by more customers across every Nordic energy market, every single day of the year, delivering reliable power, transparent service, and lasting clarity.";

describe("<ElmeraCover> in a built deck", () => {
  let workspace = "";
  let site = "";
  let browser: Browser;
  let close: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "fuse-deck-elmera-cover-"));
    fuseDeck(workspace, ["create", "elmera-talk"]);
    const deck = path.join(workspace, "elmera-talk");
    const slideSources = {
      elmera: "---\nlayout: center\n---\n\n<ElmeraCover />\n",
      "elmera-fiber": '---\nlayout: center\n---\n\n<ElmeraCover background="ghost-fiber" />\n',
      "elmera-sibling": [
        "---",
        "layout: center",
        "---",
        "",
        "<Split>",
        '  <ElmeraCover background="ghost-fiber" />',
        '  <div data-swatch="black" style={{ width: "100%", height: "100%", backgroundColor: "rgb(0, 0, 0)" }} />',
        "</Split>",
        "",
      ].join("\n"),
      "elmera-wrapped-sibling": [
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
      ].join("\n"),
      "elmera-multiline": [
        "---",
        "layout: center",
        "---",
        "",
        `<ElmeraCover tagline=${JSON.stringify(MULTILINE_TAGLINE)} />`,
        "",
      ].join("\n"),
      "elmera-unbroken": [
        "---",
        "layout: center",
        "---",
        "",
        `<ElmeraCover tagline=${JSON.stringify(UNBROKEN_TAGLINE)} />`,
        "",
      ].join("\n"),
      "elmera-narrow-split": [
        "---",
        "layout: center",
        "---",
        "",
        '<Split ratio="1:2">',
        `  <ElmeraCover tagline=${JSON.stringify(NARROW_SPLIT_TAGLINE)} />`,
        "  <div />",
        "</Split>",
        "",
      ].join("\n"),
      "elmera-no-tagline": "---\nlayout: center\n---\n\n<ElmeraCover tagline={null} />\n",
      "elmera-step": [
        "---",
        "layout: center",
        "---",
        "",
        "<Step>",
        '  <ElmeraCover background="ghost-fiber" />',
        "</Step>",
        "",
      ].join("\n"),
      "elmera-nested-step": [
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
      ].join("\n"),
      "elmera-negative-z": [
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
      ].join("\n"),
      "elmera-step-inset-sibling": [
        "---",
        "layout: center",
        "---",
        "",
        '<div data-swatch="inset-sibling" style={{ position: "absolute", inset: 0, zIndex: -2, backgroundColor: "rgb(0, 0, 0)" }} />',
        "",
        "<Step>",
        '  <ElmeraCover background="ghost-fiber" />',
        "</Step>",
        "",
      ].join("\n"),
      "elmera-double-fiber": [
        "---",
        "layout: center",
        "---",
        "",
        "<Split>",
        '  <ElmeraCover background="ghost-fiber" />',
        '  <ElmeraCover background="ghost-fiber" />',
        "</Split>",
        "",
      ].join("\n"),
    };

    for (const [id, text] of Object.entries(slideSources)) {
      fuseDeck(deck, ["slides", "add", id, "--layout", "center"]);
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

  it("renders <ElmeraCover> with Fuse's Elmera Group logo and Inter tagline", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${site}#/elmera`);
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
    } finally {
      await page.close();
    }
  });

  it("renders the opt-in monochrome ghost-fiber background edge-to-edge on <ElmeraCover>", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1600, height: 720 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${site}#/elmera-fiber`);
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
    } finally {
      await page.close();
    }
  });

  it("paints ghost-fiber behind sibling slide content so a black swatch keeps its exact color", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 720 },
    });
    try {
      await page.goto(`${site}#/elmera-sibling`);
      const slide = page.locator("[aria-roledescription=slide]");
      await slide.waitFor();
      await slide.locator("canvas").waitFor();

      const swatch = slide.locator("[data-swatch='black']");
      await swatch.waitFor();
      expect(await pixelRgba(page, swatch)).toEqual([0, 0, 0, 255]);
    } finally {
      await page.close();
    }
  });

  it("keeps ghost-fiber viewport-sized and behind siblings when <ElmeraCover> is inside a positioned z-index wrapper", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1600, height: 720 },
    });
    try {
      await page.goto(`${site}#/elmera-wrapped-sibling`);
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

      expect(await pixelRgba(page, swatch)).toEqual([0, 0, 0, 255]);
    } finally {
      await page.close();
    }
  });

  it("keeps the <ElmeraCover> wordmark centered with multi-line and long unbroken taglines", async () => {
    const fixtures = [
      { hash: "#/elmera-multiline", text: MULTILINE_TAGLINE },
      { hash: "#/elmera-unbroken", text: UNBROKEN_TAGLINE },
    ] as const;

    for (const fixture of fixtures) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      try {
        await page.goto(`${site}${fixture.hash}`);
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
      await page.goto(`${site}#/elmera-narrow-split`);
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
    try {
      await page.goto(`${site}#/elmera-no-tagline`);
      const slide = page.locator("[aria-roledescription=slide]");
      await slide.waitFor();
      await slide.getByRole("img", { name: "Elmera Group" }).waitFor();
      expect(await slide.locator(".deck-elmera-cover-tagline").count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("draws ghost-fiber once on mount and once on resize under reduced motion", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1600, height: 720 },
    });
    try {
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
      await page.goto(`${site}#/elmera-fiber`);
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
    } finally {
      await page.close();
    }
  });

  it("initializes the glow buffer at 1280x720 so resizing away and back yields the exact same still frame", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 720 },
    });
    try {
      await page.goto(`${site}#/elmera-fiber`);
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
    } finally {
      await page.close();
    }
  });

  it("defers mounting the ghost-fiber canvas until enclosing <Step> elements are revealed", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 720 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${site}#/elmera-step`);
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

      await page.goto(`${site}#/elmera-nested-step`);
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
      await page.goto(`${site}#/elmera-negative-z`);
      const slide = page.locator("[aria-roledescription=slide]");
      await slide.waitFor();
      await slide.locator("canvas").waitFor();

      const swatch = slide.locator("[data-swatch='negative-z']");
      await swatch.waitFor();
      expect(await pixelRgba(page, swatch)).toEqual([0, 0, 0, 255]);
    } finally {
      await page.close();
    }
  });

  it("preserves an inset-0 absolute sibling's slide bounds and negative-z stacking when a <Step> ghost-fiber reveals", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 720 },
    });
    try {
      await page.goto(`${site}#/elmera-step-inset-sibling`);
      const slide = page.locator("[aria-roledescription=slide]");
      await slide.waitFor();
      const swatch = slide.locator("[data-swatch='inset-sibling']");
      await swatch.waitFor();

      const slideBoxBefore = await slide.boundingBox();
      const swatchBoxBefore = await swatch.boundingBox();
      expect(slideBoxBefore).not.toBeNull();
      expect(swatchBoxBefore).not.toBeNull();
      if (slideBoxBefore !== null && swatchBoxBefore !== null) {
        expect({
          x: Math.round(swatchBoxBefore.x),
          y: Math.round(swatchBoxBefore.y),
          width: Math.round(swatchBoxBefore.width),
          height: Math.round(swatchBoxBefore.height),
        }).toEqual({
          x: Math.round(slideBoxBefore.x),
          y: Math.round(slideBoxBefore.y),
          width: Math.round(slideBoxBefore.width),
          height: Math.round(slideBoxBefore.height),
        });
      }

      await page.keyboard.press("ArrowRight");
      await at(page, "#/elmera-step-inset-sibling/1");
      await slide.locator("canvas").waitFor();

      const slideBoxAfter = await slide.boundingBox();
      const swatchBoxAfter = await swatch.boundingBox();
      expect(slideBoxAfter).not.toBeNull();
      expect(swatchBoxAfter).not.toBeNull();
      if (slideBoxAfter !== null && swatchBoxBefore !== null && swatchBoxAfter !== null) {
        expect({
          matchesSlide:
            Math.round(swatchBoxAfter.x) === Math.round(slideBoxAfter.x) &&
            Math.round(swatchBoxAfter.y) === Math.round(slideBoxAfter.y) &&
            Math.round(swatchBoxAfter.width) === Math.round(slideBoxAfter.width) &&
            Math.round(swatchBoxAfter.height) === Math.round(slideBoxAfter.height),
          unchangedFromBefore:
            Math.round(swatchBoxAfter.x) === Math.round(swatchBoxBefore.x) &&
            Math.round(swatchBoxAfter.y) === Math.round(swatchBoxBefore.y) &&
            Math.round(swatchBoxAfter.width) === Math.round(swatchBoxBefore.width) &&
            Math.round(swatchBoxAfter.height) === Math.round(swatchBoxBefore.height),
        }).toEqual({
          matchesSlide: true,
          unchangedFromBefore: true,
        });
      }

      // Sample inside the radial veil band yet clear of the centered wordmark and tagline.
      expect(await pixelRgba(page, swatch, { x: 0.15, y: 0.5 })).toEqual([0, 0, 0, 255]);
    } finally {
      await page.close();
    }
  });

  it("mounts a single shared canvas and backdrop when two ghost-fiber <ElmeraCover> components share a slide", async () => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 720 },
    });
    try {
      await page.goto(`${site}#/elmera-double-fiber`);
      const slide = page.locator("[aria-roledescription=slide]");
      await slide.waitFor();
      await slide.locator("canvas").waitFor();

      expect(await slide.getByRole("img", { name: "Elmera Group" }).count()).toBe(2);
      expect(await slide.locator("canvas").count()).toBe(1);
      expect(await slide.locator(".deck-slide-backdrop").count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("omits .deck-slide-backdrop on plain slides and keeps .deck-layout as :first-child", async () => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    try {
      await page.goto(`${site}#/elmera`);
      const slide = page.locator("[aria-roledescription=slide]");
      await slide.waitFor();
      expect(await slide.locator(".deck-slide-backdrop").count()).toBe(0);
      expect(await page.locator(".deck-slide > .deck-layout:first-child").count()).toBe(1);

      await page.goto(`${site}#/elmera-fiber`);
      await slide.waitFor();
      await slide.locator("canvas").waitFor();
      expect(await slide.locator(".deck-slide-backdrop").count()).toBe(1);
      expect(await page.locator(".deck-slide > .deck-layout:first-child").count()).toBe(1);
    } finally {
      await page.close();
    }
  });
});
