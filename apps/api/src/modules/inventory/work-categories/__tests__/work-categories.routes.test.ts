import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../../lib/auth";
import { workCategoriesRoutes } from "../work-categories.routes";
import {
  createWorkCategoryService,
  deleteWorkCategoryService,
  getWorkCategoryUsageService,
  listWorkCategoriesService,
  updateWorkCategoryService,
} from "../work-categories.service";

// Mock all service functions so DB is never reached.
vi.mock("../work-categories.service", () => ({
  listWorkCategoriesService: vi.fn().mockResolvedValue([]),
  createWorkCategoryService: vi
    .fn()
    .mockResolvedValue({ ok: true, data: { id: "c1", name: "Roofing", sortOrder: 0, isActive: true } }),
  updateWorkCategoryService: vi
    .fn()
    .mockResolvedValue({ ok: true, data: { id: "c1", name: "Roofing", sortOrder: 0, isActive: true } }),
  deleteWorkCategoryService: vi.fn().mockResolvedValue({ ok: true, data: { deleted: true } }),
  getWorkCategoryUsageService: vi
    .fn()
    .mockResolvedValue({ ok: true, data: { ticketCount: 0, taskCount: 0 } }),
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", workCategoriesRoutes);
  return app;
}

const CAT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const managerSession: SessionPayload = {
  userId: "u1",
  orgId: "o1",
  role: "manager",
  userType: "operator",
};
const adminSession: SessionPayload = {
  userId: "u0",
  orgId: "o1",
  role: "admin",
  userType: "operator",
};
const editorSession: SessionPayload = {
  userId: "u2",
  orgId: "o1",
  role: "editor",
  userType: "operator",
};
const tenantSession: SessionPayload = {
  userId: "u3",
  orgId: "o1",
  role: "viewer",
  userType: "tenant",
};
const ownerSession: SessionPayload = {
  userId: "u4",
  orgId: "o1",
  role: "viewer",
  userType: "owner",
};

type RouteSpec = { method: string; path: string; body?: unknown };

// Every endpoint — used for the 401/403 sweeps.
const ROUTE_TABLE: RouteSpec[] = [
  { method: "GET", path: "/" },
  { method: "GET", path: `/${CAT_ID}/usage` },
  { method: "POST", path: "/", body: { name: "Roofing" } },
  { method: "PATCH", path: `/${CAT_ID}`, body: { name: "Plumbing" } },
  { method: "DELETE", path: `/${CAT_ID}` },
];

// Manager-only mutation routes.
const MANAGER_ONLY_ROUTES: RouteSpec[] = [
  { method: "POST", path: "/", body: { name: "Roofing" } },
  { method: "PATCH", path: `/${CAT_ID}`, body: { name: "Plumbing" } },
  { method: "DELETE", path: `/${CAT_ID}` },
];

// Editor-accessible read routes.
const READ_ROUTES: RouteSpec[] = [
  { method: "GET", path: "/" },
  { method: "GET", path: `/${CAT_ID}/usage` },
];

function send(
  app: ReturnType<typeof makeApp>,
  r: { method: string; path: string; body?: unknown },
) {
  return app.request(r.path, {
    method: r.method,
    ...(r.body !== undefined
      ? { body: JSON.stringify(r.body), headers: { "content-type": "application/json" } }
      : {}),
  });
}

beforeAll(() => {
  process.env.ENABLE_PHASE2_TASKS = "1";
});

afterAll(() => {
  delete process.env.ENABLE_PHASE2_TASKS;
});

describe("workCategoriesRoutes auth sweep", () => {
  it.each(ROUTE_TABLE)("missing session gets 401 on $method $path", async (r) => {
    const res = await send(makeApp(null), r);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  const portalSessions: Array<[string, SessionPayload]> = [
    ["tenant", tenantSession],
    ["owner", ownerSession],
  ];
  for (const [label, session] of portalSessions) {
    it.each(ROUTE_TABLE)(`portal ${label} gets 403 on $method $path`, async (r) => {
      const res = await send(makeApp(session), r);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });
  }
});

describe("workCategoriesRoutes role gates (manager+ for mutations)", () => {
  it.each(MANAGER_ONLY_ROUTES)(
    "editor gets 403 on $method $path (manager-only)",
    async (r) => {
      const res = await send(makeApp(editorSession), r);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    },
  );

  it.each(READ_ROUTES)("editor can $method $path (200/OK)", async (r) => {
    const res = await send(makeApp(editorSession), r);
    expect(res.status).toBe(200);
  });
});

describe("workCategoriesRoutes happy paths (manager)", () => {
  it("manager can GET / (200) and gets data array", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[0]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(vi.mocked(listWorkCategoriesService)).toHaveBeenCalledWith("o1", { activeOnly: false });
  });

  it("GET /?activeOnly=true forwards activeOnly=true to service", async () => {
    const res = await send(makeApp(managerSession), { method: "GET", path: "/?activeOnly=true" });
    expect(res.status).toBe(200);
    expect(vi.mocked(listWorkCategoriesService)).toHaveBeenCalledWith("o1", { activeOnly: true });
  });

  it("manager can GET /:id/usage (200) and gets ticketCount + taskCount", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[1]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ticketCount: 0, taskCount: 0 } });
    expect(vi.mocked(getWorkCategoryUsageService)).toHaveBeenCalledWith("o1", CAT_ID);
  });

  it("manager can POST / (201) and correct shape is returned", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[2]!);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      data: { id: "c1", name: "Roofing", sortOrder: 0, isActive: true },
    });
    expect(vi.mocked(createWorkCategoryService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "manager" }),
      expect.objectContaining({ name: "Roofing" }),
    );
  });

  it("admin can POST / (201)", async () => {
    const res = await send(makeApp(adminSession), ROUTE_TABLE[2]!);
    expect(res.status).toBe(201);
  });

  it("manager can PATCH /:id (200) and correct shape is returned", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[3]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { id: "c1", name: "Roofing", sortOrder: 0, isActive: true },
    });
    expect(vi.mocked(updateWorkCategoryService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "manager" }),
      CAT_ID,
      expect.objectContaining({ name: "Plumbing" }),
    );
  });

  it("manager can DELETE /:id (200) and gets { deleted: true }", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[4]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: true } });
    expect(vi.mocked(deleteWorkCategoryService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "manager" }),
      CAT_ID,
    );
  });
});

describe("workCategoriesRoutes cross-org / not-found / conflict (service error translation)", () => {
  it("GET /:id/usage on a cross-org id → 404 from service", async () => {
    vi.mocked(getWorkCategoryUsageService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: { code: "category_not_found", message: "Category not found in this organization." },
    });
    const res = await send(makeApp(managerSession), ROUTE_TABLE[1]!);
    expect(res.status).toBe(404);
  });

  it("POST / with a duplicate name → 409 from service", async () => {
    vi.mocked(createWorkCategoryService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: { code: "category_name_conflict", message: "A category with this name already exists." },
    });
    const res = await send(makeApp(managerSession), ROUTE_TABLE[2]!);
    expect(res.status).toBe(409);
  });

  it("PATCH /:id on a missing/cross-org id → 404 from service", async () => {
    vi.mocked(updateWorkCategoryService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: { code: "category_not_found", message: "Category not found in this organization." },
    });
    const res = await send(makeApp(managerSession), ROUTE_TABLE[3]!);
    expect(res.status).toBe(404);
  });

  it("PATCH /:id with a conflicting name → 409 from service", async () => {
    vi.mocked(updateWorkCategoryService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: { code: "category_name_conflict", message: "A category with this name already exists." },
    });
    const res = await send(makeApp(managerSession), ROUTE_TABLE[3]!);
    expect(res.status).toBe(409);
  });

  it("DELETE /:id on a missing/cross-org id → 404 from service", async () => {
    vi.mocked(deleteWorkCategoryService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: { code: "category_not_found", message: "Category not found in this organization." },
    });
    const res = await send(makeApp(managerSession), ROUTE_TABLE[4]!);
    expect(res.status).toBe(404);
  });

  it("DELETE /:id on an in-use category → 409 from service", async () => {
    vi.mocked(deleteWorkCategoryService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: { code: "category_in_use", message: "Cannot delete a category that is in use." },
    });
    const res = await send(makeApp(managerSession), ROUTE_TABLE[4]!);
    expect(res.status).toBe(409);
  });
});

describe("workCategoriesRoutes validation (400s)", () => {
  it("POST / with empty name returns 400", async () => {
    const res = await send(makeApp(managerSession), {
      method: "POST",
      path: "/",
      body: { name: "" },
    });
    expect(res.status).toBe(400);
  });

  it("POST / with malformed JSON returns 400 Invalid JSON body", async () => {
    const res = await makeApp(managerSession).request("/", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_json");
  });

  it("POST / with negative sortOrder returns 400", async () => {
    const res = await send(makeApp(managerSession), {
      method: "POST",
      path: "/",
      body: { name: "Valid", sortOrder: -1 },
    });
    expect(res.status).toBe(400);
  });

  it("POST / with an extra unknown field returns 400 (strict schema)", async () => {
    const res = await send(makeApp(managerSession), {
      method: "POST",
      path: "/",
      body: { name: "Valid", unknownField: "oops" },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /:id with malformed JSON returns 400 Invalid JSON body", async () => {
    const res = await makeApp(managerSession).request(`/${CAT_ID}`, {
      method: "PATCH",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_json");
  });
});

describe("workCategoriesRoutes feature-flag gate", () => {
  it("returns canonical 404 not_found on all routes while ENABLE_PHASE2_TASKS is unset", async () => {
    delete process.env.ENABLE_PHASE2_TASKS;
    try {
      for (const r of ROUTE_TABLE) {
        const res = await send(makeApp(managerSession), r);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    } finally {
      process.env.ENABLE_PHASE2_TASKS = "1";
    }
  });
});
