import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  outDir: "dist",
  clean: true,
  // Bundle workspace packages (@kason/db, @kason/shared) into the output
  // so the runtime image only needs node_modules for third-party deps.
  noExternal: ["@kason/db", "@kason/shared"],
  // Keep third-party deps external — they come from node_modules
  external: [
    "@prisma/client",
    "@prisma/adapter-pg",
    "hono",
    "@hono/node-server",
    "hono-rate-limiter",
    "jose",
    "zod",
  ],
  // Top-level await is used in index.ts
  banner: { js: "" },
});
