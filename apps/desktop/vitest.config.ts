import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // The backend manager against real child processes. Nothing here needs Electron.
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
