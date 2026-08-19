import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

vi.mock("../owner-billing.service", () => ({
  getBillingReadinessService: vi.fn(),
}));

import { ownerBillingRoutes } from "../owner-billing.routes";
import { getBillingReadinessService } from "../owner-billing.service";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerBillingRoutes);
  return app;
}
const APT = "44444444-4444-4444-8444-444444444444";
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };

beforeAll(() => { process.env.ENABLE_PHASE2_OWNER_BILLING = "1"; });
afterAll(() => { delete process.env.ENABLE_PHASE2_OWNER_BILLING; });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBillingReadinessService).mockResolvedValue({
    ok: true, status: 200, data: { ownerAssigned: true, hasActiveConfig: false, ownerPartyId: "owner-1" },
  });
});

describe("GET /owner-billing/units/:apartmentId/billing-readiness", () => {
  it("returns the readiness signal for a manager", async () => {
    const res = await makeApp(managerSession).request(`/units/${APT}/billing-readiness`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ownerAssigned: true, hasActiveConfig: false, ownerPartyId: "owner-1" } });
    expect(getBillingReadinessService).toHaveBeenCalledWith(expect.objectContaining({ orgId: "o1" }), APT);
  });

  it("403s for an editor (manager-gated read)", async () => {
    const res = await makeApp(editorSession).request(`/units/${APT}/billing-readiness`);
    expect(res.status).toBe(403);
  });
});
