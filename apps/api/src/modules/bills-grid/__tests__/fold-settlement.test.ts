// Read-time settlement fold — the rules that decide whether an admin sees a grid line
// as PAID. Pure (no DB): foldSettlement takes already-scoped LIVE charges.
//
// The scenario throughout mirrors the real bug this shipped for: the tenant paid their
// invoice in full while the owner invoice is untouched. Every tenant column must tick;
// the row must NOT claim "paid" while owner money is outstanding.
import { describe, it, expect } from "vitest";
import { foldSettlement, type SettlementChargeFact } from "../service";

const ENTRY = "entry-1";

function fact(over: Partial<SettlementChargeFact> = {}): SettlementChargeFact {
  return {
    entryId: ENTRY,
    categoryCode: "electricity_tenant",
    isExpense: false,
    expenseId: null,
    side: "tenant",
    roomId: null,
    isSettled: false,
    isTouched: false,
    ...over,
  };
}

const paid = (over: Partial<SettlementChargeFact> = {}) => fact({ isSettled: true, isTouched: true, ...over });

describe("foldSettlement", () => {
  it("no charges → no entry at all (an unbilled row must not read as unpaid money)", () => {
    expect(foldSettlement([]).size).toBe(0);
  });

  it("routes each category+side to its own bucket", () => {
    const r = foldSettlement([
      paid({ categoryCode: "electricity_tenant", side: "tenant" }),
      paid({ categoryCode: "water_tenant", side: "tenant" }),
      paid({ categoryCode: "wifi_tenant", side: "tenant" }),
      paid({ categoryCode: "cleaning_tenant", side: "tenant" }),
      paid({ categoryCode: "recurring_other_tenant", side: "tenant" }),
      fact({ categoryCode: "maintenance_owner", side: "owner" }),
      fact({ categoryCode: "recurring_other_owner", side: "owner" }),
    ]).get(ENTRY)!;

    expect(r.cells.tnbTenant).toBe("paid");
    expect(r.cells.airTenant).toBe("paid");
    expect(r.cells.wifiTenant).toBe("paid");
    expect(r.cells.cleaningTenant).toBe("paid");
    expect(r.cells.recurringTenant).toBe("paid");
    expect(r.cells.maintenanceOwner).toBe("unpaid");
    expect(r.cells.recurringOwner).toBe("unpaid");
    // Untouched buckets stay "none" — nothing billed there, so nothing to show.
    expect(r.cells.tnbOwner).toBe("none");
  });

  it("tenant fully paid + owner untouched → row is PARTIAL, never paid", () => {
    const r = foldSettlement([
      paid({ categoryCode: "electricity_tenant", side: "tenant" }),
      fact({ categoryCode: "maintenance_owner", side: "owner" }),
    ]).get(ENTRY)!;
    expect(r.status).toBe("partial");
  });

  it("every charge settled → row PAID", () => {
    const r = foldSettlement([
      paid({ categoryCode: "electricity_tenant", side: "tenant" }),
      paid({ categoryCode: "maintenance_owner", side: "owner" }),
    ]).get(ENTRY)!;
    expect(r.status).toBe("paid");
  });

  it("a bucket with ONE unsettled charge is never 'paid'", () => {
    const r = foldSettlement([
      paid({ categoryCode: "electricity_tenant" }),
      fact({ categoryCode: "electricity_tenant" }), // same bucket, unpaid
    ]).get(ENTRY)!;
    expect(r.cells.tnbTenant).toBe("partial");
    expect(r.status).toBe("partial");
  });

  it("a FULLY REVERSED payment does not read as partial — it is untouched money", () => {
    // isTouched is net-of-reversal: a reversed allocation nets to 0, so the charge is
    // both unsettled and untouched. Mis-reading this as "partial" would tell an admin
    // money had come in when it had been clawed back.
    const r = foldSettlement([fact({ isSettled: false, isTouched: false })]).get(ENTRY)!;
    expect(r.cells.tnbTenant).toBe("unpaid");
    expect(r.status).toBe("unpaid");
  });

  it("part-paid (money in, still owing) → partial", () => {
    const r = foldSettlement([fact({ isSettled: false, isTouched: true })]).get(ENTRY)!;
    expect(r.status).toBe("partial");
  });

  describe("PARTITIONED unit — per-room grain", () => {
    it("one paid room ticks while its unpaid sibling does not", () => {
      const r = foldSettlement([
        paid({ categoryCode: "electricity_tenant", roomId: "room-A" }),
        fact({ categoryCode: "electricity_tenant", roomId: "room-B" }),
      ]).get(ENTRY)!;

      expect(r.rooms["room-A"]!.tnbTenant).toBe("paid");
      expect(r.rooms["room-B"]!.tnbTenant).toBe("unpaid");
      // The unit-level roll-up stays honest: not everything is settled.
      expect(r.cells.tnbTenant).toBe("partial");
      expect(r.status).toBe("partial");
    });

    it("a whole unit (no roomId) records no room grain, so the cell falls back to unit level", () => {
      const r = foldSettlement([paid({ categoryCode: "electricity_tenant", roomId: null })]).get(ENTRY)!;
      expect(r.rooms).toEqual({});
      expect(r.cells.tnbTenant).toBe("paid");
    });
  });

  it("expense charges bucket by SIDE, not by their varied category codes", () => {
    // GRIDEXP- charges carry categories like access_card_replacement / renewal_fee that
    // encode no side — the bearer comes from the document they were issued on.
    const r = foldSettlement([
      paid({ categoryCode: "access_card_replacement", isExpense: true, side: "tenant" }),
      paid({ categoryCode: "renewal_fee", isExpense: true, side: "tenant" }),
      fact({ categoryCode: "other_expense_owner", isExpense: true, side: "owner" }),
    ]).get(ENTRY)!;
    expect(r.cells.expensesTenant).toBe("paid");
    expect(r.cells.expensesOwner).toBe("unpaid");
  });

  it("an UNRECOGNISED category still counts in the row roll-up (never silently dropped)", () => {
    // The failure this guards: a charge that maps to no grid column vanishing from the
    // roll-up would show a row as fully Paid while that money is still owed.
    const r = foldSettlement([
      paid({ categoryCode: "electricity_tenant", side: "tenant" }),
      fact({ categoryCode: "sewerage_tenant", side: "tenant" }),
    ]).get(ENTRY)!;
    expect(r.cells.otherTenant).toBe("unpaid");
    expect(r.status).toBe("partial");
  });

  it("keeps entries separate", () => {
    const r = foldSettlement([
      paid({ entryId: "e1" }),
      fact({ entryId: "e2" }),
    ]);
    expect(r.get("e1")!.status).toBe("paid");
    expect(r.get("e2")!.status).toBe("unpaid");
  });

  // ── LINE grain (expenseLines) ──────────────────────────────────────────────
  //
  // The `expenses{Owner,Tenant}` bucket collapses every expense on the month into one
  // state, so it can say "some expense money arrived" but never WHICH line. The dialog
  // edits lines individually, so it needs the finer grain — without it, it rendered a
  // live <input> over a line the server had already frozen.
  describe("expenseLines (per-GridExpense grain)", () => {
    const expense = (over: Partial<SettlementChargeFact> = {}) =>
      fact({ isExpense: true, categoryCode: "other_tenant", ...over });

    it("resolves each expense line independently", () => {
      const r = foldSettlement([
        paid({ isExpense: true, categoryCode: "other_tenant", expenseId: "exp-paid" }),
        expense({ expenseId: "exp-open" }),
      ]).get(ENTRY)!;
      expect(r.expenseLines["exp-paid"]).toBe("paid");
      expect(r.expenseLines["exp-open"]).toBe("unpaid");
      // The coarse bucket can only say "mixed" — which is exactly why the line grain exists.
      expect(r.cells.expensesTenant).toBe("partial");
    });

    it("an SST-bearing line reads PARTIAL until its SST sibling settles too", () => {
      // A line with SST mints TWO charges under one sourceGridExpenseId (the base and its
      // `-SST` sibling, service.ts:2103-2114). Settling only the base leaves real tax
      // outstanding, so the line must NOT read paid — this is why the fold counts charges
      // rather than short-circuiting on the first settled one.
      const r = foldSettlement([
        paid({ isExpense: true, categoryCode: "other_tenant", expenseId: "exp-sst" }),
        expense({ expenseId: "exp-sst" }),
      ]).get(ENTRY)!;
      expect(r.expenseLines["exp-sst"]).toBe("partial");
    });

    it("reads PAID only when every charge of the line is settled", () => {
      const r = foldSettlement([
        paid({ isExpense: true, categoryCode: "other_tenant", expenseId: "exp-sst" }),
        paid({ isExpense: true, categoryCode: "other_tenant", expenseId: "exp-sst" }),
      ]).get(ENTRY)!;
      expect(r.expenseLines["exp-sst"]).toBe("paid");
    });

    it("never creates a key for a charge with no expense id", () => {
      // A utility charge carries expenseId null. A `null`/"null" key here would be
      // indistinguishable from a real GridExpense id to the dialog, which would then
      // lock — or wrongly unlock — an arbitrary line.
      const r = foldSettlement([
        paid({ categoryCode: "electricity_tenant", expenseId: null }),
        expense({ expenseId: "exp-1" }),
      ]).get(ENTRY)!;
      expect(Object.keys(r.expenseLines)).toEqual(["exp-1"]);
    });

    it("is empty for an entry with no expense charges at all", () => {
      const r = foldSettlement([paid({ categoryCode: "electricity_tenant" })]).get(ENTRY)!;
      expect(r.expenseLines).toEqual({});
    });

    it("keeps one line's payment from leaking onto another entry's line of the same id", () => {
      // expenseLines lives INSIDE the per-entry accumulator, so two entries can never
      // share a tally even if an id somehow repeated.
      const r = foldSettlement([
        paid({ entryId: "e1", isExpense: true, categoryCode: "other_tenant", expenseId: "exp-x" }),
        expense({ entryId: "e2", expenseId: "exp-x" }),
      ]);
      expect(r.get("e1")!.expenseLines["exp-x"]).toBe("paid");
      expect(r.get("e2")!.expenseLines["exp-x"]).toBe("unpaid");
    });
  });
});
