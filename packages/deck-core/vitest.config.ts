import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // The deck model and the bundler's pure parts, on real temporary directories.
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
        },
      },
    ],
  },
});
