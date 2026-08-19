// Read-only Prisma client dedicated to the public-card sub-app.
//
// This module is the ONLY consumer of `DATABASE_URL_READONLY` (per spec §9.1
// #3). The corresponding Postgres role (`kason_public_readonly`) is
// human-provisioned with `GRANT SELECT` on a small whitelist of tables and
// nothing else. Even if the application code were tricked into issuing an
// `INSERT` / `UPDATE` / `DELETE` through this client, Postgres would reject
// it at the role level — defence-in-depth on top of the application-level
// "no auth, output projection" boundary.
//
// Lazy instantiation: we only build the client on first access so that
// importing this module in tests (where neither env var is set) does not
// trigger Prisma's "DATABASE_URL is not set" error path.
//
// SSL handling mirrors `packages/db/src/client.ts` — Prisma 7 + Supabase
// pooler requires the `PrismaPg` driver adapter rather than the legacy
// `datasources` field.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import fs from "node:fs";
import path from "node:path";

let _client: PrismaClient | null = null;

function resolveSsl():
  | { ca: Buffer; rejectUnauthorized: true }
  | { rejectUnauthorized: false } {
  const caPath =
    process.env.SUPABASE_CA_CERT_PATH ??
    path.join(process.cwd(), "certs/supabase-ca.crt");
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
  const url = process.env.DATABASE_URL_READONLY ?? process.env.DATABASE_URL;
  if (!process.env.DATABASE_URL_READONLY && process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.warn(
      "[public-card] DATABASE_URL_READONLY not set; falling back to DATABASE_URL. " +
        "SET BEFORE PROD DEPLOY (per spec §9.1 #3).",
    );
  }
  if (!url) {
    throw new Error(
      "[public-card] Neither DATABASE_URL_READONLY nor DATABASE_URL is set.",
    );
  }
  const adapter = new PrismaPg({
    connectionString: stripSslmode(url),
    ssl: wantsSsl(url) ? resolveSsl() : false,
    idleTimeoutMillis: 30_000,
    max: 5,
    connectionTimeoutMillis: 10_000,
  });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
  });
}

export function getReadOnlyPrisma(): PrismaClient {
  if (!_client) {
    _client = buildClient();
  }
  return _client;
}
