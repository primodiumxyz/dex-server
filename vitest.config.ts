import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    globalSetup: ["./test/setup.ts"],
    testTimeout: 10000,
    setupFiles: ["./test/setup.ts"],
    reporters: ["default", "hanging-process"],
    alias: {
      "@/*": "./src/*",
      "@bin/*": "./bin/*",
    },
  },
});
