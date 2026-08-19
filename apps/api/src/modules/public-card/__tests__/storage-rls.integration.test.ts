// Storage RLS integration test for the unit-thumbnails public bucket
// (per spec §6.5).
//
// SKIPPED unless BOTH of these env vars are set:
//   - SUPABASE_PUBLIC_BUCKET_URL  (e.g. "https://<project>.supabase.co")
//   - UNIT_THUMBNAILS_TEST_KEY    (e.g. "_test/probe.jpg")
//
// Run AFTER human-only steps:
//   H1 — bucket creation: `unit-thumbnails`, marked PUBLIC.
//   H2 — RLS policy: anonymous LIST denied; anonymous GET on individual
//        objects allowed. (Public bucket default Storage policy in Supabase
//        permits direct object reads; LIST is blocked unless explicitly
//        opened. The probe below verifies both halves of that contract.)
//   H3 — upload a fixture file at `_test/probe.jpg` so the GET probe has
//        something to fetch.
//
// What this test does NOT do:
//   - It does NOT use a service-role key. The whole point is to exercise
//     anonymous access: no Authorization header, no apikey header.
//   - It does NOT attempt to write. The bucket should reject anonymous
//     uploads regardless; that's covered by Supabase's defaults.

import { describe, it, expect } from "vitest";

const BUCKET_URL = process.env.SUPABASE_PUBLIC_BUCKET_URL;
const TEST_KEY = process.env.UNIT_THUMBNAILS_TEST_KEY;

const enabled = !!BUCKET_URL && !!TEST_KEY;
const describeMaybe = enabled ? describe : describe.skip;

describeMaybe("Storage RLS — anonymous access (per spec §6.5)", () => {
  it("LIST endpoint returns 4xx for anonymous (no objects leaked)", async () => {
    const res = await fetch(
      `${BUCKET_URL}/storage/v1/object/list/unit-thumbnails`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "", limit: 100 }),
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("Direct object fetch on a public-bucket file returns 200", async () => {
    const res = await fetch(
      `${BUCKET_URL}/storage/v1/object/public/unit-thumbnails/${TEST_KEY}`,
    );
    expect([200, 304]).toContain(res.status);
  });
});
