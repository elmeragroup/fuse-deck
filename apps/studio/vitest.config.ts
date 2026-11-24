import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // The built backend as a spawned process, on real temporary decks.
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["**/*.browser.test.ts"],
          environment: "node",
          testTimeout: 60_000,
        },
      },
      {
        // The built renderer against the built backend, driven in Playwright's Chromium.
        test: {
          name: "browser",
          include: ["test/**/*.browser.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
