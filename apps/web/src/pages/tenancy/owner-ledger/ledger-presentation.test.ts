import { describe, it, expect } from "vitest";
import { ownerLedgerRowStatus, groupByDirection } from "./ledger-presentation";

const row = (o: Partial<any>) => ({
  direction: "expense",
  paymentStatus: "paid",
  includeInPayout: true,
  status: "active",
  ...o,
});

describe("ownerLedgerRowStatus", () => {
  it("income → collection state", () =>
    expect(ownerLedgerRowStatus(row({ direction: "income", paymentStatus: "paid" })).label).toBe("Paid"));

  it("expense deducted vs owner-paid", () => {
    expect(ownerLedgerRowStatus(row({ includeInPayout: true })).label).toBe("Deducted");
    expect(ownerLedgerRowStatus(row({ includeInPayout: false })).label).toBe("Owner-paid");
  });

  it("void wins over everything", () =>
    expect(ownerLedgerRowStatus(row({ status: "void", includeInPayout: true })).label).toBe("Void"));

  // OwnerPaymentStatus has 6 real values (packages/shared/src/schemas/owner-ledger.ts:
  // paid | pending | reimbursed | partial | waived | cancelled), not the 4 the initial
  // brief's map covered. Production pages currently render "Reimbursed"/"Waived" via a
  // generic labelFor() title-caser (apps/web/src/lib/string-utils.ts) with a "slate"
  // tone fallback (apps/web/src/components/format.ts getStatusTone — neither term is in
  // any of its category lists, so it falls through to slate). Without these two entries,
  // this shared helper would regress those rows to a misleading "Pending" label once the
  // pages switch over to it.
  it("income reimbursed/waived get their own label, not the Pending fallback", () => {
    const reimbursed = ownerLedgerRowStatus(row({ direction: "income", paymentStatus: "reimbursed" }));
    expect(reimbursed.label).toBe("Reimbursed");
    expect(reimbursed.tone).toBe("slate");
    const waived = ownerLedgerRowStatus(row({ direction: "income", paymentStatus: "waived" }));
    expect(waived.label).toBe("Waived");
    expect(waived.tone).toBe("slate");
  });

  // Aligned to apps/web/src/components/format.ts getStatusTone(), which every
  // OTHER production page already renders these paymentStatus values through:
  // "pending" is in getStatusTone's amber category list, and "cancelled" is in
  // NONE of its category lists (only "terminated"/"void"/"voided"/"credited"/
  // "refunded"/"blacklisted"/"failed"/"archived"/"rejected" are rose — notably
  // NOT "cancelled") so it falls through to getStatusTone's own slate default.
  // Task-3 review flagged both as diverging from that; this fixes the map to
  // match getStatusTone's real output exactly, not a plausible-looking guess.
  it("income partial/pending/cancelled map to their documented label+tone", () => {
    expect(ownerLedgerRowStatus(row({ direction: "income", paymentStatus: "partial" }))).toEqual({ label: "Partial", tone: "amber" });
    expect(ownerLedgerRowStatus(row({ direction: "income", paymentStatus: "pending" }))).toEqual({ label: "Pending", tone: "amber" });
    expect(ownerLedgerRowStatus(row({ direction: "income", paymentStatus: "cancelled" }))).toEqual({ label: "Cancelled", tone: "slate" });
  });

  it("void wins over everything on an income row too, not only expense (acceptance criteria: either direction)", () =>
    expect(ownerLedgerRowStatus(row({ direction: "income", paymentStatus: "paid", status: "void" })).label).toBe("Void"));

  it("a row with `status` entirely omitted (portal DTO shape) is not void", () => {
    const portalRow = { direction: "income", paymentStatus: "paid", includeInPayout: true }; // no `status` key at all
    expect(ownerLedgerRowStatus(portalRow).label).toBe("Paid");
  });

  it("an unrecognized paymentStatus falls back to Pending/slate rather than throwing or going blank", () =>
    expect(ownerLedgerRowStatus(row({ direction: "income", paymentStatus: "some_future_status" }))).toEqual({ label: "Pending", tone: "slate" }));

  it("a payout-direction row (not expected to reach this function, but not a crash) takes the non-income branch", () =>
    expect(ownerLedgerRowStatus(row({ direction: "payout", includeInPayout: true })).label).toBe("Deducted"));
});

describe("groupByDirection", () => {
  it("splits and drops payout", () => {
    const g = groupByDirection([row({ direction: "income" }), row({ direction: "expense" }), row({ direction: "payout" })]);
    expect(g.income).toHaveLength(1);
    expect(g.expenses).toHaveLength(1);
  });

  it("empty input yields both groups empty", () => expect(groupByDirection([])).toEqual({ income: [], expenses: [] }));

  it("an all-payout list yields both groups empty", () => {
    const g = groupByDirection([row({ direction: "payout" }), row({ direction: "payout" })]);
    expect(g).toEqual({ income: [], expenses: [] });
  });

  it("a row with an unrecognized/malformed direction is dropped from BOTH groups, not leaked into either", () => {
    const g = groupByDirection([row({ direction: "refund" }), row({ direction: "income" })]);
    expect(g.income).toHaveLength(1);
    expect(g.expenses).toHaveLength(0);
  });

  it("does not mutate its input and is idempotent across repeat calls", () => {
    const entries = [row({ direction: "income" }), row({ direction: "expense" }), row({ direction: "payout" })];
    const snapshot = JSON.parse(JSON.stringify(entries));
    const first = groupByDirection(entries);
    const second = groupByDirection(entries);
    expect(entries).toEqual(snapshot); // input untouched
    expect(first).toEqual(second); // same input → same output every time
  });
});
