import { describe, it, expect, vi } from "vitest";
import { buildAgentHomeSummary } from "../portal.agent-home.service";

const session = { userId: "u1", userType: "agent", partyId: "p1", orgId: "o1" } as const;

describe("buildAgentHomeSummary", () => {
  it("composes all four domain slices and returns no errors when every dep succeeds", async () => {
    const deps = {
      listSalesUnits: vi.fn().mockResolvedValue({
        items: [
          { id: "u1", status: "needs_amendment", updatedAt: "2026-04-29T10:00:00Z", unitNumber: "A-1" },
          { id: "u2", status: "approved",        updatedAt: "2026-04-25T10:00:00Z", unitNumber: "A-2" },
        ],
      }),
      listSalesClaims: vi.fn().mockResolvedValue({
        items: [
          { id: "sc1", status: "approved",          totalAmount: 1500, approvedAt: "2026-04-15T00:00:00Z", updatedAt: "2026-04-15T00:00:00Z", title: "SC-001" },
          { id: "sc2", status: "needs_amendment",   totalAmount: 0,    approvedAt: null,                 updatedAt: "2026-04-28T00:00:00Z", title: "SC-002" },
        ],
      }),
      listRenovationClaims: vi.fn().mockResolvedValue({
        items: [
          { id: "rc1", status: "approved",        totalAmount: 800, approvedAt: "2026-04-10T00:00:00Z", updatedAt: "2026-04-10T00:00:00Z", title: "RC-001" },
        ],
      }),
      commissionsDashboard: vi.fn().mockResolvedValue({
        summary: { totalEarned: 9999, thisMonthEarned: 1234, thisYearEarned: 4444, submitted: 567 },
      }),
      now: () => new Date("2026-04-30T00:00:00Z"),
    };

    const summary = await buildAgentHomeSummary(session, deps);

    expect(summary.errors).toEqual([]);
    expect(summary.pipeline?.counts.needs_amendment).toBe(1);
    expect(summary.pipeline?.counts.approved).toBe(1);
    expect(summary.salesClaims?.approvedThisMonth).toBe(1500);
    expect(summary.renovationClaims?.approvedThisMonth).toBe(800);
    expect(summary.commission?.earnedThisMonth).toBe(1234);
    expect(summary.commission?.submittedPending).toBe(567);
    expect(summary.pendingActions.map((r) => r.id).sort()).toEqual(["sc2", "u1"]);
    expect(summary.recentActivity[0].id).toBe("u1"); // 2026-04-29 latest, pipeline included
  });

  it("returns partial payload + errors when one dep throws", async () => {
    const deps = {
      listSalesUnits: vi.fn().mockRejectedValue(new Error("db boom")),
      listSalesClaims: vi.fn().mockResolvedValue({ items: [] }),
      listRenovationClaims: vi.fn().mockResolvedValue({ items: [] }),
      commissionsDashboard: vi.fn().mockResolvedValue({
        summary: { totalEarned: 0, thisMonthEarned: 0, thisYearEarned: 0, submitted: 0 },
      }),
      now: () => new Date("2026-04-30T00:00:00Z"),
    };

    const summary = await buildAgentHomeSummary(session, deps);
    expect(summary.errors).toContain("pipeline");
    expect(summary.pipeline).toBeNull();
    expect(summary.salesClaims).not.toBeNull();
    expect(summary.commission).not.toBeNull();
  });

  it("caps recentActivity at 10 and pending actions sorted by updatedAt desc", async () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      id: `u${i}`,
      status: "approved" as const,
      updatedAt: new Date(2026, 3, i + 1).toISOString(),
      unitNumber: `${i}`,
    }));
    const deps = {
      listSalesUnits: vi.fn().mockResolvedValue({ items }),
      listSalesClaims: vi.fn().mockResolvedValue({ items: [] }),
      listRenovationClaims: vi.fn().mockResolvedValue({ items: [] }),
      commissionsDashboard: vi.fn().mockResolvedValue({
        summary: { totalEarned: 0, thisMonthEarned: 0, thisYearEarned: 0, submitted: 0 },
      }),
      now: () => new Date("2026-04-30T00:00:00Z"),
    };
    const summary = await buildAgentHomeSummary(session, deps);
    expect(summary.recentActivity.length).toBeLessThanOrEqual(10);
    const dates = summary.recentActivity.map((r) => r.updatedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});
