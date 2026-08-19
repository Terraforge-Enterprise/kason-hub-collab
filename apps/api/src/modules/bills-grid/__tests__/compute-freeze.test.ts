// apps/api/src/modules/bills-grid/__tests__/compute-freeze.test.ts
// HARD CONSTRAINT 1: apps/api/src/modules/meter/compute.ts is PINNED. The
// bills-grid module reads it and must never change it INCIDENTALLY — a
// whitespace- or comment-only edit a reviewer might wave through still fails
// here, forcing any change to be deliberate + re-pinned.
//
// Re-pinned 2026-07-21 for the additive `privateAircond` flag (PARTITIONED
// private per-room electricity: aircond Σ may exceed TNB, excess = owner
// profit). Default false keeps the shared master-meter model byte-identical;
// only the guard gate + a leftover clamp changed. See the meter/compute.ts
// diff and meter/compute.test.ts's private-partition cases.
//
// Re-pinned 2026-07-28 (2nd) for the lock-step refactor, piece B: the per-room gross shares
// are now ONE `ShareComponents` record that AllocationLine derives from, and grossShareTotal is
// SUMMED from it (Object.values) instead of being a hand-written addition. A new share component
// can no longer reach computedAmount while being left out of the total. STRUCTURE ONLY — the same
// numbers are added in the same literal order, so every result is identical; meter/compute.test.ts
// (16 cases, exact numeric assertions) passes unchanged.
//
// Re-pinned 2026-07-28 to make the MAINTENANCE scalar billable. `maintenance`
// joins PoolComponents/Bearers and gains a per-room `maintenanceShare`, using
// the SAME bearer-gated shape as wifi/cleaning: it enters the tenant pool only
// when its bearer is "tenant", otherwise it is owner-borne. ADDITIVE — with
// maintenance 0 and bearer "owner" (the default, and what the meter path always
// passes) every intermediate and every share is byte-identical to the previous
// pin. See meter/compute.test.ts's maintenance cases for the parity proof.
// Re-pinned 2026-07-29: ShareComponents / AllocationLine MOVED to @kason/shared
// (types/allocation.ts) and are re-exported from here. The two web copies of that shape
// (apps/web/src/api/bills-grid.ts, apps/web/src/api/meter.ts) were hand-written
// restatements — when `maintenance` became billable neither declared `maintenanceShare`
// while grossShareTotal already included it, so the web could show a breakdown whose
// parts did not foot to the total beside them. They are aliases now, so the shape cannot
// disagree across the package boundary. TYPE-ONLY: no value, no arithmetic and no
// declaration ORDER changed in this file; meter/compute.test.ts's exact numeric
// assertions pass unchanged.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FROZEN = join(__dirname, "..", "..", "meter", "compute.ts");
const PINNED_SHA256 = "14caba3c0197da50244b0b7a71359eb7439a8717d6422968c1beb6bdbeea4414";

describe("compute.ts byte-freeze", () => {
  it("hashes to the pinned SHA-256", () => {
    const actual = createHash("sha256").update(readFileSync(FROZEN)).digest("hex");
    expect(actual).toBe(PINNED_SHA256);
  });
});
