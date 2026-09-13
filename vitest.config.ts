import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@browser-bridge/protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
      "@browser-bridge/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@browser-bridge/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
      "@browser-bridge/mcp": fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
    },
  },
  // Workspace sources must never be served from the pre-bundle cache.
  optimizeDeps: {
    exclude: ["@browser-bridge/protocol", "@browser-bridge/core"],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
