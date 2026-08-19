import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../../lib/auth";

// vi.mock factories are hoisted — use vi.hoisted for the mocks so the factory
// has access to them at hoist time.
const {
  listAmenitiesServiceMock,
  createAmenityServiceMock,
  updateAmenityServiceMock,
  deleteAmenityServiceMock,
  getAmenityUsageServiceMock,
} = vi.hoisted(() => ({
  listAmenitiesServiceMock: vi.fn(),
  createAmenityServiceMock: vi.fn(),
  updateAmenityServiceMock: vi.fn(),
  deleteAmenityServiceMock: vi.fn(),
  getAmenityUsageServiceMock: vi.fn(),
}));

vi.mock("../amenities.service", () => ({
  listAmenitiesService: listAmenitiesServiceMock,
  createAmenityService: createAmenityServiceMock,
  updateAmenityService: updateAmenityServiceMock,
  deleteAmenityService: deleteAmenityServiceMock,
  getAmenityUsageService: getAmenityUsageServiceMock,
  // Service module also exports this — must be present so the module shape
  // matches; the routes file does not import it.
  assertAmenitiesBelongToOrgService: vi.fn(),
}));

import { amenitiesRoutes } from "../amenities.routes";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", amenitiesRoutes);
  return app;
}

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };
const viewerSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "operator" };
const agentSession: SessionPayload = { userId: "u5", orgId: "o1", role: "admin", userType: "agent" };

describe("amenities routes — RBAC", () => {
  it("missing session → 401 Unauthorized", async () => {
    const res = await makeApp(null).request("/");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("editor operator can GET (200)", async () => {
    listAmenitiesServiceMock.mockResolvedValue([]);
    const res = await makeApp(editorSession).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("viewer operator gets 403 (below editor gate)", async () => {
    const res = await makeApp(viewerSession).request("/");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("agent userType gets 403 (operator-only gate)", async () => {
    const res = await makeApp(agentSession).request("/");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("editor operator gets 403 on POST (manager+ gate)", async () => {
    const res = await makeApp(editorSession).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Pool" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("manager operator can POST (201)", async () => {
    createAmenityServiceMock.mockResolvedValue({
      ok: true,
      data: { id: "a1", organizationId: "o1", name: "Pool", isActive: true, sortOrder: 0 },
    });
    const res = await makeApp(managerSession).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Pool" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.name).toBe("Pool");
    expect(createAmenityServiceMock).toHaveBeenCalledWith("o1", { name: "Pool" });
  });

  it("admin operator can DELETE (200)", async () => {
    deleteAmenityServiceMock.mockResolvedValue({ ok: true, data: { affectedUnitCount: 3 } });
    const res = await makeApp(adminSession).request("/a1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.affectedUnitCount).toBe(3);
    expect(deleteAmenityServiceMock).toHaveBeenCalledWith("o1", "a1");
  });
});

describe("amenities routes — happy paths", () => {
  it("GET / forwards activeOnly=true query to service", async () => {
    listAmenitiesServiceMock.mockClear();
    listAmenitiesServiceMock.mockResolvedValue([]);
    await makeApp(editorSession).request("/?activeOnly=true");
    expect(listAmenitiesServiceMock).toHaveBeenCalledWith("o1", { activeOnly: true });
  });

  it("GET /:id/usage returns usage payload", async () => {
    getAmenityUsageServiceMock.mockResolvedValue({
      ok: true,
      data: { count: 2, units: [{ id: "u1", unitCode: "A-1", propertyName: "Tower" }] },
    });
    const res = await makeApp(editorSession).request("/a1/usage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.count).toBe(2);
    expect(body.data.units).toHaveLength(1);
    expect(getAmenityUsageServiceMock).toHaveBeenCalledWith("o1", "a1");
  });

  it("POST / with invalid body returns 400", async () => {
    const res = await makeApp(managerSession).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_payload");
  });

  it("POST / with name conflict returns 409 amenity_name_conflict", async () => {
    createAmenityServiceMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: { code: "amenity_name_conflict", message: "An amenity with this name already exists." },
    });
    const res = await makeApp(managerSession).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Pool" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("amenity_name_conflict");
  });
});
