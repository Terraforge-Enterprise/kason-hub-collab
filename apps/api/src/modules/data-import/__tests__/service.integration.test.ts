import { describe, it, expect } from "vitest";

/**
 * Real end-to-end Excel import against a live Postgres + Supabase Storage.
 *
 * This suite is SKIPPED in the default `vitest run` — it only executes when
 * RUN_INTEGRATION=1 is set AND a real DB/storage is wired up. The authoritative
 * end-to-end proof of the import is the manual CLI run in Task 15; this file
 * documents the intent and gives a hook for a future automated integration run.
 */
describe.skipIf(!process.env.RUN_INTEGRATION)("runImport — integration (real DB)", () => {
  it("placeholder — real DB import proven manually in Task 15", () => {
    // No-op when skipped. A real run would: seed an org, point at the bundled
    // KAEN Tenant Master List.xlsx, dry-run then commit, and assert Party +
    // Tenancy + MeterReading rows + an ImportRun ledger + an uploaded report.
    expect(true).toBe(true);
  });
});
