import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fuseDeck, serve } from "./browser-harness.ts";

describe("<Metrics> and <Metric> in a built deck", () => {
  let browser: Browser | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  let deckDir = "";
  let site = "";

  function openPage() {
    if (browser === undefined) {
      throw new Error("Chromium did not launch.");
    }
    return browser.newPage({ viewport: { width: 1280, height: 720 } });
  }

  beforeAll(async () => {
    deckDir = await mkdtemp(path.join(tmpdir(), "fuse-deck-metrics-"));
    fuseDeck(deckDir, ["create", "."]);
    for (const [id, layout] of [
      ["band", "content"],
      ["stack", "content"],
      ["inherit", "content"],
      ["cards", "content"],
      ["stepped", "content"],
      ["imported", "content"],
    ] as const) {
      fuseDeck(deckDir, ["slides", "add", id, "--layout", layout]);
    }

    await writeFile(
      path.join(deckDir, "slides/band.mdx"),
      [
        "# Metric band",
        "",
        "<Metrics columns={4} dividers>",
        '  <Metric value="94" label="Components" detail="Forms, tables, dialogs and charts" />',
        '  <Metric value="24" label="Themes" detail="Seven brands across segments" />',
        '  <Metric value="2" label="Densities" detail="Compact internal, spacious customer" />',
        '  <Metric value="4" label="Languages" detail="Norwegian, Swedish, Finnish and English" />',
        "</Metrics>",
        "",
      ].join("\n")
    );

    await writeFile(
      path.join(deckDir, "slides/stack.mdx"),
      [
        "# Metric stack",
        "",
        '<Metrics direction="column" dividers size="compact">',
        '  <Metric value="1 068" detail="Completed PRs this year" />',
        '  <Metric value="6.7×" detail="Compared to last year" />',
        '  <Metric value="473" detail="Peak month" />',
        "</Metrics>",
        "",
      ].join("\n")
    );

    await writeFile(
      path.join(deckDir, "slides/inherit.mdx"),
      [
        "# Inherited scale and alignment",
        "",
        '<Metrics columns={2} size="hero" align="center">',
        '  <Metric value="12" label="Weeks" />',
        '  <Metric value="711" label="Changes" size="compact" align="start" />',
        "</Metrics>",
        "",
      ].join("\n")
    );

    await writeFile(
      path.join(deckDir, "slides/cards.mdx"),
      [
        "# Metrics in cards",
        "",
        "<Bento columns={2} rows={2}>",
        "  <SpotlightCard>",
        '    <Metric value="94" label="Components" detail="Ready to compose" />',
        "  </SpotlightCard>",
        "  <SpotlightCard>",
        '    <Metric value="4" label="Languages" detail="Built in" />',
        "  </SpotlightCard>",
        "</Bento>",
        "",
      ].join("\n")
    );

    await writeFile(
      path.join(deckDir, "slides/stepped.mdx"),
      [
        "# Stepped metrics",
        "",
        "<Metrics columns={2} dividers>",
        '  <Metric value="1" label="Package" />',
        '  <Step><Metric value="24" label="Themes" /></Step>',
        "</Metrics>",
        "",
      ].join("\n")
    );

    await mkdir(path.join(deckDir, "components"), { recursive: true });
    await writeFile(
      path.join(deckDir, "components/LocalMetrics.tsx"),
      [
        'import { Metric, Metrics } from "@elmeragroup/fuse-deck/components";',
        "",
        "export function LocalMetrics() {",
        "  return (",
        '    <Metrics columns={2} size="compact">',
        '      <Metric value="100%" label="Shared context" />',
        '      <Metric value="0" label="Extra CSS" />',
        "    </Metrics>",
        "  );",
        "}",
        "",
      ].join("\n")
    );
    await writeFile(
      path.join(deckDir, "slides/imported.mdx"),
      [
        'import { LocalMetrics } from "../components/LocalMetrics.tsx";',
        "",
        "# Imported",
        "",
        "<LocalMetrics />",
        "",
      ].join("\n")
    );

    fuseDeck(deckDir, ["check", "--json"]);
    fuseDeck(deckDir, ["build", "--json"]);

    const server = await serve(path.join(deckDir, "dist"));
    closeServer = server.close;
    site = server.url;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await closeServer?.();
    if (deckDir !== "") {
      await rm(deckDir, { recursive: true, force: true });
    }
  });

  it("lays out 4 equal columns with full-height 1px structural dividers, tabular numerals and no overflow", async () => {
    const page = await openPage();
    const errors: Array<string> = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${site}#/band`);
    const group = page.locator(".deck-metrics");
    await group.waitFor();
    const items = group.locator(".deck-metric");
    expect(await items.count()).toBe(4);

    const metrics = await group.evaluate((element) => {
      const children = [...element.querySelectorAll<HTMLElement>(".deck-metric")];
      const [first, second] = children;
      const value = first?.querySelector<HTMLElement>(".deck-metric-value") ?? null;
      const groupStyle = getComputedStyle(element);
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        borderTop: Number.parseFloat(groupStyle.borderTopWidth),
        borderBottom: Number.parseFloat(groupStyle.borderBottomWidth),
        firstBorderLeft:
          first === undefined ? -1 : Number.parseFloat(getComputedStyle(first).borderLeftWidth),
        secondBorderLeft:
          second === undefined ? -1 : Number.parseFloat(getComputedStyle(second).borderLeftWidth),
        tabularNums: value === null ? "" : getComputedStyle(value).fontVariantNumeric,
        widths: children.map((child) => Math.round(child.getBoundingClientRect().width)),
        heights: children.map((child) => Math.round(child.getBoundingClientRect().height)),
        tops: children.map((child) => Math.round(child.getBoundingClientRect().top)),
      };
    });

    expect(errors).toEqual([]);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    expect(metrics.borderTop).toBe(1);
    expect(metrics.borderBottom).toBe(1);
    expect(metrics.firstBorderLeft).toBe(0);
    expect(metrics.secondBorderLeft).toBe(1);
    expect(metrics.tabularNums).toContain("tabular-nums");
    expect(Math.max(...metrics.tops) - Math.min(...metrics.tops)).toBeLessThanOrEqual(1);
    expect(Math.max(...metrics.widths) - Math.min(...metrics.widths)).toBeLessThanOrEqual(2);
    expect(Math.max(...metrics.heights) - Math.min(...metrics.heights)).toBeLessThanOrEqual(1);
    await page.close();
  });

  it("stacks metrics vertically with horizontal dividers in column direction", async () => {
    const page = await openPage();
    await page.goto(`${site}#/stack`);
    await page.locator(".deck-metrics").waitFor();

    const layout = await page.locator(".deck-metrics").evaluate((element) => {
      const items = [...element.querySelectorAll<HTMLElement>(".deck-metric")];
      const [first, second] = items;
      return {
        tops: items.map((item) => item.getBoundingClientRect().top),
        firstBorderTop: first === undefined ? -1 : Number.parseFloat(getComputedStyle(first).borderTopWidth),
        secondBorderTop:
          second === undefined ? -1 : Number.parseFloat(getComputedStyle(second).borderTopWidth),
        sizes: items.map((item) => item.dataset.size),
        labels: items.map((item) => item.querySelector(".deck-metric-label") !== null),
      };
    });

    expect(layout.tops.length).toBe(3);
    expect(layout.tops[1]).toBeGreaterThan(layout.tops[0] ?? Number.POSITIVE_INFINITY);
    expect(layout.tops[2]).toBeGreaterThan(layout.tops[1] ?? Number.POSITIVE_INFINITY);
    expect(layout.firstBorderTop).toBe(0);
    expect(layout.secondBorderTop).toBe(1);
    expect(layout.sizes).toEqual(["compact", "compact", "compact"]);
    expect(layout.labels).toEqual([false, false, false]);
    await page.close();
  });

  it("inherits size and align from <Metrics> and allows per-item overrides", async () => {
    const page = await openPage();
    await page.goto(`${site}#/inherit`);
    await page.locator(".deck-metrics").waitFor();

    const states = await page.locator(".deck-metric").evaluateAll((elements) =>
      elements.map((element) => {
        const html = element instanceof HTMLElement ? element : null;
        const value = element.querySelector<HTMLElement>(".deck-metric-value");
        return {
          size: html?.dataset.size ?? null,
          align: html?.dataset.align ?? null,
          fontSize: value === null ? 0 : Number.parseFloat(getComputedStyle(value).fontSize),
        };
      })
    );

    expect(states).toEqual([
      { size: "hero", align: "center", fontSize: 124 },
      { size: "compact", align: "start", fontSize: 48 },
    ]);
    await page.close();
  });

  it("gives <Metric> card padding inside <SpotlightCard> and aligns labels across a row", async () => {
    const page = await openPage();
    await page.goto(`${site}#/cards`);
    await page.locator(".deck-bento").waitFor();

    const result = await page.locator(".deck-spotlight-card .deck-metric").evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        const label = element.querySelector<HTMLElement>(".deck-metric-label");
        return {
          paddingTop: Number.parseFloat(style.paddingTop),
          paddingLeft: Number.parseFloat(style.paddingLeft),
          labelTop: label === null ? -1 : Math.round(label.getBoundingClientRect().top),
        };
      })
    );

    expect(result.length).toBe(2);
    expect(result[0]?.paddingTop).toBe(34);
    expect(result[0]?.paddingLeft).toBe(36);
    expect(Math.abs((result[0]?.labelTop ?? 0) - (result[1]?.labelTop ?? 100))).toBeLessThanOrEqual(1);
    await page.close();
  });

  it("keeps divider columns intact when a <Metric> is wrapped in <Step> and reveals it on key press", async () => {
    const page = await openPage();
    await page.goto(`${site}#/stepped`);

    const step = page.locator(".deck-step");
    await step.waitFor();
    expect(await step.getAttribute("data-revealed")).toBeNull();
    const borderBefore = await step.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).borderLeftWidth)
    );
    expect(borderBefore).toBe(1);

    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () => document.querySelector(".deck-step")?.hasAttribute("data-revealed") === true
    );
    expect(await step.getAttribute("data-revealed")).not.toBeNull();
    await page.close();
  });

  it("shares <Metrics> context when imported from @elmeragroup/fuse-deck/components", async () => {
    const page = await openPage();
    await page.goto(`${site}#/imported`);
    await page.locator(".deck-metrics").waitFor();

    const sizes = await page
      .locator(".deck-metric")
      .evaluateAll((elements) =>
        elements.map((element) => (element instanceof HTMLElement ? (element.dataset.size ?? null) : null))
      );
    expect(sizes).toEqual(["compact", "compact"]);
    await page.close();
  });
});
