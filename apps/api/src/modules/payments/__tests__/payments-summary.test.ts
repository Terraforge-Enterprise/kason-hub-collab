import { describe, it, expect, vi, beforeEach } from "vitest";

const { paymentFindManyMock } = vi.hoisted(() => ({ paymentFindManyMock: vi.fn() }));
vi.mock("@kason/db", () => ({ getDb: () => ({ payment: { findMany: paymentFindManyMock } }) }));

import { paymentsSummary } from "../payments.repository";

const ORG = "org-1";
function pRow(over: Record<string, unknown>) {
  return {
    status: "posted", gatewayStatus: null,
    amount: { toString: () => "1000" },
    allocations: [{ allocatedAmount: { toString: () => "1000" } }],
    ...over,
  };
}

beforeEach(() => paymentFindManyMock.mockReset());

describe("paymentsSummary", () => {
  it("summary figures", async () => {
    paymentFindManyMock.mockResolvedValue([
      pRow({}),                                                          // fully allocated posted
      pRow({ allocations: [] }),                                         // unallocated posted
      pRow({ status: "pending_approval", gatewayStatus: null, allocations: [] }),      // manual pending
      pRow({ status: "pending_approval", gatewayStatus: "pending", allocations: [] }), // in-flight FPX
      pRow({ status: "void", allocations: [] }),                         // excluded from received
    ]);
    const s = await paymentsSummary(ORG, new Date("2026-07-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"));
    expect(s.receivedTotal).toBe(2000);       // 2 posted
    expect(s.unallocatedCount).toBe(1);       // posted with amount > Σ alloc
    expect(s.pendingApprovalCount).toBe(1);   // in-flight FPX excluded
    expect(s.inFlightFpxCount).toBe(1);
  });
  it("scopes the query to receivedAt window + org", async () => {
    paymentFindManyMock.mockResolvedValue([]);
    await paymentsSummary(ORG, new Date("2026-07-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"));
    const where = paymentFindManyMock.mock.calls[0][0].where;
    expect(where.organizationId).toBe(ORG);
    expect(where.receivedAt).toEqual({ gte: new Date("2026-07-01T00:00:00Z"), lt: new Date("2026-08-01T00:00:00Z") });
  });
});
