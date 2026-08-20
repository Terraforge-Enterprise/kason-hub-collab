import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { sprintsRoutes } from "../sprints.routes";
import {
  burndownService,
  closeSprintService,
  createSprintService,
  deleteSprintService,
  getSprintService,
  listSprintsService,
  startSprintService,
  trendsService,
  updateSprintService,
} from "../sprints.service";

// Mock all service functions so DB is never reached.
vi.mock("../sprints.service", () => ({
  listSprintsService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: [] }),
  getSprintService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "s1" } }),
  createSprintService: vi.fn().mockResolvedValue({ ok: true, status: 201, data: { id: "s1" } }),
  updateSprintService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "s1" } }),
  startSprintService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "s1" } }),
  closeSprintService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "s1" } }),
  deleteSprintService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "s1" } }),
  trendsService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: [] }),
  burndownService: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { scope: 0, ideal: [], actual: [] } }),
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", sprintsRoutes);
  return app;
}

const SPRINT_ID = "44444444-4444-4444-8444-444444444444";
const ISO = "2026-06-11T00:00:00.000Z";

const managerSession: SessionPayload = { userId: "u1", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };
const tenantSession: SessionPayload = { userId: "u3", orgId: "o1", role: "viewer", userType: "tenant" };
const ownerSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

// Every endpoint on the router — used for the 401/403 + flag sweeps.
const ROUTE_TABLE: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/trends" },
  { method: "GET", path: `/${SPRINT_ID}` },
  { method: "GET", path: `/${SPRINT_ID}/burndown` },
  { method: "POST", path: "/", body: { name: "Cycle 1" } },
  { method: "PATCH", path: `/${SPRINT_ID}`, body: { updatedAt: ISO, name: "Renamed" } },
  { method: "POST", path: `/${SPRINT_ID}/start`, body: { updatedAt: ISO } },
  { method: "POST", path: `/${SPRINT_ID}/close`, body: { updatedAt: ISO } },
  { method: "DELETE", path: `/${SPRINT_ID}`, body: { updatedAt: ISO } },
];

// Manager-only routes (editor must get 403).
const MANAGER_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "POST", path: "/", body: { name: "Cycle 1" } },
  { method: "PATCH", path: `/${SPRINT_ID}`, body: { updatedAt: ISO, name: "Renamed" } },
  { method: "POST", path: `/${SPRINT_ID}/start`, body: { updatedAt: ISO } },
  { method: "POST", path: `/${SPRINT_ID}/close`, body: { updatedAt: ISO } },
  { method: "DELETE", path: `/${SPRINT_ID}`, body: { updatedAt: ISO } },
];

// Named routes (order-independent — happy-path/error tests reference these, not
// ROUTE_TABLE indices, so adding GET /trends + /:id/burndown can't desync them).
const R = {
  list: { method: "GET", path: "/" },
  get: { method: "GET", path: `/${SPRINT_ID}` },
  create: { method: "POST", path: "/", body: { name: "Cycle 1" } },
  patch: { method: "PATCH", path: `/${SPRINT_ID}`, body: { updatedAt: ISO, name: "Renamed" } },
  start: { method: "POST", path: `/${SPRINT_ID}/start`, body: { updatedAt: ISO } },
  close: { method: "POST", path: `/${SPRINT_ID}/close`, body: { updatedAt: ISO } },
  del: { method: "DELETE", path: `/${SPRINT_ID}`, body: { updatedAt: ISO } },
} as const;

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
  process.env.ENABLE_PHASE2_SPRINTS = "1";
});

afterAll(() => {
  delete process.env.ENABLE_PHASE2_TASKS;
  delete process.env.ENABLE_PHASE2_SPRINTS;
});

describe("sprintsRoutes auth sweep", () => {
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

describe("sprintsRoutes role enforcement", () => {
  it.each(MANAGER_ROUTES)("editor gets 403 on manager-only $method $path", async (r) => {
    const res = await send(makeApp(editorSession), r);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });
});

describe("sprintsRoutes happy paths", () => {
  it("editor can GET / (200) and the status filter reaches the service", async () => {
    const res = await send(makeApp(editorSession), {
      method: "GET",
      path: "/?status=planned",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(vi.mocked(listSprintsService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2", actorRole: "editor" }),
      expect.objectContaining({ status: "planned" }),
    );
  });

  it("editor can GET /:id (200)", async () => {
    const res = await send(makeApp(editorSession), R.get);
    expect(res.status).toBe(200);
    expect(vi.mocked(getSprintService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      SPRINT_ID,
    );
  });

  it("manager can POST / (201) and the parsed body reaches the service", async () => {
    const res = await send(makeApp(managerSession), R.create);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: "s1" } });
    expect(vi.mocked(createSprintService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "manager" }),
      expect.objectContaining({ name: "Cycle 1" }),
    );
  });

  it("manager can PATCH /:id (200) with sprintId merged from the route param", async () => {
    const res = await send(makeApp(managerSession), R.patch);
    expect(res.status).toBe(200);
    expect(vi.mocked(updateSprintService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ sprintId: SPRINT_ID, name: "Renamed", updatedAt: ISO }),
    );
  });

  it("manager can POST /:id/start (200) with sprintId merged from the route param", async () => {
    const res = await send(makeApp(managerSession), R.start);
    expect(res.status).toBe(200);
    expect(vi.mocked(startSprintService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ sprintId: SPRINT_ID, updatedAt: ISO }),
    );
  });

  it("manager can POST /:id/close (200)", async () => {
    const res = await send(makeApp(managerSession), R.close);
    expect(res.status).toBe(200);
    expect(vi.mocked(closeSprintService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ sprintId: SPRINT_ID, updatedAt: ISO }),
    );
  });

  it("manager can DELETE /:id (200) with sprintId merged from the route param", async () => {
    const res = await send(makeApp(managerSession), R.del);
    expect(res.status).toBe(200);
    expect(vi.mocked(deleteSprintService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "manager" }),
      expect.objectContaining({ sprintId: SPRINT_ID, updatedAt: ISO }),
    );
  });
});

describe("sprintsRoutes Spec 3 reads (trends + burndown)", () => {
  it("editor can GET /trends (200) and the window query reaches the service", async () => {
    vi.mocked(trendsService).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: [{ seq: 1, name: null, completed: 4, carried: 1, completionRate: 80 }],
    });
    const res = await send(makeApp(editorSession), { method: "GET", path: "/trends?window=5" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ seq: 1, name: null, completed: 4, carried: 1, completionRate: 80 }],
    });
    expect(vi.mocked(trendsService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "editor" }),
      expect.objectContaining({ window: 5 }),
    );
  });

  it("GET /trends is NOT shadowed by /:id — it hits trendsService, never getSprintService", async () => {
    // Route-order regression guard: if `/:id` were registered first, Hono would
    // match `/trends` as id="trends" and dispatch to getSprintService (the 404
    // sprint-not-found path). Mocks accumulate across this file, so assert on the
    // per-call DELTA rather than absolute call counts.
    vi.mocked(getSprintService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Sprint not found",
    });
    const trendsBefore = vi.mocked(trendsService).mock.calls.length;
    const getBefore = vi.mocked(getSprintService).mock.calls.length;

    const res = await send(makeApp(editorSession), { method: "GET", path: "/trends" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] }); // trend list, not a 404 sprint-not-found
    expect(vi.mocked(trendsService).mock.calls.length).toBe(trendsBefore + 1);
    expect(vi.mocked(getSprintService).mock.calls.length).toBe(getBefore); // never dispatched
  });

  it("GET /trends?window=51 returns 400 (schema guards the window ceiling)", async () => {
    const before = vi.mocked(trendsService).mock.calls.length;
    const res = await send(makeApp(editorSession), { method: "GET", path: "/trends?window=51" });
    expect(res.status).toBe(400);
    // service is NOT reached when the query fails validation (delta stays 0).
    expect(vi.mocked(trendsService).mock.calls.length).toBe(before);
  });

  it("editor can GET /:id/burndown (200) and the sprintId reaches the service", async () => {
    vi.mocked(burndownService).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        scope: 3,
        ideal: [{ date: "2026-06-01", remaining: 3 }],
        actual: [{ date: "2026-06-01", remaining: 3 }],
      },
    });
    const res = await send(makeApp(editorSession), { method: "GET", path: `/${SPRINT_ID}/burndown` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        scope: 3,
        ideal: [{ date: "2026-06-01", remaining: 3 }],
        actual: [{ date: "2026-06-01", remaining: 3 }],
      },
    });
    expect(vi.mocked(burndownService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      SPRINT_ID,
    );
  });

  it("maps a burndown service 404 to HTTP 404 (missing/cross-org sprint)", async () => {
    vi.mocked(burndownService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Sprint not found",
    });
    const res = await send(makeApp(editorSession), { method: "GET", path: `/${SPRINT_ID}/burndown` });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Sprint not found" });
  });
});

describe("sprintsRoutes validation", () => {
  it("POST / with an unknown field returns 400 (strict schema)", async () => {
    const res = await send(makeApp(managerSession), {
      method: "POST",
      path: "/",
      body: { name: "Cycle", bogus: 1 },
    });
    expect(res.status).toBe(400);
  });

  it("GET /?status=bogus returns 400 (schema guards the filter)", async () => {
    const res = await send(makeApp(editorSession), { method: "GET", path: "/?status=bogus" });
    expect(res.status).toBe(400);
  });

  it("POST / with malformed JSON returns 400 Invalid JSON body", async () => {
    const res = await makeApp(managerSession).request("/", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("PATCH /:id with a non-uuid path param returns 400", async () => {
    const res = await makeApp(managerSession).request("/not-a-uuid", {
      method: "PATCH",
      body: JSON.stringify({ updatedAt: ISO, name: "X" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});

describe("sprintsRoutes service error translation", () => {
  it("maps a service 404 to HTTP 404 (missing/cross-org)", async () => {
    vi.mocked(getSprintService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Sprint not found",
    });
    const res = await send(makeApp(editorSession), R.get);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Sprint not found" });
  });

  it("maps a 409 stale on PATCH to HTTP 409 with the exact message", async () => {
    vi.mocked(updateSprintService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Record changed — reloaded",
    });
    const res = await send(makeApp(managerSession), R.patch);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Record changed — reloaded" });
  });

  it("maps a 409 stale on start to HTTP 409 with the exact message", async () => {
    vi.mocked(startSprintService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Record changed — reloaded",
    });
    const res = await send(makeApp(managerSession), R.start);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Record changed — reloaded" });
  });

  it("maps a 400 NOT_PLANNED on start to HTTP 400", async () => {
    vi.mocked(startSprintService).mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: "Only a planned sprint can be started",
    });
    const res = await send(makeApp(managerSession), R.start);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Only a planned sprint can be started" });
  });

  it("maps a 400 NOT_ACTIVE on close to HTTP 400", async () => {
    vi.mocked(closeSprintService).mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: "Only an active sprint can be closed",
    });
    const res = await send(makeApp(managerSession), R.close);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Only an active sprint can be closed" });
  });
});

describe("sprintsRoutes feature-flag gate", () => {
  it.each(ROUTE_TABLE)(
    "returns canonical 404 not_found on $method $path while ENABLE_PHASE2_SPRINTS is dark, even for manager",
    async (r) => {
      delete process.env.ENABLE_PHASE2_SPRINTS;
      try {
        const res = await send(makeApp(managerSession), r);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
      } finally {
        process.env.ENABLE_PHASE2_SPRINTS = "1";
      }
    },
  );

  it("returns canonical 404 not_found when ENABLE_PHASE2_TASKS is dark (outer gate)", async () => {
    delete process.env.ENABLE_PHASE2_TASKS;
    try {
      const res = await send(makeApp(managerSession), R.list);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_TASKS = "1";
    }
  });
});
