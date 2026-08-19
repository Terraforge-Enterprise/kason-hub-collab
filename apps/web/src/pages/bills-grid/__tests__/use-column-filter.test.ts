import { describe, it, expect } from "vitest";
import { applyFilters } from "../use-column-filter";
import type { GridRow, GridSubRow } from "@/api/bills-grid";

const sub = (o: Partial<GridSubRow>): GridSubRow => ({
  listingId: "L", tenancyId: "T", partyName: null, partyPhone: null, previousKwh: null, currentKwh: null,
  amount: null, ratePerKwh: "0.60", rateConfigured: false, rental: null, ...o,
});

const row = (o: Partial<GridRow>): GridRow =>
  ({
    apartmentId: "a", unitCode: "A-01-01", propertyId: "p", propertyName: "Sunway Vista",
    ownerName: null, entryId: null, preview: null, previewError: null, warnings: [],
    subRows: [], billedAt: null, paymentStatus: "unpaid", priorMonths: [], entry: null,
    bearerConfig: {} as GridRow["bearerConfig"],
    expenses: { tenant: { total: "0", withSstTotal: "0", count: 0 }, owner: { total: "0", withSstTotal: "0", count: 0 } },
    attachments: [], isWholeUnit: false, ...o,
  }) as GridRow;

const matches = (rows: GridRow[], needle: string) =>
  applyFilters(rows, [], { unitCode: needle }, { from: null, to: null }).rows.map((r) => r.unitCode).sort();

describe("bills-grid filter — one box matches unit / name / phone", () => {
  const rows = [
    row({
      unitCode: "A-01-01", ownerName: "Tan Ah Kow",
      subRows: [sub({ partyName: "Ali bin Ahmad", partyPhone: "011-2223333" })],
    }),
    row({
      unitCode: "B-02-02", ownerName: "Lim Bee",
      subRows: [sub({ partyName: "Siti binti Yusof", partyPhone: "017-5554444" })],
    }),
  ];

  it("matches by unit code", () => expect(matches(rows, "A-01")).toEqual(["A-01-01"]));
  it("matches by owner name", () => expect(matches(rows, "ah kow")).toEqual(["A-01-01"]));
  it("matches by tenant name", () => expect(matches(rows, "siti")).toEqual(["B-02-02"]));
  it("matches by property name (both share it)", () => expect(matches(rows, "sunway")).toEqual(["A-01-01", "B-02-02"]));
  it("does NOT match by owner phone (owner phone is neither shown nor searched)", () =>
    expect(matches(rows, "3456789")).toEqual([]));
  it("matches tenant phone typed WITHOUT dashes (digit-stripped haystack)", () =>
    expect(matches(rows, "0175554444")).toEqual(["B-02-02"]));
  it("empty needle keeps every row", () => expect(matches(rows, "")).toEqual(["A-01-01", "B-02-02"]));
  it("no match → empty", () => expect(matches(rows, "zzz")).toEqual([]));
});
