const DEFAULT_PORT = 3001;

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function parseCorsOrigins(value: string | undefined): string | string[] {
  if (!value || value.trim() === "" || value.trim() === "*") return "*";
  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

const DEFAULT_AUDIT_RETENTION_DAYS = 10;
// 30 minutes — listing media is non-sensitive marketing content. Longer TTLs
// reduce re-signing churn when an admin sits on a unit detail page or an
// agent revisits a listing without leaving the session. Override via
// STORAGE_URL_TTL_SEC if you ever need to tighten this for sensitive data.
const DEFAULT_STORAGE_URL_TTL_SEC = 1800;
// Media size caps. Photo cap is fixed (15 MB covers any reasonable
// JPG/PNG/WebP). Video cap is environment-driven: Supabase Free caps each
// bucket at 50 MB by default; Pro raises it to 500 GB. Default to 50 MB
// (Free-tier safe). Override via VIDEO_MAX_BYTES in production once the
// Supabase bucket's `file_size_limit` has been raised in the dashboard.
// The application cap MUST NOT exceed the bucket cap — pre-signing succeeds
// at app cap but the actual PUT 413s at bucket cap, leaving a confusing UX.
const DEFAULT_PHOTO_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export const runtimeConfig = {
  port: parsePort(process.env.PORT),
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  limits: {
    auditRetentionDays: parsePositiveNumber(
      process.env.AUDIT_RETENTION_DAYS,
      DEFAULT_AUDIT_RETENTION_DAYS,
    ),
    storageUrlTtlSec: parsePositiveNumber(
      process.env.STORAGE_URL_TTL_SEC,
      DEFAULT_STORAGE_URL_TTL_SEC,
    ),
    photoMaxBytes: parsePositiveNumber(
      process.env.PHOTO_MAX_BYTES,
      DEFAULT_PHOTO_MAX_BYTES,
    ),
    videoMaxBytes: parsePositiveNumber(
      process.env.VIDEO_MAX_BYTES,
      DEFAULT_VIDEO_MAX_BYTES,
    ),
  },
  // Agent E-Namecard (spec §6.3, §9.1).
  // SUPABASE_PUBLIC_BUCKET_URL is the project URL prefix used to compose
  // deterministic listing-thumbnail URLs (e.g.
  // "https://<project>.supabase.co"). Required in production when the
  // FEATURE_AGENT_NAMECARD flag is on; not validated at boot here because
  // the public-card sub-app reads it lazily and the flag may be off.
  publicCard: {
    supabasePublicBucketUrl: process.env.SUPABASE_PUBLIC_BUCKET_URL ?? "",
    featureEnabled: parseBoolean(process.env.FEATURE_AGENT_NAMECARD, false),
    databaseUrlReadonly: process.env.DATABASE_URL_READONLY,
  },
};

// ── Production startup validation ──────────────────────────────────────────
// Fail fast if required env vars are missing. This runs at import time,
// so the process crashes before accepting traffic.

if (process.env.NODE_ENV === "production") {
  const required = ["DATABASE_URL", "SESSION_SECRET", "CORS_ORIGINS"] as const;

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables in production: ${missing.join(", ")}. ` +
      "Set these in the Lightsail container deployment or .env file."
    );
  }

  // Fail fast: wildcard CORS with credentials is rejected by browsers,
  // and disables CSRF protection. CORS_ORIGINS must be set in production.
  if (runtimeConfig.corsOrigins === "*") {
    throw new Error(
      "CORS_ORIGINS must be set in production (e.g. 'https://app.kaenproperties.com'). " +
      "Wildcard '*' with credentials: true is rejected by browsers."
    );
  }
}
