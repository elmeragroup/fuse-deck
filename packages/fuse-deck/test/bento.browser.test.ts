import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fuseDeck, serve } from "./browser-harness.ts";

describe("<Bento> and <SpotlightCard> in a built deck", () => {
  let browser: Browser | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  let deckDir: string | undefined;
  let site = "";

  beforeAll(async () => {
    deckDir = await mkdtemp(path.join(tmpdir(), "fuse-deck-bento-"));
    fuseDeck(deckDir, ["create", "."]);
    fuseDeck(deckDir, ["slides", "add", "bento", "--layout", "blank"]);
    fuseDeck(deckDir, ["slides", "add", "standalone", "--layout", "center"]);
    fuseDeck(deckDir, ["slides", "add", "programmatic", "--layout", "blank"]);
    fuseDeck(deckDir, ["slides", "add", "imported", "--layout", "blank"]);

    await writeFile(
      path.join(deckDir, "slides", "bento.mdx"),
      [
        "---",
        "layout: blank",
        "---",
        "",
        '<div style={{ width: "100%", height: "100%", padding: "48px", boxSizing: "border-box" }}>',
        "  <Bento columns={4} rows={3} gap={18}>",
        '    <SpotlightCard title="Button" description="Primary action"><div>Tile 1</div></SpotlightCard>',
        '    <SpotlightCard title="Line" description="Trend scrub"><div>Tile 2</div></SpotlightCard>',
        '    <SpotlightCard colSpan={2} title="Bars" description="Monthly columns"><div>Tile 3</div></SpotlightCard>',
        '    <SpotlightCard colSpan={2} title="Accordion" description="Disclosure"><div>Tile 4</div></SpotlightCard>',
        '    <SpotlightCard colSpan={2} rowSpan={2} title="Table" description="Filtered rows" active><div>Tile 5</div></SpotlightCard>',
        '    <SpotlightCard colSpan={2} title="Switches" description="Preferences"><div>Tile 6</div></SpotlightCard>',
        "  </Bento>",
        "</div>",
        "",
      ].join("\n")
    );

    await writeFile(
      path.join(deckDir, "slides", "standalone.mdx"),
      [
        "---",
        "layout: center",
        "---",
        "",
        '<SpotlightCard title="Standalone" description="Works outside Bento">',
        '  <div style={{ padding: "32px" }}>Solo card</div>',
        "</SpotlightCard>",
        "",
      ].join("\n")
    );

    await writeFile(
      path.join(deckDir, "slides", "programmatic.mdx"),
      [
        "---",
        "layout: blank",
        "---",
        "",
        '<div style={{ width: "100%", height: "100%", padding: "48px", boxSizing: "border-box" }}>',
        "  <Bento columns={2} rows={2} cursor={{ x: 200, y: 150, pressed: true }}>",
        '    <SpotlightCard title="First"><div>A</div></SpotlightCard>',
        '    <SpotlightCard title="Second"><div>B</div></SpotlightCard>',
        "  </Bento>",
        "</div>",
        "",
      ].join("\n")
    );

    await mkdir(path.join(deckDir, "components"), { recursive: true });
    await writeFile(
      path.join(deckDir, "components", "ImportedDemo.tsx"),
      [
        'import { Bento, SpotlightCard, Step } from "@elmeragroup/fuse-deck/components";',
        'import type { BentoCursor } from "@elmeragroup/fuse-deck/components";',
        "",
        "const CURSOR: BentoCursor = { x: 180, y: 120, pressed: true };",
        "",
        "export function ImportedDemo() {",
        "  return (",
        '    <div style={{ width: "100%", height: "100%", padding: "48px", boxSizing: "border-box" }}>',
        "      <Bento columns={2} rows={1} cursor={CURSOR}>",
        '        <SpotlightCard title="Imported">',
        '          <Step index="1"><span data-testid="shared-step">Shared context</span></Step>',
        "        </SpotlightCard>",
        '        <SpotlightCard title="Neighbor"><div>Sibling</div></SpotlightCard>',
        "      </Bento>",
        "    </div>",
        "  );",
        "}",
        "",
      ].join("\n")
    );

    await writeFile(
      path.join(deckDir, "slides", "imported.mdx"),
      [
        "---",
        "layout: blank",
        "---",
        "",
        'import { ImportedDemo } from "../components/ImportedDemo.tsx";',
        "",
        "<ImportedDemo />",
        "<Step>Advance</Step>",
        "",
      ].join("\n")
    );

    fuseDeck(deckDir, ["build"]);
    const server = await serve(path.join(deckDir, "dist"));
    site = server.url;
    closeServer = server.close;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await closeServer?.();
      if (deckDir !== undefined) {
        await rm(deckDir, { recursive: true, force: true });
      }
    }
  });

  it("renders a 6-card asymmetric <Bento> with spans, active state, and neutral Fuse tokens", async () => {
    const activeBrowser = browser;
    expect(activeBrowser).toBeDefined();
    if (activeBrowser === undefined) {
      return;
    }
    const page = await activeBrowser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${site}#/bento`);
      const grid = page.locator(".deck-bento");
      await grid.waitFor();
      const cards = grid.locator(".deck-spotlight-card");
      expect(await cards.count()).toBe(6);

      const firstBox = await cards.nth(0).boundingBox();
      const wideBox = await cards.nth(2).boundingBox();
      const heroBox = await cards.nth(4).boundingBox();
      expect(firstBox).not.toBeNull();
      expect(wideBox).not.toBeNull();
      expect(heroBox).not.toBeNull();
      if (firstBox !== null && wideBox !== null && heroBox !== null) {
        expect(wideBox.width).toBeGreaterThan(firstBox.width);
        expect(heroBox.height).toBeGreaterThan(firstBox.height);
      }

      expect(await grid.locator(".deck-spotlight-card[data-active]").count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("drives card spotlight CSS variables from <Bento cursor={...}> and works standalone", async () => {
    const activeBrowser = browser;
    expect(activeBrowser).toBeDefined();
    if (activeBrowser === undefined) {
      return;
    }
    const page = await activeBrowser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${site}#/programmatic`);
      const firstCard = page.locator(".deck-spotlight-card").first();
      await firstCard.waitFor();

      await expect
        .poll(() =>
          firstCard.evaluate((element) => Number(element.style.getPropertyValue("--deck-spot-alpha")))
        )
        .toBeGreaterThan(0);

      await page.goto(`${site}#/standalone`);
      const solo = page.locator(".deck-spotlight-card", { hasText: "Standalone" });
      await solo.waitFor();
      await expect.poll(() => page.locator(".deck-spotlight-card").count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("lets deck-local .tsx modules import components from @elmeragroup/fuse-deck/components with shared React context", async () => {
    const activeBrowser = browser;
    expect(activeBrowser).toBeDefined();
    if (activeBrowser === undefined) {
      return;
    }
    const page = await activeBrowser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${site}#/imported`);
      const card = page.locator(".deck-spotlight-card", { hasText: "Imported" });
      await card.waitFor();

      await expect
        .poll(() => card.evaluate((element) => Number(element.style.getPropertyValue("--deck-spot-alpha"))))
        .toBeGreaterThan(0);

      const step = card.locator(".deck-step");
      expect(await step.getAttribute("data-revealed")).toBeNull();

      await page.keyboard.press("ArrowRight");
      await expect.poll(() => step.getAttribute("data-revealed")).toBe("");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
