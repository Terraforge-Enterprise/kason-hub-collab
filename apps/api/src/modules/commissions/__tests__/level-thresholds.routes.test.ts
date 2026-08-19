import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../level-thresholds.service", () => ({
  listLevelThresholdsService: vi.fn(async () => ({ ok: true, status: 200, data: [] })),
  updateLevelThresholdService: vi.fn(async () => ({ ok: true, status: 200, data: { id: "t", updatedAt: new Date(), bumpedAgentCount: 0 } })),
  previewLevelThresholdService: vi.fn(async () => ({ ok: true, status: 200, data: { bumpedAgentCount: 0 } })),
}));

import levelThresholdsRoutes from "../level-thresholds.routes";

// Minimal app that stamps a session on every request.
type TestSession = { orgId: string; userId: string; role: string; userType: string };
function makeApp(role: "admin" | "manager" | "viewer" | "editor", userType: "operator" | "agent" = "operator") {
  const app = new Hono<{ Variables: { session: TestSession } }>();
  app.use("*", async (c, next) => {
    c.set("session", { orgId: "o1", userId: "u1", role, userType });
    await next();
  });
  app.route("/", levelThresholdsRoutes);
  return app;
}

describe("level-thresholds routes — auth", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["viewer", "editor"] as const)("blocks role=%s with 403", async (role) => {
    const app = makeApp(role);
    const res = await app.request("/");
    expect(res.status).toBe(403);
  });

  it("blocks non-operator userType with 403", async () => {
    const app = makeApp("admin", "agent");
    const res = await app.request("/");
    expect(res.status).toBe(403);
  });

  it("allows admin to GET", async () => {
    const app = makeApp("admin");
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  it("allows manager to PUT", async () => {
    const app = makeApp("manager");
    const res = await app.request("/pre_leader", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minCumulativeCommission: "8000", updatedAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 on malformed PUT payload", async () => {
    const app = makeApp("admin");
    const res = await app.request("/pre_leader", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minCumulativeCommission: "not-a-number" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when :agentLevel param is unknown", async () => {
    const app = makeApp("admin");
    const res = await app.request("/superleader", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minCumulativeCommission: "8000", updatedAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(400);
  });
});
