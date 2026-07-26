import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test boots its own in-memory PGlite instance, which is CPU-heavy.
    // Running whole files in parallel starves them and causes flaky timeouts.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
