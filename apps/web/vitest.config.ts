import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    pool: "forks",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Mirror apps/api: resolve @kason/shared to its TS source so web tests do
      // not depend on a prebuilt packages/shared/dist. Without this, resolution
      // falls through to node_modules/@kason/shared -> dist, which fails in a
      // fresh checkout that hasn't run `npm run build -w @kason/shared`.
      "@kason/shared": path.resolve(__dirname, "../../packages/shared/src"),
    },
  },
});
