import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Upstream's tests: the protocol, the client and agent over in-memory and spawned stdio,
        // and the mock peer in test/fixtures.
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
        },
      },
    ],
  },
});
