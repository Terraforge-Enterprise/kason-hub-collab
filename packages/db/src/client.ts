import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import fs from "node:fs";
import path from "node:path";

const isDev = process.env.NODE_ENV !== "production";

declare global {
  // eslint-disable-next-line no-var
  var __kasonPrisma: PrismaClient | undefined;
}

// pg-connection-string >= 2.12 treats `sslmode=require` as strict `verify-full`,
// which rejects Supabase's pooler cert chain. We override by stripping any
// `sslmode` from the URL and setting `ssl` explicitly:
// - If SUPABASE_CA_CERT_PATH (or ./certs/supabase-ca.crt) exists, pin and verify.
// - Otherwise, encrypt-only (libpq `require` semantics).
function resolveSsl() {
  const caPath =
    process.env.SUPABASE_CA_CERT_PATH ?? path.join(process.cwd(), "certs/supabase-ca.crt");
  try {
    const ca = fs.readFileSync(caPath);
    return { ca, rejectUnauthorized: true as const };
  } catch {
    return { rejectUnauthorized: false as const };
  }
}

function stripSslmode(url: string): string {
  return url.replace(/([?&])sslmode=[^&]*&?/g, "$1").replace(/[?&]$/, "");
}

function wantsSsl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    const sslmode = parsed.searchParams.get("sslmode");
    if (sslmode === "disable") return false;
    return true;
  } catch {
    return true;
  }
}

function buildClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const poolMax = isDev ? 5 : 20;
  const adapter = new PrismaPg(
    {
      connectionString: stripSslmode(url),
      ssl: wantsSsl(url) ? resolveSsl() : false,
      idleTimeoutMillis: 30_000,
      max: poolMax,
      connectionTimeoutMillis: 10_000,
    },
    { disposeExternalPool: false },
  );

  return new PrismaClient({
    adapter,
    // `query` echoes every SQL statement to stdout. A single admin page load
    // emits ~15 of them, which buries the request log and any real warning
    // under a wall of SELECTs. It stays available for debugging a specific
    // query — opt in with PRISMA_LOG_QUERIES=1 — but is off by default so the
    // dev log is readable. `warn`/`error` are signal and stay on in dev.
    log: isDev ? devLogLevels() : ["error"],
  });
}

function devLogLevels(): ("query" | "warn" | "error")[] {
  return process.env.PRISMA_LOG_QUERIES === "1"
    ? ["query", "warn", "error"]
    : ["warn", "error"];
}

export function getDb() {
  if (!global.__kasonPrisma) {
    global.__kasonPrisma = buildClient();
  }
  return global.__kasonPrisma;
}

export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
