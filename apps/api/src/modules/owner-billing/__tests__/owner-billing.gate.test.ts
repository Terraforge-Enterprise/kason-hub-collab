import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// The flag/role gate runs BEFORE any service call, so the gate cases that pass
// the gate (manager GET) must still avoid the real DB. Mock the service.
vi.mock("../owner-billing.service", () => ({
  createFeeConfigService: vi.fn(),
  listFeeConfigsService: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { items: [], limit: 50, offset: 0 } }),
  getFeeConfigService: vi.fn(),
}));

import { ownerBillingRoutes } from "../owner-billing.routes";

// Mirrors the tasks route-test harness: build a throwaway Hono app, inject a
// session via a pre-middleware, then mount the real owner-billing router. The
// flag gate is the router's first middleware, so flag-off must 404 BEFORE any
// auth/role check can run.
function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerBillingRoutes);
  return app;
}

const managerSession: SessionPayload = {
  userId: "u1",
  orgId: "o1",
  role: "manager",
  userType: "operator",
};

afterEach(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

describe("owner-billing flag gate", () => {
  it("returns canonical 404 while ENABLE_PHASE2_OWNER_BILLING is dark, even for a manager", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    const res = await makeApp(managerSession).request("/fee-configs");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("404s when the flag is explicitly falsey", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "0";
    const res = await makeApp(managerSession).request("/fee-configs");
    expect(res.status).toBe(404);
  });

  it("lets a manager through to GET /fee-configs (200, empty list) when the flag is on", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(managerSession).request("/fee-configs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { items: [], limit: 50, offset: 0 } });
  });

  it("401s for a missing session even when the flag is on (gate passes, role gate rejects)", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(null).request("/fee-configs");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("403s for a portal (owner) session even when the flag is on (operator-only)", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const ownerSession: SessionPayload = {
      userId: "u2",
      orgId: "o1",
      role: "viewer",
      userType: "owner",
    };
    const res = await makeApp(ownerSession).request("/fee-configs");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("403s for an editor session — config READ requires manager", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const editorSession: SessionPayload = {
      userId: "u3",
      orgId: "o1",
      role: "editor",
      userType: "operator",
    };
    const res = await makeApp(editorSession).request("/fee-configs");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });
});
