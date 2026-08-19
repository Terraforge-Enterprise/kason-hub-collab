import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { commissionsRoutes } from "../commissions.routes";

// Mock all service functions so DB is never reached.
vi.mock("../commissions.service", () => ({
  listTierMappingsService: vi.fn().mockResolvedValue({ data: [] }),
  createTierMappingService: vi.fn(),
  updateTierMappingService: vi.fn(),
  deleteTierMappingService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "tm1" } }),
  listClaimsService: vi.fn().mockResolvedValue({ data: { items: [], total: 0 } }),
  getClaimDetailService: vi.fn(),
  approveClaimService: vi.fn(),
  rejectClaimService: vi.fn(),
  payClaimService: vi.fn(),
  bulkApproveClaimsService: vi.fn(),
  undoApproveClaimService: vi.fn(),
  reApproveClaimService: vi.fn(),
  getPerformanceService: vi.fn().mockResolvedValue({ data: [] }),
  listRoomTypesService: vi.fn().mockResolvedValue({ data: [] }),
  createRoomTypeService: vi.fn(),
  updateRoomTypeService: vi.fn(),
  deleteRoomTypeService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "rt1" } }),
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", commissionsRoutes);
  return app;
}

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u4", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };
const viewerSession: SessionPayload = { userId: "u3", orgId: "o1", role: "viewer", userType: "operator" };

describe("commissionsRoutes tier-mappings auth", () => {
  it("admin operator can GET /tier-mappings (200)", async () => {
    const res = await makeApp(adminSession).request("/tier-mappings");
    expect(res.status).toBe(200);
  });

  it("editor operator gets 403 on GET /tier-mappings", async () => {
    const res = await makeApp(editorSession).request("/tier-mappings");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("viewer operator gets 403 on GET /tier-mappings", async () => {
    const res = await makeApp(viewerSession).request("/tier-mappings");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("admin operator can GET /claims (200 — not gated by tier-mappings middleware)", async () => {
    const res = await makeApp(adminSession).request("/claims");
    expect(res.status).toBe(200);
  });

  it("editor operator can GET /claims (200 — tier-mappings gate does not apply)", async () => {
    const res = await makeApp(editorSession).request("/claims");
    expect(res.status).toBe(200);
  });

  it("missing session gets 401 on GET /tier-mappings", async () => {
    const res = await makeApp(null).request("/tier-mappings");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  // ── DELETE auth (CR-7): Super Admin only ───────────────────────────────
  // Meeting spec §3.1 + decision 7: only AdminRole="admin" may delete. The
  // group guard lets managers read/write other methods; the per-route
  // `requireRole("admin")` narrows DELETE to admins.

  it("manager operator gets 403 on DELETE /tier-mappings/:id", async () => {
    const res = await makeApp(managerSession).request("/tier-mappings/tm1", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("admin operator can DELETE /tier-mappings/:id (200)", async () => {
    const res = await makeApp(adminSession).request("/tier-mappings/tm1", { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("manager operator gets 403 on DELETE /room-types/:id", async () => {
    const res = await makeApp(managerSession).request("/room-types/rt1", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("admin operator can DELETE /room-types/:id (200)", async () => {
    const res = await makeApp(adminSession).request("/room-types/rt1", { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("editor operator gets 403 on DELETE /tier-mappings/:id (group guard rejects first)", async () => {
    const res = await makeApp(editorSession).request("/tier-mappings/tm1", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("editor operator gets 403 on DELETE /room-types/:id (group guard rejects first)", async () => {
    const res = await makeApp(editorSession).request("/room-types/rt1", { method: "DELETE" });
    expect(res.status).toBe(403);
  });
});
