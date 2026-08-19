import { describe, it, expect, vi, beforeEach } from "vitest";

// `sumReversalsForAllocations` reads `tx.paymentAllocationReversal.groupBy`, so
// mocking that key lets the REAL helper run against this mock rather than
// stubbing the helper out — the reversal arithmetic stays under test.
const mockDb = {
  charge: { findMany: vi.fn() },
  paymentAllocation: { findMany: vi.fn() },
  paymentAllocationReversal: { groupBy: vi.fn() },
};
vi.mock("@kason/db", () => ({ getDb: () => mockDb }));

import { assertCommissionWritable } from "../commission-guard";

const SESSION = { role: "admin", orgId: "org-1" };

/** No allocations, no reversals — the "nothing has been paid" baseline. */
function unpaid(chargeIds: string[] = ["c1"]) {
  mockDb.charge.findMany.mockResolvedValue(chargeIds.map((id) => ({ id })));
  mockDb.paymentAllocation.findMany.mockResolvedValue([]);
  mockDb.paymentAllocationReversal.groupBy.mockResolvedValue([]);
}

/** One allocation of `amount`, reversed by `reversedAmount` (0 = untouched). */
function paid(amount: string, reversedAmount: string | null = null) {
  mockDb.charge.findMany.mockResolvedValue([{ id: "c1" }]);
  mockDb.paymentAllocation.findMany.mockResolvedValue([
    { id: "a1", allocatedAmount: amount },
  ]);
  mockDb.paymentAllocationReversal.groupBy.mockResolvedValue(
    reversedAmount === null
      ? []
      : [{ originalAllocationId: "a1", _sum: { amount: reversedAmount } }],
  );
}

describe("assertCommissionWritable — commission field write-lock", () => {
  beforeEach(() => {
    mockDb.charge.findMany.mockReset();
    mockDb.paymentAllocation.findMany.mockReset();
    mockDb.paymentAllocationReversal.groupBy.mockReset();
  });

  // ── Unchanged rules ───────────────────────────────────────────────────────

  it("editor is forbidden (403) regardless of billing state", async () => {
    expect(await assertCommissionWritable({ role: "editor", orgId: "org-1" }, true, "t1")).toMatchObject({
      ok: false,
      status: 403,
      code: "COMMISSION_FIELDS_FORBIDDEN",
    });
  });

  it("not changing → ok without touching the DB", async () => {
    expect(await assertCommissionWritable(SESSION, false, "t1")).toEqual({ ok: true });
    expect(mockDb.charge.findMany).not.toHaveBeenCalled();
    expect(mockDb.paymentAllocation.findMany).not.toHaveBeenCalled();
  });

  // ── The scope of "which charges carry the commission economics" ───────────

  it("M-D1: the charge scan includes letting_commission, not only rent (else settings stay editable after the commission is billed)", async () => {
    unpaid();
    await assertCommissionWritable(SESSION, true, "t1");
    expect(mockDb.charge.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        tenancyId: "t1",
        chargeType: { in: ["rent", "letting_commission"] },
      },
      select: { id: true },
    });
  });

  it("scopes both reads to the session's organization", async () => {
    paid("500.00");
    await assertCommissionWritable(SESSION, true, "t1");
    expect(mockDb.charge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-1" }) }),
    );
    expect(mockDb.paymentAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-1" }) }),
    );
  });

  // ── The behaviour this change exists for ─────────────────────────────────

  it("a draft invoice no longer locks: unbilled cash means the fields stay editable", async () => {
    unpaid();
    expect(await assertCommissionWritable(SESSION, true, "t1")).toEqual({ ok: true });
  });

  it("a posted but wholly unpaid charge does not lock", async () => {
    unpaid();
    expect(await assertCommissionWritable(SESSION, true, "t1")).toEqual({ ok: true });
  });

  it("skips the allocation query entirely when the tenancy has no rent/commission charges", async () => {
    unpaid([]);
    expect(await assertCommissionWritable(SESSION, true, "t1")).toEqual({ ok: true });
    expect(mockDb.paymentAllocation.findMany).not.toHaveBeenCalled();
  });

  it("a phantom (non-cash) allocation does not lock — the cash filter excluded it upstream", async () => {
    // The real CASH_ALLOCATION_WHERE predicate is what removes an FPX row minted
    // at initiate; at this level that shows up as an empty result set. The
    // end-to-end proof of the filter is the static allocation-cash-filter guard.
    unpaid();
    expect(await assertCommissionWritable(SESSION, true, "t1")).toEqual({ ok: true });
  });

  // ── Cash received ────────────────────────────────────────────────────────

  it("locks (409) once cash has been received against a rent/commission charge", async () => {
    paid("500.00");
    expect(await assertCommissionWritable(SESSION, true, "t1")).toMatchObject({
      ok: false,
      status: 409,
      code: "COMMISSION_FIELDS_LOCKED",
      error: "Commission fields are locked once a payment has been received against this tenancy",
    });
  });

  it("sums across multiple allocations on multiple charges", async () => {
    mockDb.charge.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    mockDb.paymentAllocation.findMany.mockResolvedValue([
      { id: "a1", allocatedAmount: "0.00" },
      { id: "a2", allocatedAmount: "0.01" },
    ]);
    mockDb.paymentAllocationReversal.groupBy.mockResolvedValue([]);
    expect(await assertCommissionWritable(SESSION, true, "t1")).toMatchObject({ status: 409 });
  });

  // ── Reversals: the lock is deliberately non-monotonic ────────────────────

  it("a fully reversed payment re-opens the fields", async () => {
    paid("500.00", "500.00");
    expect(await assertCommissionWritable(SESSION, true, "t1")).toEqual({ ok: true });
  });

  it("a partial reversal leaving net cash above the threshold still locks", async () => {
    paid("500.00", "495.00");
    expect(await assertCommissionWritable(SESSION, true, "t1")).toMatchObject({ status: 409 });
  });

  it("net cash at or below the 0.005 threshold does not lock", async () => {
    paid("500.00", "499.999");
    expect(await assertCommissionWritable(SESSION, true, "t1")).toEqual({ ok: true });
  });

  it("an over-reversed allocation cannot cancel out a genuinely paid one", async () => {
    // Each allocation is gated at the threshold BEFORE summing (as
    // rebillSupersedeTx does). Summing raw nets would give 500 + (-500) = 0 and
    // wrongly re-open the fields while RM500 sits received on a1.
    mockDb.charge.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    mockDb.paymentAllocation.findMany.mockResolvedValue([
      { id: "a1", allocatedAmount: "500.00" },
      { id: "a2", allocatedAmount: "100.00" },
    ]);
    mockDb.paymentAllocationReversal.groupBy.mockResolvedValue([
      { originalAllocationId: "a2", _sum: { amount: "600.00" } },
    ]);
    expect(await assertCommissionWritable(SESSION, true, "t1")).toMatchObject({ status: 409 });
  });
});
