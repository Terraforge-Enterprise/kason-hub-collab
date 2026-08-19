#!/usr/bin/env tsx
/**
 * Uploads sample photos/videos into the deployed Supabase `listing-media`
 * bucket and patches every Unit's photoKeys (and videoKeys for listed units).
 *
 * Source files:
 *   ~/Downloads/KAEN TEST PHOTOS/*.jpg  (24 files, deduped by SHA-256)
 *   ~/Downloads/KAEN TEST VIDEO.mp4
 *
 * Storage layout (bucket = SUPABASE_STORAGE_BUCKET):
 *   units/<unitId>/photo-1.jpg
 *   units/<unitId>/photo-2.jpg
 *   units/<unitId>/photo-3.jpg
 *   units/<unitId>/video.mp4   (only for units with listingStatus = "listed")
 *
 * Idempotent: upserts files and rewrites the DB arrays, so re-runs are safe.
 *
 * Usage:
 *   DATABASE_URL=$SUPABASE_DATABASE_URL npx tsx scripts/seed-supabase-media.ts --dry-run
 *   DATABASE_URL=$SUPABASE_DATABASE_URL npx tsx scripts/seed-supabase-media.ts --commit
 */
import "dotenv/config";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DRY = process.argv.includes("--dry-run");
const COMMIT = process.argv.includes("--commit");
if (!DRY && !COMMIT) {
  console.error("Missing mode flag. Pass --dry-run or --commit.");
  process.exit(2);
}
if (DRY && COMMIT) {
  console.error("Pass only one of --dry-run or --commit.");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be set (use $SUPABASE_DATABASE_URL for deployed).");
  process.exit(2);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !BUCKET) {
  console.error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET must be set.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Prisma — same adapter pattern as scripts/backfill-agent-levels.ts
// ---------------------------------------------------------------------------
function resolveSsl(): { ca: Buffer; rejectUnauthorized: true } | { rejectUnauthorized: false } {
  const caPath =
    process.env.SUPABASE_CA_CERT_PATH ?? path.join(process.cwd(), "certs/supabase-ca.crt");
  try {
    return { ca: fs.readFileSync(caPath), rejectUnauthorized: true as const };
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
    if (parsed.searchParams.get("sslmode") === "disable") return false;
    return true;
  } catch {
    return true;
  }
}
const dbUrl = process.env.DATABASE_URL!;
const adapter = new PrismaPg(
  {
    connectionString: stripSslmode(dbUrl),
    ssl: wantsSsl(dbUrl) ? resolveSsl() : false,
    idleTimeoutMillis: 30_000,
    max: 5,
    connectionTimeoutMillis: 10_000,
  },
  { disposeExternalPool: false },
);
const prisma = new PrismaClient({ adapter });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Source media — read & dedupe
// ---------------------------------------------------------------------------
const PHOTOS_DIR = path.join(os.homedir(), "Downloads", "KAEN TEST PHOTOS");
const VIDEO_PATH = path.join(os.homedir(), "Downloads", "KAEN TEST VIDEO.mp4");

type SourceFile = { name: string; bytes: Buffer; hash: string };

function loadPhotos(): SourceFile[] {
  if (!fs.existsSync(PHOTOS_DIR)) {
    throw new Error(`Photos dir not found: ${PHOTOS_DIR}`);
  }
  const files = fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => /\.jpe?g$/i.test(f))
    .sort();
  const seen = new Set<string>();
  const unique: SourceFile[] = [];
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(PHOTOS_DIR, name));
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    unique.push({ name, bytes, hash });
  }
  return unique;
}

function loadVideo(): Buffer {
  if (!fs.existsSync(VIDEO_PATH)) {
    throw new Error(`Video not found: ${VIDEO_PATH}`);
  }
  return fs.readFileSync(VIDEO_PATH);
}

// ---------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------
async function upload(key: string, body: Buffer, contentType: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET!).upload(key, body, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`upload ${key} failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const PHOTOS_PER_UNIT = 3;

async function main() {
  const photos = loadPhotos();
  const video = loadVideo();
  console.log(
    `Loaded ${photos.length} unique photo(s) (${photos.reduce((n, p) => n + p.bytes.length, 0)} bytes) and 1 video (${video.length} bytes).`,
  );

  const units = await prisma.unit.findMany({
    select: {
      id: true,
      unitCode: true,
      listingStatus: true,
      property: { select: { name: true } },
    },
    orderBy: [{ propertyId: "asc" }, { unitCode: "asc" }],
  });
  console.log(`Found ${units.length} unit(s).`);

  const listedUnits = units.filter((u) => u.listingStatus === "listed");
  console.log(`Of those, ${listedUnits.length} are listed → will receive a video.`);

  if (DRY) {
    console.log("\n[DRY RUN] Would upload:");
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const photoKeys = Array.from({ length: PHOTOS_PER_UNIT }, (_, j) => {
        const src = photos[(i * PHOTOS_PER_UNIT + j) % photos.length];
        return { key: `units/${u.id}/photo-${j + 1}.jpg`, src: src.name };
      });
      console.log(
        `  [${u.property.name} / ${u.unitCode}] ${photoKeys.length} photo(s)${u.listingStatus === "listed" ? " + 1 video" : ""}`,
      );
      for (const p of photoKeys) console.log(`    - ${p.key}  ← ${p.src}`);
      if (u.listingStatus === "listed") console.log(`    - units/${u.id}/video.mp4  ← KAEN TEST VIDEO.mp4`);
    }
    return;
  }

  let photoCount = 0;
  let videoCount = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const photoKeys: string[] = [];
    for (let j = 0; j < PHOTOS_PER_UNIT; j++) {
      const src = photos[(i * PHOTOS_PER_UNIT + j) % photos.length];
      const key = `units/${u.id}/photo-${j + 1}.jpg`;
      await upload(key, src.bytes, "image/jpeg");
      photoKeys.push(key);
      photoCount++;
    }
    const videoKeys: string[] = [];
    if (u.listingStatus === "listed") {
      const key = `units/${u.id}/video.mp4`;
      await upload(key, video, "video/mp4");
      videoKeys.push(key);
      videoCount++;
    }
    await prisma.unit.update({
      where: { id: u.id },
      data: { photoKeys, videoKeys },
    });
    console.log(
      `  ✓ ${u.property.name} / ${u.unitCode} — ${photoKeys.length} photo(s)${videoKeys.length ? " + video" : ""}`,
    );
  }
  console.log(`\nDone. Uploaded ${photoCount} photo(s) and ${videoCount} video(s) across ${units.length} unit(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
