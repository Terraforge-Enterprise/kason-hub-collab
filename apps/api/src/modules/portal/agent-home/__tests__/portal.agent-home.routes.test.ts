import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { PortalEnv } from "../../auth/portal.auth.types";
import { createPortalAgentHomeRoutes } from "../portal.agent-home.routes";

// Simulate session-set context middleware so the route handler sees an agent.
function appWithAgent(deps: any) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    c.set("session", { userId: "u1", userType: "agent", partyId: "p1", orgId: "o1", role: "editor", iat: 0, absoluteExp: 9999999999 });
    await next();
  });
  // Route is created via factory so we can inject deps in tests
  app.route("/agent-home", createPortalAgentHomeRoutes(deps));
  return app;
}

describe("GET /agent-home/summary", () => {
  beforeEach(() => vi.useRealTimers());

  it("returns AgentHomeSummary for an agent session", async () => {
    const deps = {
      listSalesUnits: vi.fn().mockResolvedValue({ items: [] }),
      listSalesClaims: vi.fn().mockResolvedValue({ items: [] }),
      listRenovationClaims: vi.fn().mockResolvedValue({ items: [] }),
      commissionsDashboard: vi.fn().mockResolvedValue({
        summary: { totalEarned: 0, thisMonthEarned: 0, thisYearEarned: 0, submitted: 0 },
      }),
      now: () => new Date("2026-04-30T00:00:00Z"),
    };
    const app = appWithAgent(deps);
    const res = await app.request("/agent-home/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.errors).toEqual([]);
    expect(body.data.pendingActions).toEqual([]);
    expect(body.data.commission.earnedThisMonth).toBe(0);
  });

  it("returns 200 with errors[] when a downstream throws", async () => {
    const deps = {
      listSalesUnits: vi.fn().mockRejectedValue(new Error("nope")),
      listSalesClaims: vi.fn().mockResolvedValue({ items: [] }),
      listRenovationClaims: vi.fn().mockResolvedValue({ items: [] }),
      commissionsDashboard: vi.fn().mockResolvedValue({
        summary: { totalEarned: 0, thisMonthEarned: 0, thisYearEarned: 0, submitted: 0 },
      }),
      now: () => new Date("2026-04-30T00:00:00Z"),
    };
    const app = appWithAgent(deps);
    const res = await app.request("/agent-home/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.errors).toContain("pipeline");
    expect(body.data.pipeline).toBeNull();
  });
});
