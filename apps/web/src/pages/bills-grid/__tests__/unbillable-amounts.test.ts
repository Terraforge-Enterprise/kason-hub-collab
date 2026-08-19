/**
 * tenant_direct silent-drop warning (2026-07-27) — the pure detector behind the pre-Bill notice.
 *
 * Regression origin: a real unit (A-15-03, Jul-2026) had TNB 500.00 and AIR 100.00 typed and
 * saved while both patterns were "Tenant pays directly". The Bill discarded both — shapeUtilityPool
 * removes them from the tenant pool and the mint skips the component — and issued only the owner
 * scalars, with no signal anywhere that RM 600 of typed figures had been dropped. The TNB half was
 * doubly invisible: cell-applicability had no TNB case at all, so the cell stayed fully editable.
 */
import { describe, expect, it } from "vitest";
import type { GridRow } from "@/api/bills-grid";
import { findUnbillableAmounts } from "../unbillable-amounts";

/** A minimally-shaped grid row; only the fields the detector reads matter. */
function row(opts: {
  unitCode: string;
  tnbPattern?: string;
  airPattern?: string;
  tnbTotal?: string | null;
  airSelangor?: string | null;
  noEntry?: boolean;
}): GridRow {
  const entry = opts.noEntry
    ? null
    : {
        cleaning: null,
        tnbTotal: opts.tnbTotal ?? null,
        airSelangor: opts.airSelangor ?? null,
        wifi: null,
        maintenanceFee: null,
        readingDate: null,
        paymentStatus: "unpaid",
        tnbPattern: opts.tnbPattern ?? "recharged",
        airPattern: opts.airPattern ?? "recharged",
        cleaningBearer: "owner",
        wifiBearer: "owner",
        maintenanceFeeBearer: "owner",
        updatedAt: "2026-07-26T00:00:00.000Z",
        lockState: "draft" as const,
      };
  return {
    apartmentId: `apt-${opts.unitCode}`,
    unitCode: opts.unitCode,
    entry,
    bearerConfig: {
      tnbPattern: opts.tnbPattern ?? "recharged",
      airPattern: opts.airPattern ?? "recharged",
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      cleaningRecurringAmount: "100.00",
      isLocked: false,
    },
  } as unknown as GridRow;
}

describe("findUnbillableAmounts", () => {
  it("reports BOTH typed amounts when TNB and AIR are tenant_direct (the A-15-03 case)", () => {
    const out = findUnbillableAmounts([
      row({ unitCode: "A-15-03", tnbPattern: "tenant_direct", airPattern: "tenant_direct", tnbTotal: "500.00", airSelangor: "100.00" }),
    ]);
    expect(out).toEqual([{ unitCode: "A-15-03", items: ["TNB RM 500.00", "AIR (water) RM 100.00"] }]);
  });

  it("stays silent for a recharged unit — the amounts there ARE billed", () => {
    expect(findUnbillableAmounts([row({ unitCode: "A-08-02", tnbTotal: "500.00", airSelangor: "20.00" })])).toEqual([]);
  });

  it("reports only the tenant_direct side when the two patterns differ", () => {
    const out = findUnbillableAmounts([
      row({ unitCode: "A-01-01", tnbPattern: "tenant_direct", airPattern: "recharged", tnbTotal: "300.00", airSelangor: "40.00" }),
    ]);
    expect(out).toEqual([{ unitCode: "A-01-01", items: ["TNB RM 300.00"] }]);
  });

  it("ignores tenant_direct with nothing typed — there is no drop to warn about", () => {
    const out = findUnbillableAmounts([
      row({ unitCode: "A-02-02", tnbPattern: "tenant_direct", airPattern: "tenant_direct", tnbTotal: null, airSelangor: "0.00" }),
    ]);
    expect(out).toEqual([]);
  });

  it("ignores a row with no entry — nothing has been typed or saved yet", () => {
    expect(findUnbillableAmounts([row({ unitCode: "A-03-03", tnbPattern: "tenant_direct", noEntry: true })])).toEqual([]);
  });

  it("returns one item per affected unit, skipping the clean ones", () => {
    const out = findUnbillableAmounts([
      row({ unitCode: "A-01", tnbPattern: "tenant_direct", tnbTotal: "100.00" }),
      row({ unitCode: "A-02", tnbTotal: "200.00" }),
      row({ unitCode: "A-03", airPattern: "tenant_direct", airSelangor: "50.00" }),
    ]);
    expect(out.map((r) => r.unitCode)).toEqual(["A-01", "A-03"]);
  });
});
