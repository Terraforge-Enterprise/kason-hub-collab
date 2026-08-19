import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { commissionsRoutes } from "../commissions.routes";

// Mock all service functions so the DB is never reached.
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
  getRoomTypeUsageService: vi.fn(),
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

const managerSession: SessionPayload = { userId: "u1", orgId: "o1", role: "manager", userType: "operator" };
const adminSession: SessionPayload = { userId: "u2", orgId: "o1", role: "admin", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };

describe("GET /room-types/:id/usage", () => {
  it("returns activeUnitCount=0 when no Units reference the type (manager)", async () => {
    const { getRoomTypeUsageService } = await import("../commissions.service");
    (getRoomTypeUsageService as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { activeUnitCount: 0 },
    });
    const res = await makeApp(managerSession).request("/room-types/rt-unused/usage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeUnitCount).toBe(0);
  });

  it("counts active Units referencing the type by name (excludes archived)", async () => {
    const { getRoomTypeUsageService } = await import("../commissions.service");
    (getRoomTypeUsageService as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { activeUnitCount: 2 },
    });
    const res = await makeApp(managerSession).request("/room-types/rt-master/usage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeUnitCount).toBe(2);
  });

  it("returns 404 for unknown id", async () => {
    const { getRoomTypeUsageService } = await import("../commissions.service");
    (getRoomTypeUsageService as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Room type not found",
    });
    const res = await makeApp(managerSession).request("/room-types/00000000-0000-0000-0000-000000000000/usage");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Room type not found");
  });

  it("admin can access /room-types/:id/usage (200)", async () => {
    const { getRoomTypeUsageService } = await import("../commissions.service");
    (getRoomTypeUsageService as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { activeUnitCount: 5 },
    });
    const res = await makeApp(adminSession).request("/room-types/rt-abc/usage");
    expect(res.status).toBe(200);
  });

  it("editor gets 403 on GET /room-types/:id/usage (group guard)", async () => {
    const res = await makeApp(editorSession).request("/room-types/rt-abc/usage");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });
});

describe("DELETE /room-types/:id — in-use guard", () => {
  it("returns 409 with code=ROOMTYPE_IN_USE when active Units reference it", async () => {
    const { deleteRoomTypeService } = await import("../commissions.service");
    (deleteRoomTypeService as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: {
        code: "ROOMTYPE_IN_USE",
        activeUnitCount: 1,
        suggestion: "Deactivate (set isActive=false) instead.",
      },
    });
    const res = await makeApp(adminSession).request("/room-types/rt-in-use", { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ROOMTYPE_IN_USE");
    expect(body.activeUnitCount).toBe(1);
  });

  it("deletes the row when activeUnitCount is 0 (returns 200)", async () => {
    const { deleteRoomTypeService } = await import("../commissions.service");
    (deleteRoomTypeService as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { id: "rt-unused" },
    });
    const res = await makeApp(adminSession).request("/room-types/rt-unused", { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("manager gets 403 on DELETE /room-types/:id (admin-only route)", async () => {
    const res = await makeApp(managerSession).request("/room-types/rt-any", { method: "DELETE" });
    expect(res.status).toBe(403);
  });
});
