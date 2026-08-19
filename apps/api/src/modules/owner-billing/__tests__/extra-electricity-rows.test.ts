/**
 * The DERIVED "Extra Electricity" memo — the partition aircond spread named on the
 * owner statement.
 *
 * Pure-function suite (no DB): deriveExtraElectricityRows takes the ledger rows and an
 * apartment map and returns display-only IncomeBreakdownRows. The money property these
 * tests exist to defend is that the row NEVER moves the payout — the spread already
 * reaches the owner as Aircond Fee income minus the master TNB expense, so a second
 * real entry would pay them twice.
 */
import { describe, it, expect } from "vitest";
import { deriveExtraElectricityRows } from "../owner-statement-sections";

const MONTH = new Date("2026-07-01T00:00:00.000Z");
const APT = "apt-partition-1";
const APT_WHOLE = "apt-whole-1";

const PARTITION_MAP = new Map([[APT, { unitCode: "A-2", listingMode: "PARTITIONED" }]]);
const WHOLE_MAP = new Map([[APT_WHOLE, { unitCode: "A-1", listingMode: "WHOLE" }]]);

/** Σ per-room aircond collected from tenants (Source 4). */
const aircond = (amount: string, apartmentId = APT) => ({
  direction: "income", sourceType: "tenant_aircond", apartmentId, amount,
});
/** The raw master TNB bill booked as an owner expense (Source 7, bills-grid path). */
const gridTnb = (amount: string, apartmentId = APT) => ({
  direction: "expense", sourceType: "grid_utility_tnb", apartmentId, amount,
});

describe("deriveExtraElectricityRows", () => {
  // The client's worked case: master TNB 100, submeters collected 150 → 50 is the
  // owner's. Both numbers are already on the statement; this row names the difference.
  it("names the spread when aircond collections exceed the master TNB bill", () => {
    const rows = deriveExtraElectricityRows([aircond("150.00"), gridTnb("100.00")], PARTITION_MAP, MONTH);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe("50.00");
    expect(rows[0]!.unitCode).toBe("A-2");
    expect(rows[0]!.incomeType).toBe("Extra Electricity");
  });

  // THE money invariant. isInformational keeps it out of totalIncome and
  // passThroughIncome alike, and both fee columns are hard zero — charging a management
  // fee on a derived figure would invent a deduction from a number that is not a charge.
  it("is display-only: informational, not pass-through, zero management fee", () => {
    const [row] = deriveExtraElectricityRows([aircond("150.00"), gridTnb("100.00")], PARTITION_MAP, MONTH);
    expect(row!.isInformational).toBe(true);
    expect(row!.isPassThrough).toBe(false);
    expect(row!.mgmtFee).toBe("0.00");
    expect(row!.mgmtFeeSst).toBe("0.00");
  });

  // The ordinary month: KAEN's rate happens to recover less than the bill. There is no
  // spread, so there is no row — never a negative "extra payout".
  it("emits nothing when the master bill exceeds aircond collections", () => {
    expect(deriveExtraElectricityRows([aircond("80.00"), gridTnb("100.00")], PARTITION_MAP, MONTH)).toEqual([]);
  });

  it("emits nothing when the two sides net to exactly zero", () => {
    expect(deriveExtraElectricityRows([aircond("100.00"), gridTnb("100.00")], PARTITION_MAP, MONTH)).toEqual([]);
  });

  // Understating is the deliberate failure direction: both sides read the ledger's
  // COLLECTED amount, so an unpaid month shows aircond 0 against the full bill and the
  // memo stays silent rather than announcing money KAEN has not collected.
  it("stays silent on an unpaid month rather than claiming an uncollected spread", () => {
    expect(deriveExtraElectricityRows([aircond("0.00"), gridTnb("100.00")], PARTITION_MAP, MONTH)).toEqual([]);
  });

  // WHOLE is excluded structurally, not just arithmetically. One tenant on one master
  // meter means aircond > TNB is a data-entry error (what AIRCON_EXCEEDS_TNB rejects),
  // never owner profit — so even a positive spread must not surface as a payout memo.
  it("never emits for a WHOLE unit, even when the arithmetic would be positive", () => {
    const rows = deriveExtraElectricityRows(
      [aircond("150.00", APT_WHOLE), gridTnb("100.00", APT_WHOLE)], WHOLE_MAP, MONTH,
    );
    expect(rows).toEqual([]);
  });

  // Matching on sourceType rather than category is load-bearing: `utilities_tnb` is ALSO
  // the category of the display-only Source-2 twin (includeInPayout:false). Counting
  // that twin would subtract the master bill twice and wipe out a real spread.
  it("ignores the display-only Source-2 utility twin, which shares the utilities_tnb category", () => {
    const twin = { direction: "expense", sourceType: "statement", apartmentId: APT, amount: "100.00" };
    const rows = deriveExtraElectricityRows([aircond("150.00"), gridTnb("100.00"), twin], PARTITION_MAP, MONTH);
    expect(rows[0]!.amount).toBe("50.00"); // NOT "0.00" — the twin was not subtracted
  });

  // The legacy meter path books the same master bill under Source 3 `utility_tnb`.
  it("pairs the aircond income against the legacy meter-path TNB expense too", () => {
    const legacyTnb = { direction: "expense", sourceType: "utility_tnb", apartmentId: APT, amount: "100.00" };
    const rows = deriveExtraElectricityRows([aircond("150.00"), legacyTnb], PARTITION_MAP, MONTH);
    expect(rows[0]!.amount).toBe("50.00");
  });

  // A combined (multi-unit) statement derives per apartment, and the order is pinned:
  // the PDF render and the GET /sections API are separate invocations of the assembler,
  // so an unstable order would let the soft copy drift from the screen.
  it("derives per apartment and returns them in a stable unit-code order", () => {
    const apt2 = "apt-partition-2";
    const map = new Map([
      [APT, { unitCode: "B-9", listingMode: "PARTITIONED" }],
      [apt2, { unitCode: "B-1", listingMode: "PARTITIONED" }],
    ]);
    const rows = deriveExtraElectricityRows(
      [aircond("150.00"), gridTnb("100.00"), aircond("300.00", apt2), gridTnb("220.00", apt2)],
      map, MONTH,
    );
    expect(rows.map((r) => [r.unitCode, r.amount])).toEqual([["B-1", "80.00"], ["B-9", "50.00"]]);
  });

  // Legacy rows predating per-apartment ledger keying carry no apartmentId; they cannot
  // be attributed to a unit, so they must be skipped rather than pooled into another's.
  it("skips ledger rows with no apartmentId", () => {
    const orphan = { direction: "income", sourceType: "tenant_aircond", apartmentId: null, amount: "999.00" };
    const rows = deriveExtraElectricityRows([aircond("150.00"), gridTnb("100.00"), orphan], PARTITION_MAP, MONTH);
    expect(rows[0]!.amount).toBe("50.00");
  });

  // An apartment whose listings are all archived has no unit code to render under.
  it("skips an apartment missing from the apartment map", () => {
    expect(deriveExtraElectricityRows([aircond("150.00"), gridTnb("100.00")], new Map(), MONTH)).toEqual([]);
  });

  it("sums multiple aircond rows (one per room) against the single master bill", () => {
    const rows = deriveExtraElectricityRows(
      [aircond("60.00"), aircond("50.00"), aircond("40.00"), gridTnb("100.00")], PARTITION_MAP, MONTH,
    );
    expect(rows[0]!.amount).toBe("50.00");
  });
});
