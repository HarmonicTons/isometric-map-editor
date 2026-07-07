import { defineConfig } from "vitest/config";

// Standalone config: don't reuse vite.config.ts, whose assetpack plugin
// (asset pipeline + watcher) has no business running during unit tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
