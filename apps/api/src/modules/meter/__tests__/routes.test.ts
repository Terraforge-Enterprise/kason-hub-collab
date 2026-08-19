import { beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

const {
  listMetersServiceMock,
  chargeUtilityBillServiceMock,
  updateMeterServiceMock,
  setMeterActiveServiceMock,
  updateReadingServiceMock,
  voidReadingServiceMock,
  updateUtilityBillServiceMock,
  previewUtilityBillServiceMock,
  voidUtilityBillServiceMock,
  getAllocationServiceMock,
  getMeterServiceMock,
  getReadingServiceMock,
  getUtilityBillServiceMock,
  listReadingsServiceMock,
  listUtilityBillsServiceMock,
  setTenancyPaxServiceMock,
} = vi.hoisted(() => ({
  listMetersServiceMock: vi.fn(),
  chargeUtilityBillServiceMock: vi.fn(),
  updateMeterServiceMock: vi.fn(),
  setMeterActiveServiceMock: vi.fn(),
  updateReadingServiceMock: vi.fn(),
  voidReadingServiceMock: vi.fn(),
  updateUtilityBillServiceMock: vi.fn(),
  previewUtilityBillServiceMock: vi.fn(),
  voidUtilityBillServiceMock: vi.fn(),
  getAllocationServiceMock: vi.fn(),
  getMeterServiceMock: vi.fn(),
  getReadingServiceMock: vi.fn(),
  getUtilityBillServiceMock: vi.fn(),
  listReadingsServiceMock: vi.fn(),
  listUtilityBillsServiceMock: vi.fn(),
  setTenancyPaxServiceMock: vi.fn(),
}));
vi.mock("../service", () => ({
  listMetersService: listMetersServiceMock,
  chargeUtilityBillService: chargeUtilityBillServiceMock,
  updateMeterService: updateMeterServiceMock,
  setMeterActiveService: setMeterActiveServiceMock,
  updateReadingService: updateReadingServiceMock,
  voidReadingService: voidReadingServiceMock,
  updateUtilityBillService: updateUtilityBillServiceMock,
  previewUtilityBillService: previewUtilityBillServiceMock,
  voidUtilityBillService: voidUtilityBillServiceMock,
  getAllocationService: getAllocationServiceMock,
  getMeterService: getMeterServiceMock,
  getReadingService: getReadingServiceMock,
  getUtilityBillService: getUtilityBillServiceMock,
  setTenancyPaxService: setTenancyPaxServiceMock,
  // the route module imports many named services; stub the rest as no-ops
  createMeterService: vi.fn(),
  createReadingService: vi.fn(), listReadingsService: listReadingsServiceMock,
  createUtilityBillService: vi.fn(), listUtilityBillsService: listUtilityBillsServiceMock,
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => { if (session) c.set("session", session); await next(); });
  return app;
}
const editor: SessionPayload = { userId: "u1", orgId: "o1", role: "editor", userType: "operator" };
const manager: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("meter routes — flag gate + RBAC", () => {
  it("flag OFF → 404 even for a valid editor", async () => {
    delete process.env.ENABLE_PHASE2_METER;
    const { meterRoutes } = await import("../routes");
    const app = makeApp(editor); app.route("/", meterRoutes);
    const res = await app.request("/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("flag ON + editor → 200 list", async () => {
    process.env.ENABLE_PHASE2_METER = "true";
    listMetersServiceMock.mockResolvedValue({ ok: true, status: 200, data: { data: [], nextCursor: null } });
    vi.resetModules();
    const { meterRoutes } = await import("../routes");
    const app = makeApp(editor); app.route("/", meterRoutes);
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  it("flag ON + missing session → 401", async () => {
    process.env.ENABLE_PHASE2_METER = "true";
    vi.resetModules();
    const { meterRoutes } = await import("../routes");
    const app = makeApp(null); app.route("/", meterRoutes);
    const res = await app.request("/");
    expect(res.status).toBe(401);
  });

  it("flag ON + editor → 403 on charge (manager gate blocks before service)", async () => {
    process.env.ENABLE_PHASE2_METER = "true";
    chargeUtilityBillServiceMock.mockClear();
    vi.resetModules();
    const { meterRoutes } = await import("../routes");
    const app = makeApp(editor); app.route("/", meterRoutes);
    const res = await app.request(`/utility-bills/${VALID_UUID}/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(chargeUtilityBillServiceMock).not.toHaveBeenCalled();
  });

  it("flag ON + manager → 200 on charge (gate passes, service runs)", async () => {
    process.env.ENABLE_PHASE2_METER = "true";
    chargeUtilityBillServiceMock.mockClear();
    chargeUtilityBillServiceMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: { billId: "b1", utilityCharges: 1, aircondCharges: 1 },
    });
    vi.resetModules();
    const { meterRoutes } = await import("../routes");
    const app = makeApp(manager); app.route("/", meterRoutes);
    const res = await app.request(`/utility-bills/${VALID_UUID}/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(chargeUtilityBillServiceMock).toHaveBeenCalled();
  });
});

// ── Mutation-route RBAC + status mapping (flag ON, service mocked) ────────────
// Money-mutating routes must be manager-only: meter update, retire/restore,
// reading-void, bill-void. Reading-update + bill-update + preview are editor-OK.
const okData = { ok: true as const, status: 200, data: { id: VALID_UUID } };

async function buildApp(session: SessionPayload | null) {
  process.env.ENABLE_PHASE2_METER = "true";
  vi.resetModules();
  const { meterRoutes } = await import("../routes");
  const app = makeApp(session); app.route("/", meterRoutes);
  return app;
}
const jsonPost: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
type TestApp = Awaited<ReturnType<typeof buildApp>>;
async function reqJson(app: TestApp, path: string, method: "POST" | "PATCH") {
  return app.request(path, { method, headers: { "Content-Type": "application/json" }, body: "{}" });
}

describe("meter routes — mutation RBAC + status mapping", () => {
  // PATCH /:id (meter update) — manager-only
  it("PATCH /:id (meter update): editor → 403, service not called", async () => {
    updateMeterServiceMock.mockClear();
    const app = await buildApp(editor);
    const res = await reqJson(app, `/${VALID_UUID}`, "PATCH");
    expect(res.status).toBe(403);
    expect(updateMeterServiceMock).not.toHaveBeenCalled();
  });
  it("PATCH /:id (meter update): manager → 200", async () => {
    updateMeterServiceMock.mockClear();
    updateMeterServiceMock.mockResolvedValue(okData);
    const app = await buildApp(manager);
    const res = await reqJson(app, `/${VALID_UUID}`, "PATCH");
    expect(res.status).toBe(200);
    expect(updateMeterServiceMock).toHaveBeenCalled();
  });

  // POST /:id/retire — manager-only
  it("POST /:id/retire: editor → 403, service not called", async () => {
    setMeterActiveServiceMock.mockClear();
    const app = await buildApp(editor);
    const res = await app.request(`/${VALID_UUID}/retire`, jsonPost);
    expect(res.status).toBe(403);
    expect(setMeterActiveServiceMock).not.toHaveBeenCalled();
  });
  it("POST /:id/retire: manager → 200 (isActive=false)", async () => {
    setMeterActiveServiceMock.mockClear();
    setMeterActiveServiceMock.mockResolvedValue(okData);
    const app = await buildApp(manager);
    const res = await app.request(`/${VALID_UUID}/retire`, jsonPost);
    expect(res.status).toBe(200);
    expect(setMeterActiveServiceMock).toHaveBeenCalledWith(expect.anything(), VALID_UUID, false);
  });

  // POST /:id/restore — manager-only
  it("POST /:id/restore: editor → 403, service not called", async () => {
    setMeterActiveServiceMock.mockClear();
    const app = await buildApp(editor);
    const res = await app.request(`/${VALID_UUID}/restore`, jsonPost);
    expect(res.status).toBe(403);
    expect(setMeterActiveServiceMock).not.toHaveBeenCalled();
  });
  it("POST /:id/restore: manager → 200 (isActive=true)", async () => {
    setMeterActiveServiceMock.mockClear();
    setMeterActiveServiceMock.mockResolvedValue(okData);
    const app = await buildApp(manager);
    const res = await app.request(`/${VALID_UUID}/restore`, jsonPost);
    expect(res.status).toBe(200);
    expect(setMeterActiveServiceMock).toHaveBeenCalledWith(expect.anything(), VALID_UUID, true);
  });

  // PATCH /readings/:id (reading update) — editor-OK; missing session → 401
  it("PATCH /readings/:id (reading update): editor → 200", async () => {
    updateReadingServiceMock.mockClear();
    updateReadingServiceMock.mockResolvedValue(okData);
    const app = await buildApp(editor);
    const res = await reqJson(app, `/readings/${VALID_UUID}`, "PATCH");
    expect(res.status).toBe(200);
    expect(updateReadingServiceMock).toHaveBeenCalled();
  });
  it("PATCH /readings/:id (reading update): missing session → 401, service not called", async () => {
    updateReadingServiceMock.mockClear();
    const app = await buildApp(null);
    const res = await reqJson(app, `/readings/${VALID_UUID}`, "PATCH");
    expect(res.status).toBe(401);
    expect(updateReadingServiceMock).not.toHaveBeenCalled();
  });

  // PATCH /tenancies/:tenancyId/pax (set billing headcount) — editor-OK
  const paxReq = (app: TestApp, body: string) =>
    app.request(`/tenancies/${VALID_UUID}/pax`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
  it("PATCH /tenancies/:tenancyId/pax: editor + valid body → 200, service called", async () => {
    setTenancyPaxServiceMock.mockClear();
    setTenancyPaxServiceMock.mockResolvedValue(okData);
    const app = await buildApp(editor);
    const res = await paxReq(app, JSON.stringify({ numberOfPax: 2 }));
    expect(res.status).toBe(200);
    expect(setTenancyPaxServiceMock).toHaveBeenCalledWith(expect.anything(), VALID_UUID, { numberOfPax: 2 });
  });
  it("PATCH /tenancies/:tenancyId/pax: missing session → 401, service not called", async () => {
    setTenancyPaxServiceMock.mockClear();
    const app = await buildApp(null);
    const res = await paxReq(app, JSON.stringify({ numberOfPax: 2 }));
    expect(res.status).toBe(401);
    expect(setTenancyPaxServiceMock).not.toHaveBeenCalled();
  });
  it("PATCH /tenancies/:tenancyId/pax: invalid body (numberOfPax 0) → 400, service not called", async () => {
    setTenancyPaxServiceMock.mockClear();
    const app = await buildApp(editor);
    const res = await paxReq(app, JSON.stringify({ numberOfPax: 0 }));
    expect(res.status).toBe(400);
    expect(setTenancyPaxServiceMock).not.toHaveBeenCalled();
  });
  it("PATCH /tenancies/:tenancyId/pax: service 404 → 404 not found", async () => {
    setTenancyPaxServiceMock.mockClear();
    setTenancyPaxServiceMock.mockResolvedValue({ ok: false, status: 404, error: "TENANCY_NOT_FOUND" });
    const app = await buildApp(editor);
    const res = await paxReq(app, JSON.stringify({ numberOfPax: 3 }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "TENANCY_NOT_FOUND" });
  });

  // POST /readings/:id/void — manager-only
  it("POST /readings/:id/void: editor → 403, service not called", async () => {
    voidReadingServiceMock.mockClear();
    const app = await buildApp(editor);
    const res = await app.request(`/readings/${VALID_UUID}/void`, jsonPost);
    expect(res.status).toBe(403);
    expect(voidReadingServiceMock).not.toHaveBeenCalled();
  });
  it("POST /readings/:id/void: manager → 200", async () => {
    voidReadingServiceMock.mockClear();
    voidReadingServiceMock.mockResolvedValue(okData);
    const app = await buildApp(manager);
    const res = await app.request(`/readings/${VALID_UUID}/void`, jsonPost);
    expect(res.status).toBe(200);
    expect(voidReadingServiceMock).toHaveBeenCalled();
  });

  // PATCH /utility-bills/:id (bill update) — editor-OK
  it("PATCH /utility-bills/:id (bill update): editor → 200", async () => {
    updateUtilityBillServiceMock.mockClear();
    updateUtilityBillServiceMock.mockResolvedValue(okData);
    const app = await buildApp(editor);
    const res = await reqJson(app, `/utility-bills/${VALID_UUID}`, "PATCH");
    expect(res.status).toBe(200);
    expect(updateUtilityBillServiceMock).toHaveBeenCalled();
  });

  // POST /utility-bills/:id/preview — editor-OK
  it("POST /utility-bills/:id/preview: editor → 200", async () => {
    previewUtilityBillServiceMock.mockClear();
    previewUtilityBillServiceMock.mockResolvedValue({ ok: true, status: 200, data: { billId: VALID_UUID, allocations: [] } });
    const app = await buildApp(editor);
    const res = await app.request(`/utility-bills/${VALID_UUID}/preview`, jsonPost);
    expect(res.status).toBe(200);
    expect(previewUtilityBillServiceMock).toHaveBeenCalled();
  });

  // POST /utility-bills/:id/void — manager-only
  it("POST /utility-bills/:id/void: editor → 403, service not called", async () => {
    voidUtilityBillServiceMock.mockClear();
    const app = await buildApp(editor);
    const res = await app.request(`/utility-bills/${VALID_UUID}/void`, jsonPost);
    expect(res.status).toBe(403);
    expect(voidUtilityBillServiceMock).not.toHaveBeenCalled();
  });
  it("POST /utility-bills/:id/void: manager → 200", async () => {
    voidUtilityBillServiceMock.mockClear();
    voidUtilityBillServiceMock.mockResolvedValue(okData);
    const app = await buildApp(manager);
    // P3 Task 1/3: when ENABLE_PHASE2_BILLING_DOCS is on, the route validates
    // the body against voidReasonBody (reason mandatory, min 3 chars) before
    // calling the service — a body-less/empty-body request now 400s. Send a
    // real reason so this test passes regardless of the flag's ambient state
    // (flag off: the body is ignored and `input` stays undefined either way).
    const res = await app.request(`/utility-bills/${VALID_UUID}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "voided by test" }),
    });
    expect(res.status).toBe(200);
    expect(voidUtilityBillServiceMock).toHaveBeenCalled();
  });

  // GET /allocations/:id — editor-OK; invalid uuid → 400 (before service)
  it("GET /allocations/:id: editor → 200", async () => {
    getAllocationServiceMock.mockClear();
    getAllocationServiceMock.mockResolvedValue({ ok: true, status: 200, data: { id: VALID_UUID, status: "charged" } });
    const app = await buildApp(editor);
    const res = await app.request(`/allocations/${VALID_UUID}`);
    expect(res.status).toBe(200);
    expect(getAllocationServiceMock).toHaveBeenCalled();
  });
  it("GET /allocations/:id: invalid uuid → 400, service not called", async () => {
    getAllocationServiceMock.mockClear();
    const app = await buildApp(editor);
    const res = await app.request(`/allocations/not-a-uuid`);
    expect(res.status).toBe(400);
    expect(getAllocationServiceMock).not.toHaveBeenCalled();
  });
});

// ── GET-by-id detail routes (editor-OK; bad uuid → 400 before service) ────────
// EM-detail / MR-detail / UB-detail: stubbed routes that were never invoked.
describe("meter routes — GET-by-id detail", () => {
  // GET /:id — meter detail
  it("GET /:id (meter detail): editor → 200", async () => {
    getMeterServiceMock.mockClear();
    getMeterServiceMock.mockResolvedValue({ ok: true, status: 200, data: { id: VALID_UUID } });
    const app = await buildApp(editor);
    const res = await app.request(`/${VALID_UUID}`);
    expect(res.status).toBe(200);
    expect(getMeterServiceMock).toHaveBeenCalled();
  });
  it("GET /:id (meter detail): invalid uuid → 400, service not called", async () => {
    getMeterServiceMock.mockClear();
    const app = await buildApp(editor);
    const res = await app.request(`/not-a-uuid`);
    expect(res.status).toBe(400);
    expect(getMeterServiceMock).not.toHaveBeenCalled();
  });

  // GET /readings/:id — reading detail
  it("GET /readings/:id (reading detail): editor → 200", async () => {
    getReadingServiceMock.mockClear();
    getReadingServiceMock.mockResolvedValue({ ok: true, status: 200, data: { id: VALID_UUID } });
    const app = await buildApp(editor);
    const res = await app.request(`/readings/${VALID_UUID}`);
    expect(res.status).toBe(200);
    expect(getReadingServiceMock).toHaveBeenCalled();
  });
  it("GET /readings/:id (reading detail): invalid uuid → 400, service not called", async () => {
    getReadingServiceMock.mockClear();
    const app = await buildApp(editor);
    const res = await app.request(`/readings/not-a-uuid`);
    expect(res.status).toBe(400);
    expect(getReadingServiceMock).not.toHaveBeenCalled();
  });

  // GET /utility-bills/:id — bill detail
  it("GET /utility-bills/:id (bill detail): editor → 200", async () => {
    getUtilityBillServiceMock.mockClear();
    getUtilityBillServiceMock.mockResolvedValue({ ok: true, status: 200, data: { id: VALID_UUID, allocations: [] } });
    const app = await buildApp(editor);
    const res = await app.request(`/utility-bills/${VALID_UUID}`);
    expect(res.status).toBe(200);
    expect(getUtilityBillServiceMock).toHaveBeenCalled();
  });
  it("GET /utility-bills/:id (bill detail): invalid uuid → 400, service not called", async () => {
    getUtilityBillServiceMock.mockClear();
    const app = await buildApp(editor);
    const res = await app.request(`/utility-bills/not-a-uuid`);
    expect(res.status).toBe(400);
    expect(getUtilityBillServiceMock).not.toHaveBeenCalled();
  });
});

// ── Billing-grid RBAC + service wiring ───────────────────────────────────────
const {
  getBillingGridServiceMock,
} = vi.hoisted(() => ({
  getBillingGridServiceMock: vi.fn(),
}));
// Extend the existing vi.mock with the new service (using a fresh mock for the
// describe block — we need to re-import with resetModules each time).

describe("meter routes — billing-grid RBAC", () => {
  beforeEach(() => {
    process.env.ENABLE_PHASE2_METER = "true";
    getBillingGridServiceMock.mockReset();
  });

  it("GET /apartments/:id/billing-grid: editor → 200 when service returns ok", async () => {
    vi.resetModules();
    // Re-register the mock to include getBillingGridService
    vi.mock("../service", () => ({
      listMetersService: listMetersServiceMock,
      chargeUtilityBillService: chargeUtilityBillServiceMock,
      updateMeterService: updateMeterServiceMock,
      setMeterActiveService: setMeterActiveServiceMock,
      updateReadingService: updateReadingServiceMock,
      voidReadingService: voidReadingServiceMock,
      updateUtilityBillService: updateUtilityBillServiceMock,
      previewUtilityBillService: previewUtilityBillServiceMock,
      voidUtilityBillService: voidUtilityBillServiceMock,
      getAllocationService: getAllocationServiceMock,
      getMeterService: getMeterServiceMock,
      getReadingService: getReadingServiceMock,
      getUtilityBillService: getUtilityBillServiceMock,
      listReadingsService: listReadingsServiceMock,
      listUtilityBillsService: listUtilityBillsServiceMock,
      getBillingGridService: getBillingGridServiceMock,
      setTenancyPaxService: setTenancyPaxServiceMock,
      createMeterService: vi.fn(),
      createReadingService: vi.fn(),
      createUtilityBillService: vi.fn(),
    }));
    getBillingGridServiceMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: { apartment: { id: VALID_UUID, unitCode: "A-1", propertyName: "P" }, period: "2026-06-01", rooms: [], bill: null },
    });
    const { meterRoutes } = await import("../routes");
    const app = makeApp(editor); app.route("/", meterRoutes);
    const res = await app.request(`/apartments/${VALID_UUID}/billing-grid?period=2026-06-01`);
    expect(res.status).toBe(200);
    expect(getBillingGridServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      VALID_UUID,
      "2026-06-01",
    );
  });

  it("GET /apartments/:id/billing-grid: viewer/no-session → 401", async () => {
    vi.resetModules();
    const { meterRoutes } = await import("../routes");
    const app = makeApp(null); app.route("/", meterRoutes);
    const res = await app.request(`/apartments/${VALID_UUID}/billing-grid`);
    expect(res.status).toBe(401);
  });

  it("GET /apartments/:id/billing-grid: service 404 → 404", async () => {
    vi.resetModules();
    getBillingGridServiceMock.mockResolvedValue({ ok: false, status: 404, error: "APARTMENT_NOT_FOUND" });
    const { meterRoutes } = await import("../routes");
    const app = makeApp(editor); app.route("/", meterRoutes);
    const res = await app.request(`/apartments/${VALID_UUID}/billing-grid`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "APARTMENT_NOT_FOUND" });
  });

  it("flag OFF → 404", async () => {
    delete process.env.ENABLE_PHASE2_METER;
    vi.resetModules();
    const { meterRoutes } = await import("../routes");
    const app = makeApp(editor); app.route("/", meterRoutes);
    const res = await app.request(`/apartments/${VALID_UUID}/billing-grid`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("org-scope: service called with correct session (verifies session is threaded)", async () => {
    vi.resetModules();
    getBillingGridServiceMock.mockResolvedValue({ ok: true, status: 200, data: { apartment: { id: VALID_UUID, unitCode: null, propertyName: null }, period: "2026-06-01", rooms: [], bill: null } });
    const { meterRoutes } = await import("../routes");
    const customSession: SessionPayload = { userId: "u-org-b", orgId: "org-b", role: "editor", userType: "operator" };
    const app = makeApp(customSession); app.route("/", meterRoutes);
    await app.request(`/apartments/${VALID_UUID}/billing-grid?period=2026-06-01`);
    const callSession = getBillingGridServiceMock.mock.calls[0]?.[0];
    expect(callSession?.orgId).toBe("org-b");
  });
});

// ── List routes must NOT be shadowed by the bare "/:id" route. Hono matches in
// REGISTRATION ORDER, so "/:id" must be registered AFTER "/readings" and
// "/utility-bills". Regression for the bug where GET /utility-bills matched
// "/:id" (id="utility-bills") → 400 "Invalid id" and the Bills/Readings tabs
// rendered empty despite data existing. ──────────────────────────────────────
describe("meter routes — list routes not shadowed by /:id", () => {
  it("GET /utility-bills (list): editor → 200 via list service, NOT the /:id detail route", async () => {
    listUtilityBillsServiceMock.mockClear();
    getMeterServiceMock.mockClear();
    listUtilityBillsServiceMock.mockResolvedValue({ ok: true, status: 200, data: { data: [], nextCursor: null } });
    const app = await buildApp(editor);
    const res = await app.request(`/utility-bills`);
    expect(res.status).toBe(200);
    expect(listUtilityBillsServiceMock).toHaveBeenCalled();
    expect(getMeterServiceMock).not.toHaveBeenCalled(); // would fire if "/:id" shadowed the list
  });
  it("GET /readings (list): editor → 200 via list service, NOT the /:id detail route", async () => {
    listReadingsServiceMock.mockClear();
    getMeterServiceMock.mockClear();
    listReadingsServiceMock.mockResolvedValue({ ok: true, status: 200, data: { data: [], nextCursor: null } });
    const app = await buildApp(editor);
    const res = await app.request(`/readings?status=all`);
    expect(res.status).toBe(200);
    expect(listReadingsServiceMock).toHaveBeenCalled();
    expect(getMeterServiceMock).not.toHaveBeenCalled();
  });
});
