import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../../lib/auth";
import { propertyTypesRoutes } from "../property-types.routes";
import {
  createPropertyTypeService,
  deletePropertyTypeService,
  getPropertyTypeUsageService,
  listPropertyTypesService,
  updatePropertyTypeService,
} from "../property-types.service";

vi.mock("../property-types.service", () => ({
  listPropertyTypesService: vi.fn().mockResolvedValue([]),
  createPropertyTypeService: vi
    .fn()
    .mockResolvedValue({ ok: true, data: { id: "t1", name: "Condominium", sortOrder: 0, isActive: true } }),
  updatePropertyTypeService: vi
    .fn()
    .mockResolvedValue({ ok: true, data: { id: "t1", name: "Condominium", sortOrder: 0, isActive: true } }),
  deletePropertyTypeService: vi.fn().mockResolvedValue({ ok: true, data: { deleted: true } }),
  getPropertyTypeUsageService: vi
    .fn()
    .mockResolvedValue({ ok: true, data: { propertyCount: 0 } }),
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", propertyTypesRoutes);
  return app;
}

const PT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const managerSession: SessionPayload = { userId: "u1", orgId: "o1", role: "manager", userType: "operator" };
const adminSession: SessionPayload = { userId: "u0", orgId: "o1", role: "admin", userType: "operator" };
const editorSession: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };
const tenantSession: SessionPayload = { userId: "u3", orgId: "o1", role: "viewer", userType: "tenant" };
const ownerSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

type RouteSpec = { method: string; path: string; body?: unknown };
const ROUTE_TABLE: RouteSpec[] = [
  { method: "GET", path: "/" },
  { method: "GET", path: `/${PT_ID}/usage` },
  { method: "POST", path: "/", body: { name: "Condominium" } },
  { method: "PATCH", path: `/${PT_ID}`, body: { name: "Landed" } },
  { method: "DELETE", path: `/${PT_ID}` },
];
const MANAGER_ONLY_ROUTES: RouteSpec[] = [
  { method: "POST", path: "/", body: { name: "Condominium" } },
  { method: "PATCH", path: `/${PT_ID}`, body: { name: "Landed" } },
  { method: "DELETE", path: `/${PT_ID}` },
];
const READ_ROUTES: RouteSpec[] = [
  { method: "GET", path: "/" },
  { method: "GET", path: `/${PT_ID}/usage` },
];

function send(app: ReturnType<typeof makeApp>, r: RouteSpec) {
  return app.request(r.path, {
    method: r.method,
    ...(r.body !== undefined
      ? { body: JSON.stringify(r.body), headers: { "content-type": "application/json" } }
      : {}),
  });
}

describe("propertyTypesRoutes auth sweep", () => {
  it.each(ROUTE_TABLE)("missing session gets 401 on $method $path", async (r) => {
    const res = await send(makeApp(null), r);
    expect(res.status).toBe(401);
  });
  const portalSessions: Array<[string, SessionPayload]> = [
    ["tenant", tenantSession],
    ["owner", ownerSession],
  ];
  for (const [label, session] of portalSessions) {
    it.each(ROUTE_TABLE)(`portal ${label} gets 403 on $method $path`, async (r) => {
      const res = await send(makeApp(session), r);
      expect(res.status).toBe(403);
    });
  }
});

describe("propertyTypesRoutes role gates (manager+ for mutations)", () => {
  it.each(MANAGER_ONLY_ROUTES)("editor gets 403 on $method $path (manager-only)", async (r) => {
    const res = await send(makeApp(editorSession), r);
    expect(res.status).toBe(403);
  });
  it.each(READ_ROUTES)("editor can $method $path (200)", async (r) => {
    const res = await send(makeApp(editorSession), r);
    expect(res.status).toBe(200);
  });
});

describe("propertyTypesRoutes happy paths", () => {
  it("GET / (200) returns data array and forwards activeOnly=false", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[0]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(vi.mocked(listPropertyTypesService)).toHaveBeenCalledWith("o1", { activeOnly: false });
  });
  it("GET /?activeOnly=true forwards activeOnly=true", async () => {
    const res = await send(makeApp(managerSession), { method: "GET", path: "/?activeOnly=true" });
    expect(res.status).toBe(200);
    expect(vi.mocked(listPropertyTypesService)).toHaveBeenCalledWith("o1", { activeOnly: true });
  });
  it("GET /:id/usage (200) returns propertyCount", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[1]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { propertyCount: 0 } });
    expect(vi.mocked(getPropertyTypeUsageService)).toHaveBeenCalledWith("o1", PT_ID);
  });
  it("manager can POST / (201)", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[2]!);
    expect(res.status).toBe(201);
    expect(vi.mocked(createPropertyTypeService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "manager" }),
      expect.objectContaining({ name: "Condominium" }),
    );
  });
  it("admin can POST / (201)", async () => {
    const res = await send(makeApp(adminSession), ROUTE_TABLE[2]!);
    expect(res.status).toBe(201);
  });
  it("manager can PATCH /:id (200)", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[3]!);
    expect(res.status).toBe(200);
    expect(vi.mocked(updatePropertyTypeService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }), PT_ID, expect.objectContaining({ name: "Landed" }),
    );
  });
  it("manager can DELETE /:id (200)", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[4]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: true } });
  });
});

describe("propertyTypesRoutes service error translation", () => {
  it("POST duplicate name → 409", async () => {
    vi.mocked(createPropertyTypeService).mockResolvedValueOnce({
      ok: false, status: 409, error: { code: "property_type_name_conflict", message: "x" },
    });
    const res = await send(makeApp(managerSession), ROUTE_TABLE[2]!);
    expect(res.status).toBe(409);
  });
  it("DELETE in-use → 409", async () => {
    vi.mocked(deletePropertyTypeService).mockResolvedValueOnce({
      ok: false, status: 409, error: { code: "property_type_in_use", message: "x" },
    });
    const res = await send(makeApp(managerSession), ROUTE_TABLE[4]!);
    expect(res.status).toBe(409);
  });
  it("PATCH missing/cross-org → 404", async () => {
    vi.mocked(updatePropertyTypeService).mockResolvedValueOnce({
      ok: false, status: 404, error: { code: "property_type_not_found", message: "x" },
    });
    const res = await send(makeApp(managerSession), ROUTE_TABLE[3]!);
    expect(res.status).toBe(404);
  });
});

describe("propertyTypesRoutes validation (400s)", () => {
  it("POST empty name → 400", async () => {
    const res = await send(makeApp(managerSession), { method: "POST", path: "/", body: { name: "" } });
    expect(res.status).toBe(400);
  });
  it("POST unknown field → 400 (strict schema)", async () => {
    const res = await send(makeApp(managerSession), { method: "POST", path: "/", body: { name: "Ok", oops: 1 } });
    expect(res.status).toBe(400);
  });
  it("POST malformed JSON → 400 invalid_json", async () => {
    const res = await makeApp(managerSession).request("/", {
      method: "POST", body: "{bad", headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("invalid_json");
  });
});
