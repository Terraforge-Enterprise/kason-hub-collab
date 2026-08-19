import { config as loadEnv } from "dotenv";
import path from "node:path";
import { defineConfig, env } from "prisma/config";

// Load .env from the repo root — this package is in packages/db/, so the
// repo root is two levels up. This allows `prisma migrate` commands to run
// from either the repo root OR inside packages/db/.
loadEnv({ path: path.resolve(__dirname, "..", "..", ".env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
