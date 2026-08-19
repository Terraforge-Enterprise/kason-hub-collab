/**
 * Shape-verification tests: routes that validate a request body must return
 * { error, fieldErrors } (never the old `details` key) when Zod rejects it.
 * Part of T11 — formatZodError sweep.
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
  getPerformanceService: vi.fn().mockResolvedValue({ data: [] }),
  listRoomTypesService: vi.fn().mockResolvedValue({ data: [] }),
  createRoomTypeService: vi.fn(),
  updateRoomTypeService: vi.fn(),
  deleteRoomTypeService: vi.fn(),
  getRoomTypeUsageService: vi.fn(),
}));

// settings + deal-audit sub-routers
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

const adminSession: SessionPayload = {
  userId: "u1",
  orgId: "o1",
  role: "admin",
  userType: "operator",
};

describe("commissionsRoutes — Zod error response shape", () => {
  it("POST /tier-mappings with empty body returns { error, fieldErrors } not { details }", async () => {
    const app = makeApp(adminSession);
    const res = await app.request("/tier-mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("fieldErrors");
    expect(body).not.toHaveProperty("details");
  });

  it("PUT /tier-mappings/:id with empty body returns { error, fieldErrors } not { details }", async () => {
    const app = makeApp(adminSession);
    const res = await app.request("/tier-mappings/tm-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("fieldErrors");
    expect(body).not.toHaveProperty("details");
  });

  it("POST /room-types with empty body returns { error, fieldErrors } not { details }", async () => {
    const app = makeApp(adminSession);
    const res = await app.request("/room-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("fieldErrors");
    expect(body).not.toHaveProperty("details");
  });
});
