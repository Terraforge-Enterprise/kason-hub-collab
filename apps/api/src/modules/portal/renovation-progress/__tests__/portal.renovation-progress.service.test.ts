import { describe, it, expect, beforeEach, vi } from "vitest";

const txMock = {
  renovationProgress: { findFirst: vi.fn(), update: vi.fn() },
  renovationStageProgress: { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  salesUnit: { findFirst: vi.fn() },
};

vi.mock("@kason/db", () => ({
  getDb: () => ({
    $transaction: (fn: (tx: any) => Promise<any>) => fn(txMock),
  }),
}));

const recalcMock = vi.fn();
vi.mock("../../../../lib/recalculate-renovation-progress-status", () => ({
  recalculateRenovationProgressStatus: (...args: any[]) => recalcMock(...args),
}));

import { flipStageStatusService, markRenovationCompleteService } from "../portal.renovation-progress.service";

const baseCtx = { orgId: "org-1", agentPartyId: "agent-1", actorUserId: "user-1" };

beforeEach(() => {
  Object.values(txMock).forEach((m: any) => Object.values(m).forEach((fn: any) => fn.mockReset()));
  recalcMock.mockReset().mockResolvedValue("on_going");
});

describe("flipStageStatusService", () => {
  it("404s if RenovationProgress not in org", async () => {
    txMock.renovationProgress.findFirst.mockResolvedValue(null);
    const result = await flipStageStatusService("rp-1", "sp-1", { status: "in_progress" }, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("progress_not_found");
  });

  it("404s if SalesUnit not owned by agent", async () => {
    txMock.renovationProgress.findFirst.mockResolvedValue({ id: "rp-1", salesUnitId: "u1", organizationId: "org-1" });
    txMock.salesUnit.findFirst.mockResolvedValue(null);
    const result = await flipStageStatusService("rp-1", "sp-1", { status: "in_progress" }, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unit_not_owned");
  });

  it("flips pending -> in_progress and sets startedAt", async () => {
    txMock.renovationProgress.findFirst.mockResolvedValue({ id: "rp-1", salesUnitId: "u1", organizationId: "org-1" });
    txMock.salesUnit.findFirst.mockResolvedValue({ id: "u1", agentPartyId: "agent-1" });
    txMock.renovationStageProgress.findFirst.mockResolvedValue({ id: "sp-1", progressId: "rp-1", status: "pending", startedAt: null, completedAt: null });
    txMock.renovationStageProgress.update.mockResolvedValue({ id: "sp-1", status: "in_progress" });

    const result = await flipStageStatusService("rp-1", "sp-1", { status: "in_progress" }, baseCtx);
    expect(result.ok).toBe(true);
    expect(txMock.renovationStageProgress.update).toHaveBeenCalledWith({
      where: { id: "sp-1" },
      data: expect.objectContaining({ status: "in_progress", startedAt: expect.any(Date), completedAt: null }),
    });
    expect(recalcMock).toHaveBeenCalledWith(expect.anything(), "rp-1");
  });

  it("flips in_progress -> completed and sets completedAt", async () => {
    txMock.renovationProgress.findFirst.mockResolvedValue({ id: "rp-1", salesUnitId: "u1", organizationId: "org-1" });
    txMock.salesUnit.findFirst.mockResolvedValue({ id: "u1", agentPartyId: "agent-1" });
    txMock.renovationStageProgress.findFirst.mockResolvedValue({ id: "sp-1", progressId: "rp-1", status: "in_progress", startedAt: new Date(), completedAt: null });
    txMock.renovationStageProgress.update.mockResolvedValue({ id: "sp-1", status: "completed" });

    await flipStageStatusService("rp-1", "sp-1", { status: "completed" }, baseCtx);
    expect(txMock.renovationStageProgress.update).toHaveBeenCalledWith({
      where: { id: "sp-1" },
      data: expect.objectContaining({ status: "completed", completedAt: expect.any(Date) }),
    });
  });

  it("flips completed -> in_progress and clears completedAt", async () => {
    txMock.renovationProgress.findFirst.mockResolvedValue({ id: "rp-1", salesUnitId: "u1", organizationId: "org-1" });
    txMock.salesUnit.findFirst.mockResolvedValue({ id: "u1", agentPartyId: "agent-1" });
    txMock.renovationStageProgress.findFirst.mockResolvedValue({ id: "sp-1", progressId: "rp-1", status: "completed", startedAt: new Date(), completedAt: new Date() });
    txMock.renovationStageProgress.update.mockResolvedValue({ id: "sp-1", status: "in_progress" });

    await flipStageStatusService("rp-1", "sp-1", { status: "in_progress" }, baseCtx);
    expect(txMock.renovationStageProgress.update).toHaveBeenCalledWith({
      where: { id: "sp-1" },
      data: expect.objectContaining({ status: "in_progress", completedAt: null }),
    });
  });

  it("flips in_progress -> pending and clears startedAt", async () => {
    txMock.renovationProgress.findFirst.mockResolvedValue({ id: "rp-1", salesUnitId: "u1", organizationId: "org-1" });
    txMock.salesUnit.findFirst.mockResolvedValue({ id: "u1", agentPartyId: "agent-1" });
    txMock.renovationStageProgress.findFirst.mockResolvedValue({ id: "sp-1", progressId: "rp-1", status: "in_progress", startedAt: new Date(), completedAt: null });
    txMock.renovationStageProgress.update.mockResolvedValue({ id: "sp-1", status: "pending" });

    await flipStageStatusService("rp-1", "sp-1", { status: "pending" }, baseCtx);
    expect(txMock.renovationStageProgress.update).toHaveBeenCalledWith({
      where: { id: "sp-1" },
      data: expect.objectContaining({ status: "pending", startedAt: null, completedAt: null }),
    });
  });
});

describe("markRenovationCompleteService", () => {
  it("404s if RenovationProgress not in org", async () => {
    txMock.renovationProgress.findFirst.mockResolvedValue(null);
    const result = await markRenovationCompleteService("rp-1", baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("progress_not_found");
  });

  it("404s if SalesUnit not owned", async () => {
    txMock.renovationProgress.findFirst.mockResolvedValue({ id: "rp-1", salesUnitId: "u1", organizationId: "org-1" });
    txMock.salesUnit.findFirst.mockResolvedValue(null);
    const result = await markRenovationCompleteService("rp-1", baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unit_not_owned");
  });

  it("400s with stages_incomplete if any stage isn't completed", async () => {
    txMock.renovationProgress.findFirst.mockResolvedValue({ id: "rp-1", salesUnitId: "u1", organizationId: "org-1" });
    txMock.salesUnit.findFirst.mockResolvedValue({ id: "u1", agentPartyId: "agent-1" });
    txMock.renovationStageProgress.findMany.mockResolvedValue([
      { status: "completed" }, { status: "in_progress" },
    ]);
    const result = await markRenovationCompleteService("rp-1", baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("stages_incomplete");
  });

  it("succeeds when all stages completed; sets actualCompletion", async () => {
    txMock.renovationProgress.findFirst.mockResolvedValue({ id: "rp-1", salesUnitId: "u1", organizationId: "org-1" });
    txMock.salesUnit.findFirst.mockResolvedValue({ id: "u1", agentPartyId: "agent-1" });
    txMock.renovationStageProgress.findMany.mockResolvedValue([
      { status: "completed" }, { status: "completed" },
    ]);
    txMock.renovationProgress.update.mockResolvedValue({ id: "rp-1", status: "completed" });
    const result = await markRenovationCompleteService("rp-1", baseCtx);
    expect(result.ok).toBe(true);
    expect(txMock.renovationProgress.update).toHaveBeenCalledWith({
      where: { id: "rp-1" },
      data: expect.objectContaining({ status: "completed", actualCompletion: expect.any(Date) }),
    });
  });
});
