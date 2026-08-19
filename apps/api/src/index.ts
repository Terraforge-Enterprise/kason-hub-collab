import { resolve } from "node:path";
import { serve } from "@hono/node-server";

// Load .env in dev before any module reads process.env.
// dotenv is a root devDependency — not available in production Docker image.
if (process.env.NODE_ENV !== "production") {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ path: resolve(process.cwd(), ".env") });
    dotenv.config({ path: resolve(process.cwd(), "../../.env") });
  } catch {
    // dotenv not installed — running without .env files
  }
}

// Dynamic imports: app.ts imports runtimeConfig which reads process.env at
// module scope (for CORS origins). Both must load AFTER dotenv runs above.
const { app } = await import("./app");
const { runtimeConfig } = await import("./lib/runtime-config");
const { verifyBucketLimitAtStartup } = await import("./lib/storage");

// Non-blocking storage cap verification. Logs a warning if the prod
// Supabase bucket's file_size_limit is below the application's video cap
// (500 MB) — uploads would otherwise fail at the bucket layer with a
// cryptic 413. See docs/runbooks/supabase-storage.md. We intentionally
// fire-and-forget: a misconfigured cap is bad UX but should not block
// boot or take production down.
if (process.env.NODE_ENV !== "test") {
  verifyBucketLimitAtStartup().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[storage] bucket cap verification skipped:", err);
  });
}

const server = serve({
  fetch: app.fetch,
  port: runtimeConfig.port,
});

const shutdown = () => {
  server.close(() => process.exit(0));
  // Force exit after 10s if connections don't drain
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// build-trigger: 2026-07-05 master→main promotion (charges/payments v2 + all flags ON) — api artifact rebuild
