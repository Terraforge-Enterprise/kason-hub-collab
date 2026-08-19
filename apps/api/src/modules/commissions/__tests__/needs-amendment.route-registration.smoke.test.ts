/**
 * Live smoke test: prove that POST /claims/:id/needs-amendment is
 * actually registered on commissionsRoutes. Mirrors the pattern in
 * commissions.routes.zod-shape.test.ts so we can probe the live router
 * with Hono's testClient-style app.request and assert it doesn't 404
 * with Hono's "route not found" response.
 *
 * Purpose: when the user reports a 404, this test distinguishes between
 *   (a) route not registered (bug in our code)
 *   (b) route registered but dev server is serving stale compiled code
 *       (their problem to restart `tsx watch`)
 *
 * If this test PASSES, the route is real and the user's dev server is stale.
 * If this test FAILS, we have a code bug we need to fix.
 */

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { commissionsRoutes } from "../commissions.routes";

vi.mock("../commissions.service", () => ({
  listTierMappingsService: vi.fn().mockResolvedValue({ data: [] }),
  createTierMappingService: vi.fn(),
  updateTierMappingService: vi.fn(),
  deleteTierMappingService: vi.fn(),
  listClaimsService: vi.fn().mockResolvedValue({ data: { items: [], total: 0 } }),
  getClaimDetailService: vi.fn(),
  approveClaimService: vi.fn(),
  rejectClaimService: vi.fn(),
  payClaimService: vi.fn(),
  bulkApproveClaimsService: vi.fn(),
  undoApproveClaimService: vi.fn(),
  reApproveClaimService: vi.fn(),
  setClaimNeedsAmendmentService: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    data: { id: "c1", status: "needs_amendment" },
  }),
  getPerformanceService: vi.fn().mockResolvedValue({ data: [] }),
  listRoomTypesService: vi.fn().mockResolvedValue({ data: [] }),
  createRoomTypeService: vi.fn(),
  updateRoomTypeService: vi.fn(),
  deleteRoomTypeService: vi.fn(),
  getRoomTypeUsageService: vi.fn(),
}));

vi.mock("../settings.routes", async () => ({ default: new (await import("hono")).Hono() }));
vi.mock("../deal-audit.routes", async () => ({ default: new (await import("hono")).Hono() }));

function makeApp(session: SessionPayload) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", commissionsRoutes);
  return app;
}

const managerSession: SessionPayload = {
  userId: "u1",
  orgId: "o1",
  role: "manager",
  userType: "operator",
};

describe("needs-amendment route registration smoke", () => {
  it("POST /claims/:id/needs-amendment is registered and reachable (not 404)", async () => {
    const app = makeApp(managerSession);
    const res = await app.request("/claims/e74200b7-9bc5-4e8c-ab89-5c735452f797/needs-amendment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "smoke" }),
    });
    // The KEY assertion: NOT 404. The route must be reachable.
    expect(res.status).not.toBe(404);
    // Sanity: with the mock returning ok:true, expect 200.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: "c1", status: "needs_amendment" });
  });

  it("rejects empty note with 400 (zod gate is wired in)", async () => {
    const app = makeApp(managerSession);
    const res = await app.request("/claims/c1/needs-amendment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("editor role is rejected by requireRole middleware (NOT 404 from route-not-found)", async () => {
    const editorSession: SessionPayload = { ...managerSession, role: "editor" };
    const app = makeApp(editorSession);
    const res = await app.request("/claims/c1/needs-amendment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "x" }),
    });
    // Should be 403 from requireRole, not 404 from route missing.
    expect(res.status).toBe(403);
  });
});
