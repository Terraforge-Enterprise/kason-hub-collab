import { describe, it, expect, beforeEach, vi } from "vitest";
import { cascadeCancelClaimsOnSalesUnitTermination } from "../cascade-cancel-claims-on-sales-unit-termination";

const txMock = {
  salesClaim: { findMany: vi.fn(), updateMany: vi.fn() },
  salesClaimTransition: { createMany: vi.fn() },
  renovationClaim: { findMany: vi.fn(), updateMany: vi.fn() },
  renovationClaimTransition: { createMany: vi.fn() },
  renovationProgress: { updateMany: vi.fn() },
};

beforeEach(() => {
  Object.values(txMock).forEach((m) => Object.values(m).forEach((fn: any) => fn.mockReset()));
});

describe("cascadeCancelClaimsOnSalesUnitTermination", () => {
  it("cancels all non-terminal SalesClaim rows for the unit and appends transitions", async () => {
    txMock.salesClaim.findMany.mockResolvedValue([
      { id: "c1", status: "submitted" }, { id: "c2", status: "approved" },
    ]);
    txMock.renovationClaim.findMany.mockResolvedValue([]);
    txMock.salesClaim.updateMany.mockResolvedValue({ count: 2 });
    txMock.salesClaimTransition.createMany.mockResolvedValue({ count: 2 });
    txMock.renovationProgress.updateMany.mockResolvedValue({ count: 0 });

    await cascadeCancelClaimsOnSalesUnitTermination(txMock as any, "u1", "Source-queue rejected", "user-1", "org-1");

    expect(txMock.salesClaim.updateMany).toHaveBeenCalledWith({
      where: { salesUnitId: "u1", status: { notIn: ["cancelled", "rejected", "paid"] } },
      data: { status: "cancelled", reviewerNote: "Source-queue rejected" },
    });
    expect(txMock.salesClaimTransition.createMany).toHaveBeenCalledOnce();
    const transitionsArg = txMock.salesClaimTransition.createMany.mock.calls[0][0];
    expect(transitionsArg.data).toHaveLength(2);
    expect(transitionsArg.data[0]).toMatchObject({
      organizationId: "org-1",
      claimId: "c1",
      fromStatus: "submitted",
      toStatus: "cancelled",
      changedById: "user-1",
      note: "Source-queue rejected",
    });
  });

  it("cancels all non-terminal RenovationClaim rows and archives RenovationProgress", async () => {
    txMock.salesClaim.findMany.mockResolvedValue([]);
    txMock.renovationClaim.findMany.mockResolvedValue([{ id: "rc1", status: "submitted" }]);
    txMock.salesClaim.updateMany.mockResolvedValue({ count: 0 });
    txMock.renovationClaim.updateMany.mockResolvedValue({ count: 1 });
    txMock.renovationClaimTransition.createMany.mockResolvedValue({ count: 1 });
    txMock.renovationProgress.updateMany.mockResolvedValue({ count: 1 });

    await cascadeCancelClaimsOnSalesUnitTermination(txMock as any, "u1", "Withdrawn by agent", "user-1", "org-1");

    expect(txMock.renovationClaim.updateMany).toHaveBeenCalledWith({
      where: { salesUnitId: "u1", status: { notIn: ["cancelled", "rejected", "paid"] } },
      data: { status: "cancelled", reviewerNote: "Withdrawn by agent" },
    });
    expect(txMock.renovationProgress.updateMany).toHaveBeenCalledWith({
      where: { salesUnitId: "u1", archivedAt: null },
      data: { archivedAt: expect.any(Date), archivedById: "user-1" },
    });
  });

  it("noop on empty unit (no claims, no progress)", async () => {
    txMock.salesClaim.findMany.mockResolvedValue([]);
    txMock.renovationClaim.findMany.mockResolvedValue([]);
    txMock.renovationProgress.updateMany.mockResolvedValue({ count: 0 });

    await cascadeCancelClaimsOnSalesUnitTermination(txMock as any, "u1", "noop", "user-1", "org-1");

    expect(txMock.salesClaim.updateMany).not.toHaveBeenCalled();
    expect(txMock.salesClaimTransition.createMany).not.toHaveBeenCalled();
    expect(txMock.renovationClaim.updateMany).not.toHaveBeenCalled();
    expect(txMock.renovationClaimTransition.createMany).not.toHaveBeenCalled();
    expect(txMock.renovationProgress.updateMany).toHaveBeenCalledOnce();
  });

  it("skips already-terminal claims", async () => {
    // findMany filters by `status notIn [cancelled, rejected, paid]` so terminal ones never appear
    txMock.salesClaim.findMany.mockResolvedValue([{ id: "c1", status: "submitted" }]);
    txMock.renovationClaim.findMany.mockResolvedValue([]);
    txMock.salesClaim.updateMany.mockResolvedValue({ count: 1 });
    txMock.salesClaimTransition.createMany.mockResolvedValue({ count: 1 });
    txMock.renovationProgress.updateMany.mockResolvedValue({ count: 0 });

    await cascadeCancelClaimsOnSalesUnitTermination(txMock as any, "u1", "reason", "user-1", "org-1");

    const findArg = txMock.salesClaim.findMany.mock.calls[0][0];
    expect(findArg.where.status.notIn).toEqual(["cancelled", "rejected", "paid"]);
  });
});
