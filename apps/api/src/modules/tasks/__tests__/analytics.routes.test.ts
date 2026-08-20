import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { analyticsRoutes } from "../analytics.routes";
import { getUnitsAnalytics, getCategoryLens, getTrend, getUnitMiniStat } from "../analytics.service";

// Mock all service functions so DB is never reached.
vi.mock("../analytics.service", () => ({
  getUnitsAnalytics: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      rows: [],
      unmapped: { count: 0 },
      summary: { mttrDays: null, oldestOpenDays: null, openOver30: 0 },
    },
  }),
  getCategoryLens: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    data: [],
  }),
  getTrend: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    data: [],
  }),
  getUnitMiniStat: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      unitId: "u1",
      total: 0,
      open: 0,
      windowTotal: 0,
      byCategory: [],
      recurringCategories: [],
    },
  }),
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", analyticsRoutes);
  return app;
}

const UNIT_ID = "33333333-3333-4333-8333-333333333333";

const managerSession: SessionPayload = { userId: "u1", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };
const tenantSession: SessionPayload = { userId: "u3", orgId: "o1", role: "viewer", userType: "tenant" };
const ownerSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

// All analytics routes for the auth sweep
type RouteSpec = { method: string; path: string };
const ANALYTICS_ROUTE_TABLE: RouteSpec[] = [
  { method: "GET", path: "/units" },
  { method: "GET", path: "/categories" },
  { method: "GET", path: "/trend" },
  { method: "GET", path: `/units/${UNIT_ID}` },
];

beforeAll(() => {
  process.env.ENABLE_PHASE2_TASKS = "1";
  process.env.ENABLE_PHASE2_UNIT_ANALYTICS = "1";
});

afterAll(() => {
  delete process.env.ENABLE_PHASE2_TASKS;
  delete process.env.ENABLE_PHASE2_UNIT_ANALYTICS;
});

function send(app: ReturnType<typeof makeApp>, r: RouteSpec) {
  return app.request(r.path, { method: r.method });
}

// ─── Auth sweep ──────────────────────────────────────────────────────────────

describe("analyticsRoutes auth sweep", () => {
  it.each(ANALYTICS_ROUTE_TABLE)("missing session gets 401 on $method $path", async (r) => {
    const res = await send(makeApp(null), r);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  const portalSessions: Array<[string, SessionPayload]> = [
    ["tenant", tenantSession],
    ["owner", ownerSession],
  ];
  for (const [label, session] of portalSessions) {
    it.each(ANALYTICS_ROUTE_TABLE)(`portal ${label} gets 403 on $method $path`, async (r) => {
      const res = await send(makeApp(session), r);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });
  }
});

// ─── Feature-flag gate (double gate) ─────────────────────────────────────────

describe("double feature-flag gate", () => {
  it("returns 404 not_found when ENABLE_PHASE2_TASKS is OFF (even with analytics ON)", async () => {
    delete process.env.ENABLE_PHASE2_TASKS;
    try {
      const res = await send(makeApp(managerSession), ANALYTICS_ROUTE_TABLE[0]!);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_TASKS = "1";
    }
  });

  it("returns 404 not_found when ENABLE_PHASE2_UNIT_ANALYTICS is OFF (even with tasks ON)", async () => {
    delete process.env.ENABLE_PHASE2_UNIT_ANALYTICS;
    try {
      const res = await send(makeApp(managerSession), ANALYTICS_ROUTE_TABLE[0]!);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_UNIT_ANALYTICS = "1";
    }
  });

  it("returns 404 not_found on /categories when ENABLE_PHASE2_UNIT_ANALYTICS is OFF", async () => {
    delete process.env.ENABLE_PHASE2_UNIT_ANALYTICS;
    try {
      const res = await send(makeApp(managerSession), ANALYTICS_ROUTE_TABLE[1]!);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_UNIT_ANALYTICS = "1";
    }
  });

  it("returns 404 not_found on /units/:unitId when ENABLE_PHASE2_UNIT_ANALYTICS is OFF", async () => {
    delete process.env.ENABLE_PHASE2_UNIT_ANALYTICS;
    try {
      const res = await send(makeApp(editorSession), ANALYTICS_ROUTE_TABLE[3]!);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_UNIT_ANALYTICS = "1";
    }
  });
});

// ─── Role gates (manager-only routes) ────────────────────────────────────────

describe("role gates — manager-only routes", () => {
  it("editor gets 403 on GET /units", async () => {
    const res = await send(makeApp(editorSession), ANALYTICS_ROUTE_TABLE[0]!);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("editor gets 403 on GET /categories", async () => {
    const res = await send(makeApp(editorSession), ANALYTICS_ROUTE_TABLE[1]!);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("editor gets 403 on GET /trend", async () => {
    const res = await send(makeApp(editorSession), ANALYTICS_ROUTE_TABLE[2]!);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });
});

// ─── Happy paths (manager) ────────────────────────────────────────────────────

describe("happy paths (manager)", () => {
  it("manager can GET /units (200) with { data }", async () => {
    const res = await send(makeApp(managerSession), ANALYTICS_ROUTE_TABLE[0]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        rows: [],
        unmapped: { count: 0 },
        summary: { mttrDays: null, oldestOpenDays: null, openOver30: 0 },
      },
    });
    expect(vi.mocked(getUnitsAnalytics)).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ window: "12mo" }),
    );
  });

  it("manager can GET /categories (200) with { data }", async () => {
    const res = await send(makeApp(managerSession), ANALYTICS_ROUTE_TABLE[1]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(vi.mocked(getCategoryLens)).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ window: "12mo" }),
    );
  });

  it("manager can GET /trend (200) with { data }", async () => {
    const res = await send(makeApp(managerSession), ANALYTICS_ROUTE_TABLE[2]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(vi.mocked(getTrend)).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ window: "12mo" }),
    );
  });

  it("manager passes propertyId query param to getUnitsAnalytics", async () => {
    const propId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const res = await makeApp(managerSession).request(`/units?propertyId=${propId}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(getUnitsAnalytics)).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ window: "12mo", propertyId: propId }),
    );
  });

  it("manager passes window=30d to getTrend", async () => {
    const res = await makeApp(managerSession).request("/trend?window=30d");
    expect(res.status).toBe(200);
    expect(vi.mocked(getTrend)).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ window: "30d" }),
    );
  });
});

// ─── Per-unit route — editor allowed ─────────────────────────────────────────

describe("GET /units/:unitId — editor allowed", () => {
  it("editor can GET /units/:unitId (200) with { data }", async () => {
    const res = await send(makeApp(editorSession), ANALYTICS_ROUTE_TABLE[3]!);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ data: { unitId: "u1" } });
    expect(vi.mocked(getUnitMiniStat)).toHaveBeenCalledWith(
      "o1",
      UNIT_ID,
      expect.objectContaining({ window: "12mo" }),
    );
  });

  it("manager can GET /units/:unitId (200)", async () => {
    const res = await send(makeApp(managerSession), ANALYTICS_ROUTE_TABLE[3]!);
    expect(res.status).toBe(200);
  });
});

// ─── Validation (400s) ────────────────────────────────────────────────────────

describe("validation (400s)", () => {
  it("GET /units with invalid window returns 400", async () => {
    const res = await makeApp(managerSession).request("/units?window=7d");
    expect(res.status).toBe(400);
  });

  it("GET /units/:unitId with invalid window returns 400", async () => {
    const res = await makeApp(editorSession).request(`/units/${UNIT_ID}?window=7d`);
    expect(res.status).toBe(400);
  });

  it("GET /units/:unitId with unknown query key returns 400 (strict schema)", async () => {
    const res = await makeApp(editorSession).request(`/units/${UNIT_ID}?window=30d&extra=x`);
    expect(res.status).toBe(400);
  });

  it("GET /units with unknown query key returns 400 (strict schema)", async () => {
    const res = await makeApp(managerSession).request("/units?window=30d&extra=x");
    expect(res.status).toBe(400);
  });
});

// ─── Service error propagation ────────────────────────────────────────────────

describe("service error propagation", () => {
  it("GET /units propagates service error with status code", async () => {
    vi.mocked(getUnitsAnalytics).mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: "internal error",
    });
    const res = await send(makeApp(managerSession), ANALYTICS_ROUTE_TABLE[0]!);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });
});
