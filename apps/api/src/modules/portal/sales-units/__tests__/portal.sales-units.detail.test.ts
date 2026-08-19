import { describe, it, expect, beforeEach, vi } from "vitest";

const dbMock = {
  salesUnit: { findFirst: vi.fn() },
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
}));

import { getPortalSalesUnitDetailService } from "../portal.sales-units.service";

const ORG = "org-1";
const AGENT = "agent-1";
const OTHER = "agent-2";
const UNIT = "unit-1";

beforeEach(() => {
  dbMock.salesUnit.findFirst.mockReset();
});

describe("getPortalSalesUnitDetailService", () => {
  it("returns the rich shape with renovationProgress.stages sorted by sortOrder when progress exists", async () => {
    dbMock.salesUnit.findFirst.mockResolvedValue({
      id: UNIT,
      unitNumber: "A-08-02",
      salesDate: new Date("2026-04-01T00:00:00.000Z"),
      purpose: "rent",
      bedrooms: 2,
      bathrooms: 1,
      sourcingApproved: true,
      project: { id: "proj-1", name: "Aurora" },
      ownerParty: { id: "owner-1", displayName: "Tom Owner" },
      renovationProgress: {
        id: "rp-1",
        status: "on_going",
        startDate: new Date("2026-04-02T00:00:00.000Z"),
        expectedCompletion: new Date("2026-06-02T00:00:00.000Z"),
        actualCompletion: null,
        stageProgress: [
          // Intentionally out of order to verify the service sorts.
          {
            id: "sp-2",
            status: "in_progress",
            startedAt: new Date(),
            completedAt: null,
            stage: { id: "s-2", key: "demolition", label: "Demolition", sortOrder: 2 },
          },
          {
            id: "sp-1",
            status: "completed",
            startedAt: new Date(),
            completedAt: new Date(),
            stage: { id: "s-1", key: "design", label: "Design", sortOrder: 1 },
          },
        ],
      },
    });

    const result = await getPortalSalesUnitDetailService(
      { orgId: ORG, agentPartyId: AGENT },
      UNIT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(dbMock.salesUnit.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: UNIT, organizationId: ORG, agentPartyId: AGENT }),
      }),
    );
    expect(result.data.id).toBe(UNIT);
    expect(result.data.project).toEqual({ id: "proj-1", name: "Aurora" });
    expect(result.data.ownerParty).toEqual({ id: "owner-1", displayName: "Tom Owner" });
    expect(result.data.salesDate).toBe("2026-04-01T00:00:00.000Z");
    expect(result.data.renovationProgress).not.toBeNull();
    const rp = result.data.renovationProgress!;
    expect(rp.id).toBe("rp-1");
    expect(rp.status).toBe("on_going");
    expect(rp.startDate).toBe("2026-04-02T00:00:00.000Z");
    expect(rp.expectedCompletion).toBe("2026-06-02T00:00:00.000Z");
    expect(rp.actualCompletion).toBeNull();
    // Sort by sortOrder asc.
    expect(rp.stages.map((s) => s.sortOrder)).toEqual([1, 2]);
    expect(rp.stages[0]).toEqual({
      stageProgressId: "sp-1",
      stageKey: "design",
      stageLabel: "Design",
      sortOrder: 1,
      status: "completed",
    });
  });

  it("returns 404 when unit doesn't exist", async () => {
    dbMock.salesUnit.findFirst.mockResolvedValue(null);
    const result = await getPortalSalesUnitDetailService(
      { orgId: ORG, agentPartyId: AGENT },
      UNIT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });

  it("returns 404 when caller is a different agent (where filter rules out)", async () => {
    // Caller is OTHER but findFirst will not return the row because the
    // where clause filters by agentPartyId — simulate that.
    dbMock.salesUnit.findFirst.mockResolvedValue(null);
    const result = await getPortalSalesUnitDetailService(
      { orgId: ORG, agentPartyId: OTHER },
      UNIT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(dbMock.salesUnit.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ agentPartyId: OTHER }),
      }),
    );
  });

  it("returns renovationProgress: null when unit has no progress row", async () => {
    dbMock.salesUnit.findFirst.mockResolvedValue({
      id: UNIT,
      unitNumber: "A-08-02",
      salesDate: new Date("2026-04-01T00:00:00.000Z"),
      purpose: "own_stay",
      bedrooms: 2,
      bathrooms: 1,
      sourcingApproved: true,
      project: { id: "proj-1", name: "Aurora" },
      ownerParty: { id: "owner-1", displayName: "Tom Owner" },
      renovationProgress: null,
    });

    const result = await getPortalSalesUnitDetailService(
      { orgId: ORG, agentPartyId: AGENT },
      UNIT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.renovationProgress).toBeNull();
  });
});
