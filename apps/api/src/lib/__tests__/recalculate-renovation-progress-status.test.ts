import { describe, it, expect, beforeEach, vi } from "vitest";
import { recalculateRenovationProgressStatus } from "../recalculate-renovation-progress-status";

const txMock = {
  renovationStageProgress: { findMany: vi.fn() },
  renovationProgress: { update: vi.fn() },
};

beforeEach(() => {
  Object.values(txMock).forEach((m) => Object.values(m).forEach((fn: any) => fn.mockReset()));
});

describe("recalculateRenovationProgressStatus", () => {
  it("returns 'not_started' when all stages are pending", async () => {
    txMock.renovationStageProgress.findMany.mockResolvedValue([
      { status: "pending" }, { status: "pending" },
    ]);
    txMock.renovationProgress.update.mockResolvedValue({});
    const result = await recalculateRenovationProgressStatus(txMock as any, "p1");
    expect(result).toBe("not_started");
    expect(txMock.renovationProgress.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: expect.objectContaining({ status: "not_started" }),
    });
  });

  it("returns 'on_going' when at least one is in_progress and not all completed", async () => {
    txMock.renovationStageProgress.findMany.mockResolvedValue([
      { status: "completed" }, { status: "in_progress" }, { status: "pending" },
    ]);
    txMock.renovationProgress.update.mockResolvedValue({});
    expect(await recalculateRenovationProgressStatus(txMock as any, "p1")).toBe("on_going");
  });

  it("returns 'on_going' when at least one is completed and rest pending (no in_progress)", async () => {
    txMock.renovationStageProgress.findMany.mockResolvedValue([
      { status: "completed" }, { status: "pending" },
    ]);
    txMock.renovationProgress.update.mockResolvedValue({});
    expect(await recalculateRenovationProgressStatus(txMock as any, "p1")).toBe("on_going");
  });

  it("returns 'completed' when every stage is completed", async () => {
    txMock.renovationStageProgress.findMany.mockResolvedValue([
      { status: "completed" }, { status: "completed" },
    ]);
    txMock.renovationProgress.update.mockResolvedValue({});
    expect(await recalculateRenovationProgressStatus(txMock as any, "p1")).toBe("completed");
  });

  it("returns 'not_started' when there are zero stages (edge: all archived)", async () => {
    txMock.renovationStageProgress.findMany.mockResolvedValue([]);
    txMock.renovationProgress.update.mockResolvedValue({});
    expect(await recalculateRenovationProgressStatus(txMock as any, "p1")).toBe("not_started");
  });

  it("sets actualCompletion when status flips to completed", async () => {
    txMock.renovationStageProgress.findMany.mockResolvedValue([
      { status: "completed" }, { status: "completed" },
    ]);
    txMock.renovationProgress.update.mockResolvedValue({});
    await recalculateRenovationProgressStatus(txMock as any, "p1");
    const callArg = txMock.renovationProgress.update.mock.calls[0][0];
    expect(callArg.data.actualCompletion).toBeInstanceOf(Date);
  });

  it("clears actualCompletion when status reverts from completed", async () => {
    txMock.renovationStageProgress.findMany.mockResolvedValue([
      { status: "completed" }, { status: "in_progress" },
    ]);
    txMock.renovationProgress.update.mockResolvedValue({});
    await recalculateRenovationProgressStatus(txMock as any, "p1");
    const callArg = txMock.renovationProgress.update.mock.calls[0][0];
    expect(callArg.data.actualCompletion).toBeNull();
  });
});
