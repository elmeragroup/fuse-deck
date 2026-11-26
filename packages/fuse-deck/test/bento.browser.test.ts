import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fuseDeck, serve } from "./browser-harness.ts";

/** A blank slide whose content sits 300 canvas pixels inside each edge, leaving room around the grid. */
function roomySlide(body: readonly string[]): string {
  return [
    "---",
    "layout: blank",
    "---",
    "",
    '<div style={{ width: "100%", height: "100%", padding: "300px", boxSizing: "border-box" }}>',
    ...body.map((line) => `  ${line}`),
    "</div>",
    "",
  ].join("\n");
}

/** A deck-local module exporting component `name`, whose body is `body`. */
function component(name: string, imports: readonly string[], body: readonly string[]): string {
  return [...imports, "", `export function ${name}() {`, ...body.map((line) => `  ${line}`), "}", ""].join(
    "\n"
  );
}

/** A custom property `<SpotlightCard>` reads, as a number of its unit; an unset one reads as 0. */
function spot(card: Locator, name: string): Promise<number> {
  return card.evaluate((element, property) => {
    const value = element.style.getPropertyValue(property);
    return value === "" ? 0 : Number.parseFloat(value);
  }, name);
}

/** The computed opacity of `locator` once its transitions have finished, or null while one runs. */
function settledOpacity(locator: Locator): Promise<number | null> {
  return locator.evaluate((element) =>
    element.getAnimations().length === 0 ? Number(getComputedStyle(element).opacity) : null
  );
}

/** Where a grid sits on screen, and how many screen pixels one of its CSS pixels takes. */
async function frame(
  grid: Locator
): Promise<{ readonly x: number; readonly y: number; readonly scale: number }> {
  const box = await grid.boundingBox();
  const width = await grid.evaluate((element) => (element instanceof HTMLElement ? element.offsetWidth : 0));
  expect(box).not.toBeNull();
  if (box === null) {
    return { x: 0, y: 0, scale: 1 };
  }
  return { x: box.x, y: box.y, scale: box.width / width };
}

describe("<Bento> and <SpotlightCard> in a built deck", () => {
  let browser: Browser | undefined;
  let closeServers: Array<() => Promise<void>> = [];
  let deckDirs: string[] = [];
  let site = "";
  let brandedSite = "";

  beforeAll(async () => {
    const deckDir = await mkdtemp(path.join(tmpdir(), "fuse-deck-bento-"));
    deckDirs.push(deckDir);
    fuseDeck(deckDir, ["create", "."]);
    for (const [id, layout] of [
      ["bento", "blank"],
      ["standalone", "center"],
      ["programmatic", "blank"],
      ["imported", "blank"],
      ["scripted", "blank"],
      ["pointer", "blank"],
      ["scaled", "blank"],
      ["spans", "blank"],
      ["toggle", "blank"],
      ["mount", "blank"],
    ] as const) {
      fuseDeck(deckDir, ["slides", "add", id, "--layout", layout]);
    }

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

    // A grid of 1320x480 canvas pixels at (300, 300); with the default gap each card is 651 wide.
    await writeFile(
      path.join(deckDir, "slides", "scripted.mdx"),
      roomySlide([
        "<Bento columns={2} cursor={{ x: 200, y: 150 }}>",
        '  <SpotlightCard title="Under cursor"><div>A</div></SpotlightCard>',
        '  <SpotlightCard title="Beside"><div>B</div></SpotlightCard>',
        "</Bento>",
      ])
    );

    // Two 560-wide cards 200 canvas pixels apart, driven by the real pointer only.
    await writeFile(
      path.join(deckDir, "slides", "pointer.mdx"),
      roomySlide([
        "<Bento columns={2} gap={200}>",
        '  <SpotlightCard title="Left"><div>L</div></SpotlightCard>',
        '  <SpotlightCard title="Right"><div>R</div></SpotlightCard>',
        "</Bento>",
      ])
    );

    // The first card is drawn at half its layout size, so its scale differs from the grid's.
    await writeFile(
      path.join(deckDir, "slides", "scaled.mdx"),
      roomySlide([
        "<Bento columns={2} cursor={{ x: 200, y: 150 }}>",
        '  <div style={{ display: "grid", transform: "scale(0.5)", transformOrigin: "0 0" }}>',
        '    <SpotlightCard title="Half"><div>H</div></SpotlightCard>',
        "  </div>",
        '  <SpotlightCard title="Full"><div>F</div></SpotlightCard>',
        "</Bento>",
      ])
    );

    await writeFile(
      path.join(deckDir, "slides", "spans.mdx"),
      roomySlide([
        "<Bento columns={2}>",
        '  <SpotlightCard colSpan={4} title="Wide"><div>W</div></SpotlightCard>',
        '  <SpotlightCard title="One"><div>1</div></SpotlightCard>',
        '  <SpotlightCard title="Two"><div>2</div></SpotlightCard>',
        "</Bento>",
      ])
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
        "      <Bento columns={2} cursor={CURSOR}>",
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

    // The cursor is one module-level object, so re-rendering the grid does not repaint it.
    const reactImports = [
      'import { useState } from "react";',
      'import { Bento, SpotlightCard } from "@elmeragroup/fuse-deck/components";',
      'import type { BentoCursor } from "@elmeragroup/fuse-deck/components";',
      "",
      "const CURSOR: BentoCursor = { x: 200, y: 150 };",
    ];
    const roomy =
      '<div style={{ width: "100%", height: "100%", padding: "300px", boxSizing: "border-box" }}>';
    // Clicked through the DOM, so the real pointer never moves near the grid.
    const button = (label: string, onClick: string) =>
      `      <button type="button" style={{ position: "absolute", top: 0, left: 0 }} onClick={${onClick}}>${label}</button>`;
    await writeFile(
      path.join(deckDir, "components", "ToggleDemo.tsx"),
      component("ToggleDemo", reactImports, [
        "const [enabled, setEnabled] = useState(true);",
        "return (",
        `    ${roomy}`,
        button("Toggle spotlight", "() => setEnabled((value) => !value)"),
        "      <Bento columns={2} cursor={CURSOR}>",
        '        <SpotlightCard title="Toggled" spotlight={enabled}><div>T</div></SpotlightCard>',
        '        <SpotlightCard title="Steady"><div>S</div></SpotlightCard>',
        "      </Bento>",
        "    </div>",
        ");",
      ])
    );
    await writeFile(
      path.join(deckDir, "components", "MountDemo.tsx"),
      component("MountDemo", reactImports, [
        "const [mounted, setMounted] = useState(false);",
        "return (",
        `    ${roomy}`,
        button("Mount card", "() => setMounted(true)"),
        "      <Bento columns={2} cursor={CURSOR}>",
        '        {mounted && <SpotlightCard title="Mounted"><div>M</div></SpotlightCard>}',
        "      </Bento>",
        "    </div>",
        ");",
      ])
    );

    for (const [id, name, file] of [
      ["imported", "ImportedDemo", "ImportedDemo.tsx"],
      ["toggle", "ToggleDemo", "ToggleDemo.tsx"],
      ["mount", "MountDemo", "MountDemo.tsx"],
    ] as const) {
      await writeFile(
        path.join(deckDir, "slides", `${id}.mdx`),
        [
          "---",
          "layout: blank",
          "---",
          "",
          `import { ${name} } from "../components/${file}";`,
          "",
          `<${name} />`,
          ...(id === "imported" ? ["<Step>Advance</Step>"] : []),
          "",
        ].join("\n")
      );
    }

    fuseDeck(deckDir, ["build"]);
    const server = await serve(path.join(deckDir, "dist"));
    site = server.url;
    closeServers.push(server.close);

    // A theme whose card roles differ from the page roles.
    const brandedDir = await mkdtemp(path.join(tmpdir(), "fuse-deck-bento-branded-"));
    deckDirs.push(brandedDir);
    fuseDeck(brandedDir, ["create", ".", "--theme", "branded-elma-private"]);
    fuseDeck(brandedDir, ["slides", "add", "card", "--layout", "center"]);
    await writeFile(
      path.join(brandedDir, "slides", "card.mdx"),
      [
        "---",
        "layout: center",
        "---",
        "",
        '<SpotlightCard title="Branded" description="Card roles">',
        '  <div style={{ padding: "32px" }}>Body</div>',
        "</SpotlightCard>",
        "",
      ].join("\n")
    );
    fuseDeck(brandedDir, ["build"]);
    const branded = await serve(path.join(brandedDir, "dist"));
    brandedSite = branded.url;
    closeServers.push(branded.close);

    browser = await chromium.launch();
  });

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      for (const close of closeServers) {
        await close();
      }
      for (const directory of deckDirs) {
        await rm(directory, { recursive: true, force: true });
      }
      closeServers = [];
      deckDirs = [];
    }
  });

  /** Opens slide `id` of the deck at `origin` at 1280x720, runs `check`, and fails on any page error. */
  async function onSlide(id: string, check: (page: Page) => Promise<void>, origin = site): Promise<void> {
    const activeBrowser = browser;
    expect(activeBrowser).toBeDefined();
    if (activeBrowser === undefined) {
      return;
    }
    const page = await activeBrowser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${origin}#/${id}`);
      await check(page);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }

  it("renders a 6-card asymmetric <Bento> with spans, active state, and neutral Fuse tokens", async () => {
    await onSlide("bento", async (page) => {
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
    });
  });

  it("drives card spotlight CSS variables from <Bento cursor={...}> and works standalone", async () => {
    await onSlide("programmatic", async (page) => {
      const firstCard = page.locator(".deck-spotlight-card").first();
      await firstCard.waitFor();
      await expect.poll(() => spot(firstCard, "--deck-spot-alpha")).toBeGreaterThan(0);

      await page.goto(`${site}#/standalone`);
      const solo = page.locator(".deck-spotlight-card", { hasText: "Standalone" });
      await solo.waitFor();
      await expect.poll(() => page.locator(".deck-spotlight-card").count()).toBe(1);
    });
  });

  it("lets deck-local .tsx modules import components from @elmeragroup/fuse-deck/components with shared React context", async () => {
    await onSlide("imported", async (page) => {
      const card = page.locator(".deck-spotlight-card", { hasText: "Imported" });
      await card.waitFor();
      await expect.poll(() => spot(card, "--deck-spot-alpha")).toBeGreaterThan(0);

      const step = card.locator(".deck-step");
      expect(await step.getAttribute("data-revealed")).toBeNull();

      await page.keyboard.press("ArrowRight");
      await expect.poll(() => step.getAttribute("data-revealed")).toBe("");
    });
  });

  it("relights the scripted cursor's card once the real pointer has entered the grid and left it", async () => {
    await onSlide("scripted", async (page) => {
      const lit = page.locator(".deck-spotlight-card", { hasText: "Under cursor" });
      const beside = page.locator(".deck-spotlight-card", { hasText: "Beside" });
      await expect.poll(() => spot(lit, "--deck-spot-alpha")).toBe(1);

      // The middle of the second card is 343 canvas pixels from the first card's edge.
      const besideBox = await beside.boundingBox();
      expect(besideBox).not.toBeNull();
      if (besideBox === null) {
        return;
      }
      await page.mouse.move(besideBox.x + besideBox.width / 2, besideBox.y + besideBox.height / 2);
      await expect.poll(() => spot(beside, "--deck-spot-alpha")).toBe(1);
      await expect.poll(() => spot(lit, "--deck-spot-alpha")).toBe(0);

      // The viewport's corner is about 300 canvas pixels from the grid.
      await page.mouse.move(2, 2);
      await expect.poll(() => spot(lit, "--deck-spot-alpha")).toBe(1);
      await expect.poll(() => spot(beside, "--deck-spot-alpha")).toBe(0);
    });
  });

  it("clears a card switched to spotlight={false} under a scripted cursor and lights it when switched back", async () => {
    await onSlide("toggle", async (page) => {
      const toggled = page.locator(".deck-spotlight-card", { hasText: "Toggled" });
      const toggle = page.getByRole("button", { name: "Toggle spotlight" });
      await expect.poll(() => spot(toggled, "--deck-spot-alpha")).toBe(1);

      await toggle.dispatchEvent("click");
      await expect.poll(() => toggled.getAttribute("data-spotlight")).toBe("off");
      await expect.poll(() => spot(toggled, "--deck-spot-alpha")).toBe(0);

      await toggle.dispatchEvent("click");
      await expect.poll(() => toggled.getAttribute("data-spotlight")).toBe("on");
      await expect.poll(() => spot(toggled, "--deck-spot-alpha")).toBe(1);
    });
  });

  it("lights a card that mounts under a stationary scripted cursor", async () => {
    await onSlide("mount", async (page) => {
      await page.locator(".deck-bento").waitFor();
      await page.getByRole("button", { name: "Mount card" }).dispatchEvent("click");
      const mounted = page.locator(".deck-spotlight-card", { hasText: "Mounted" });
      await mounted.waitFor();
      await expect.poll(() => spot(mounted, "--deck-spot-alpha")).toBe(1);
    });
  });

  it("clears the card the pointer no longer covers after the viewport shrinks", async () => {
    await onSlide("pointer", async (page) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      const grid = page.locator(".deck-bento");
      const left = page.locator(".deck-spotlight-card", { hasText: "Left" });
      await grid.waitFor();
      await expect.poll(async () => (await frame(grid)).scale).toBeCloseTo(1, 3);

      // 220 canvas pixels right of and 10 below the grid's corner: inside the left card.
      const before = await frame(grid);
      const mouse = { x: before.x + 220 * before.scale, y: before.y + 10 * before.scale };
      await page.mouse.move(mouse.x, mouse.y);
      await expect.poll(() => spot(left, "--deck-spot-alpha")).toBe(1);

      await page.setViewportSize({ width: 960, height: 540 });
      await expect.poll(async () => (await frame(grid)).scale).toBeCloseTo(0.5, 3);
      // The unmoved pointer now lies 740 canvas pixels right of the grid's corner, 180 past the left card.
      await expect.poll(() => spot(left, "--deck-spot-alpha")).toBe(0);
    });
  });

  it("glows a card's border from a pointer 100 canvas pixels outside the grid at canvas scale 2", async () => {
    await onSlide("pointer", async (page) => {
      await page.setViewportSize({ width: 3840, height: 2160 });
      const grid = page.locator(".deck-bento");
      const left = page.locator(".deck-spotlight-card", { hasText: "Left" });
      await grid.waitFor();
      await expect.poll(async () => (await frame(grid)).scale).toBeCloseTo(2, 3);

      // Level with the left card's middle, 100 canvas pixels left of its edge.
      const { x, y, scale } = await frame(grid);
      await page.mouse.move(x - 100 * scale, y + 240 * scale);
      await expect.poll(() => spot(left, "--deck-spot-edge")).toBeGreaterThan(0);
    });
  });

  it("places the light at the same card point for the scripted cursor and the real pointer", async () => {
    await onSlide("scaled", async (page) => {
      const grid = page.locator(".deck-bento");
      const half = page.locator(".deck-spotlight-card", { hasText: "Half" });
      await expect.poll(() => spot(half, "--deck-spot-alpha")).toBe(1);
      const scripted = { x: await spot(half, "--deck-spot-x"), y: await spot(half, "--deck-spot-y") };

      // First somewhere else in the card, so the reading below comes from the real pointer.
      const { x, y, scale } = await frame(grid);
      await page.mouse.move(x + 60 * scale, y + 40 * scale);
      await expect.poll(() => spot(half, "--deck-spot-x")).not.toBeCloseTo(scripted.x, 0);

      // The scripted cursor's own point: 200, 150 in the grid's CSS pixels.
      await page.mouse.move(x + 200 * scale, y + 150 * scale);
      await expect.poll(() => spot(half, "--deck-spot-x")).toBeCloseTo(scripted.x, 0);
      expect(Math.abs((await spot(half, "--deck-spot-x")) - scripted.x)).toBeLessThanOrEqual(0.2);
      expect(Math.abs((await spot(half, "--deck-spot-y")) - scripted.y)).toBeLessThanOrEqual(0.2);
    });
  });

  it("brightens a card's light and border while the pointer presses it", async () => {
    await onSlide("pointer", async (page) => {
      const left = page.locator(".deck-spotlight-card", { hasText: "Left" });
      const light = left.locator(".deck-spotlight-light");
      const border = left.locator(".deck-spotlight-border");
      const box = await left.boundingBox();
      expect(box).not.toBeNull();
      if (box === null) {
        return;
      }
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await expect.poll(() => spot(left, "--deck-spot-alpha")).toBe(1);
      await expect.poll(() => settledOpacity(light)).not.toBeNull();
      await expect.poll(() => settledOpacity(border)).not.toBeNull();
      const restLight = (await settledOpacity(light)) ?? 0;
      const restBorder = (await settledOpacity(border)) ?? 0;

      await page.mouse.down();
      try {
        await expect.poll(() => spot(left, "--deck-spot-press")).toBe(1);
        await expect.poll(async () => (await settledOpacity(light)) ?? 0).toBeGreaterThan(restLight);
        await expect.poll(async () => (await settledOpacity(border)) ?? 0).toBeGreaterThan(restBorder);
      } finally {
        await page.mouse.up();
      }
    });
  });

  it("keeps a tile's span within the grid's columns", async () => {
    await onSlide("spans", async (page) => {
      const grid = page.locator(".deck-bento");
      await grid.waitFor();
      const tracks = await grid.evaluate((element) =>
        getComputedStyle(element)
          .gridTemplateColumns.split(" ")
          .filter((track) => track !== "")
      );
      expect(tracks).toHaveLength(2);

      const one = await page.locator(".deck-spotlight-card", { hasText: "One" }).boundingBox();
      const two = await page.locator(".deck-spotlight-card", { hasText: "Two" }).boundingBox();
      expect(one).not.toBeNull();
      expect(two).not.toBeNull();
      if (one !== null && two !== null) {
        expect(two.y).toBeCloseTo(one.y, 1);
        expect(two.width).toBeCloseTo(one.width, 1);
      }
    });
  });

  it("colours a card's text with the theme's card-foreground role", async () => {
    await onSlide(
      "card",
      async (page) => {
        const card = page.locator(".deck-spotlight-card", { hasText: "Branded" });
        await card.waitFor();
        // Probes resolve each role where the card sits, without the card's own rules.
        const roles = await card.evaluate((element) => {
          const probe = (color: string) => {
            const span = document.createElement("span");
            span.style.color = color;
            element.parentElement?.append(span);
            const resolved = getComputedStyle(span).color;
            span.remove();
            return resolved;
          };
          return { card: probe("var(--card-foreground)"), page: probe("var(--foreground)") };
        });
        expect(roles.card).not.toBe(roles.page);

        const title = card.locator(".deck-spotlight-title");
        expect(await title.evaluate((element) => getComputedStyle(element).color)).toBe(roles.card);
        expect(await card.evaluate((element) => getComputedStyle(element).color)).toBe(roles.card);
        expect(await card.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
      },
      brandedSite
    );
  });
});
