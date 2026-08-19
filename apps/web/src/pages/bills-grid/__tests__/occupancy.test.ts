import { describe, it, expect } from "vitest";
import { isOccupied, visibleUnits, visibleSubRows } from "../occupancy";
import type { GridRow, GridSubRow } from "@/api/bills-grid";

const sub = (id: string, opts: { tenancy?: boolean; currentKwh?: string; amount?: string } = {}): GridSubRow => ({
  listingId: id,
  tenancyId: opts.tenancy ? `t-${id}` : null,
  partyName: opts.tenancy ? "Tenant" : null,
  previousKwh: null,
  currentKwh: opts.currentKwh ?? null,
  amount: opts.amount ?? null,
  ratePerKwh: "0.60",
  rateConfigured: false,
  rental: null,
});

const row = (id: string, opts: { tenancy?: boolean; entry?: boolean } = {}): GridRow =>
  ({
    apartmentId: id, unitCode: id, propertyId: "p", propertyName: "P", entryId: opts.entry ? "e" : null,
    preview: null, previewError: null, warnings: [],
    subRows: [{ listingId: `${id}-r`, tenancyId: opts.tenancy ? "t" : null, partyName: null,
      previousKwh: null, currentKwh: null, amount: null, ratePerKwh: "0.60", rateConfigured: false, rental: null }],
    billedAt: null, paymentStatus: "unpaid", priorMonths: [],
    entry: opts.entry ? ({ updatedAt: "2026-07-14T00:00:00.000Z" } as GridRow["entry"]) : null,
    bearerConfig: {} as GridRow["bearerConfig"], expenses: { tenant: { total: "0", withSstTotal: "0", count: 0 }, owner: { total: "0", withSstTotal: "0", count: 0 } },
    attachments: [], isWholeUnit: false,
  }) as GridRow;

describe("occupancy", () => {
  it("isOccupied is true only when a sub-row has a tenancy", () => {
    expect(isOccupied(row("A", { tenancy: true }))).toBe(true);
    expect(isOccupied(row("B"))).toBe(false);
  });

  it("hides vacant-and-unsaved units and orders occupied first when showVacant=false", () => {
    const rows = [row("V"), row("A", { tenancy: true })];
    const out = visibleUnits(rows, false);
    expect(out.map((r) => r.unitCode)).toEqual(["A"]);
  });

  it("keeps a vacant unit that has a saved entry (money-safety)", () => {
    const out = visibleUnits([row("VE", { entry: true }), row("A", { tenancy: true })], false);
    expect(out.map((r) => r.unitCode)).toEqual(["A", "VE"]);
  });

  it("shows all with occupied-first when showVacant=true", () => {
    const out = visibleUnits([row("V"), row("A", { tenancy: true })], true);
    expect(out.map((r) => r.unitCode)).toEqual(["A", "V"]);
  });

  describe("visibleSubRows (vacant partition rooms)", () => {
    it("hides vacant (untenanted, dataless) rooms but keeps occupied rooms when showVacant=false", () => {
      const rooms = [sub("occupied", { tenancy: true }), sub("vacant1"), sub("vacant2")];
      const out = visibleSubRows(rooms, false);
      expect(out.map((r) => r.listingId)).toEqual(["occupied"]);
    });

    it("keeps a vacant room that still carries period data (orphan reading / entered amount) — money-safety", () => {
      const rooms = [
        sub("occupied", { tenancy: true }),
        sub("orphan-reading", { currentKwh: "1234" }),
        sub("has-amount", { amount: "50.00" }),
        sub("truly-vacant"),
      ];
      const out = visibleSubRows(rooms, false).map((r) => r.listingId);
      expect(out).toEqual(["occupied", "orphan-reading", "has-amount"]);
      expect(out).not.toContain("truly-vacant");
    });

    it("shows every room (incl. vacant) when showVacant=true", () => {
      const rooms = [sub("occupied", { tenancy: true }), sub("vacant")];
      expect(visibleSubRows(rooms, true).map((r) => r.listingId)).toEqual(["occupied", "vacant"]);
    });
  });

  it("treats a malformed row with undefined subRows as vacant, never throws (defensive — page-level, outside GridErrorBoundary)", () => {
    const bad = row("BAD");
    // @ts-expect-error — deliberately malformed, mirrors bills-grid-page.test.tsx's "error boundary" case
    bad.subRows = undefined;
    expect(() => isOccupied(bad)).not.toThrow();
    expect(isOccupied(bad)).toBe(false);
    expect(() => visibleUnits([bad], false)).not.toThrow();
  });
});
