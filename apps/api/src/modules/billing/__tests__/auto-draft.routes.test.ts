import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Mock the service so the DB is never reached — routes tested in isolation.
vi.mock("../auto-draft.service", () => ({
  getDraftConfigService: vi.fn(),
  createDraftConfigService: vi.fn(),
  patchDraftConfigService: vi.fn(),
  triggerRunService: vi.fn(),
  listDraftRunsService: vi.fn(),
  getDraftRunService: vi.fn(),
  listDraftInvoicesService: vi.fn(),
  getDraftInvoiceService: vi.fn(),
  editInvoiceDatesService: vi.fn(),
  attachChargeService: vi.fn(),
  detachChargeService: vi.fn(),
  editDraftChargeAmountService: vi.fn(),
  approveInvoiceService: vi.fn(),
  approveBulkService: vi.fn(),
  voidInvoiceService: vi.fn(),
}));

import { autoDraftRoutes } from "../auto-draft.routes";
import {
  getDraftConfigService,
  createDraftConfigService,
  patchDraftConfigService,
  triggerRunService,
  listDraftRunsService,
  getDraftRunService,
  listDraftInvoicesService,
  approveInvoiceService,
  approveBulkService,
  voidInvoiceService,
} from "../auto-draft.service";

// ── fixtures ──────────────────────────────────────────────────────────────────

const INVOICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONFIG_ID  = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHARGE_ID  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UPDATED_AT = "2026-06-01T00:00:00.000Z";
const BUMPED_AT  = "2026-06-02T00:00:00.000Z";
const PERIOD     = "2026-06";

const adminSession:   SessionPayload = { userId: "u1", orgId: "o1", role: "admin",   userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession:  SessionPayload = { userId: "u3", orgId: "o1", role: "editor",  userType: "operator" };

const configRow = {
  id: CONFIG_ID, runDayOfMonth: 25, billPeriodOffset: 1, autoBillDayOfMonth: null,
  dueDayOffset: null,
  includeRent: true, includeElectricity: true, includeMgmtFee: true, includeCleaning: true,
  autoApprove: false, isActive: true, updatedAt: UPDATED_AT,
};

const invoiceRow = {
  id: INVOICE_ID, invoiceNumber: "INV-001", invoiceType: "tenant_rental",
  status: "draft", partyName: "Alice", tenancyCode: "T-001",
  periodMonth: "2026-06-01T00:00:00.000Z", invoiceDate: "2026-06-01T00:00:00.000Z",
  dueDate: null, totalAmount: 1000, sstAmount: null, updatedAt: UPDATED_AT,
  unitCode: "A-01-01", propertyName: "Kaen Residence",
};

const runSummary = {
  runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  status: "completed" as const, draftsCreated: 2, draftsSkipped: 0, errorText: null,
};

const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const runRow = {
  id: RUN_ID, periodMonth: "2026-06-01T00:00:00.000Z", runDate: "2026-06-01T00:00:00.000Z",
  status: "completed", draftsCreated: 3, draftsSkipped: 1, errorText: null,
  triggeredBy: "system:auto-draft", createdAt: "2026-06-01T00:00:00.000Z",
};

// ── helpers ───────────────────────────────────────────────────────────────────

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", autoDraftRoutes);
  return app;
}

function req(
  session: SessionPayload | null,
  method: string,
  path: string,
  body?: unknown,
) {
  return makeApp(session).request(path, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
  });
}

// ── flag + setup ──────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.ENABLE_PHASE2_AUTODRAFT = "1";
});

afterAll(() => {
  delete process.env.ENABLE_PHASE2_AUTODRAFT;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDraftConfigService).mockResolvedValue({ ok: true, status: 200, data: configRow });
  vi.mocked(createDraftConfigService).mockResolvedValue({ ok: true, status: 201, data: configRow });
  vi.mocked(patchDraftConfigService).mockResolvedValue({ ok: true, status: 200, data: { ...configRow, updatedAt: BUMPED_AT } });
  vi.mocked(triggerRunService).mockResolvedValue({ ok: true, status: 200, data: runSummary });
  vi.mocked(listDraftRunsService).mockResolvedValue({ ok: true, status: 200, data: { items: [runRow], total: 1 } });
  vi.mocked(getDraftRunService).mockResolvedValue({ ok: true, status: 200, data: runRow });
  vi.mocked(listDraftInvoicesService).mockResolvedValue({ ok: true, status: 200, data: { items: [invoiceRow], total: 1 } });
  vi.mocked(approveInvoiceService).mockResolvedValue({ ok: true, status: 200, data: { id: INVOICE_ID } });
  vi.mocked(approveBulkService).mockResolvedValue({ ok: true, status: 200, data: { approved: [INVOICE_ID], skipped: [] } });
  vi.mocked(voidInvoiceService).mockResolvedValue({ ok: true, status: 200, data: { id: INVOICE_ID } });
});

// ── (a) flag OFF → any route 404 ─────────────────────────────────────────────

describe("flag gate", () => {
  it("returns 404 on every route when ENABLE_PHASE2_AUTODRAFT is off", async () => {
    delete process.env.ENABLE_PHASE2_AUTODRAFT;
    try {
      const res = await req(adminSession, "GET", "/draft-config");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(getDraftConfigService).not.toHaveBeenCalled();

      // Also confirm a different route is blocked
      const res2 = await req(editorSession, "GET", "/invoices");
      expect(res2.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_AUTODRAFT = "1";
    }
  });
});

// ── (b) editor GET queue 200 / POST approve 403 ───────────────────────────────

describe("RBAC: editor role", () => {
  it("GET /invoices?status=draft → 200 for editor", async () => {
    const res = await req(editorSession, "GET", "/invoices?status=draft");
    expect(res.status).toBe(200);
    expect(listDraftInvoicesService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u3", actorRole: "editor" }),
      expect.objectContaining({ status: "draft" }),
    );
  });

  it("POST /invoices/:id/approve → 403 for editor (manager+)", async () => {
    const res = await req(editorSession, "POST", `/invoices/${INVOICE_ID}/approve`, {
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(res.status).toBe(403);
    expect(approveInvoiceService).not.toHaveBeenCalled();
  });

  it("POST /invoices/approve-bulk → 403 for editor", async () => {
    const res = await req(editorSession, "POST", "/invoices/approve-bulk", {
      ids: [INVOICE_ID],
    });
    expect(res.status).toBe(403);
    expect(approveBulkService).not.toHaveBeenCalled();
  });

  it("GET /draft-config → 200 for editor", async () => {
    const res = await req(editorSession, "GET", "/draft-config");
    expect(res.status).toBe(200);
  });

  it("POST /draft-config → 403 for editor (admin-only)", async () => {
    const res = await req(editorSession, "POST", "/draft-config", { runDayOfMonth: 20 });
    expect(res.status).toBe(403);
    expect(createDraftConfigService).not.toHaveBeenCalled();
  });
});

// ── (c) manager approve → 200; admin-only config POST → 403 for manager ──────

describe("RBAC: manager role", () => {
  it("POST /invoices/:id/approve → 200 for manager (service mocked ok)", async () => {
    const res = await req(managerSession, "POST", `/invoices/${INVOICE_ID}/approve`, {
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(res.status).toBe(200);
    expect(approveInvoiceService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2", actorRole: "manager" }),
      INVOICE_ID,
      UPDATED_AT,
    );
  });

  it("POST /invoices/approve-bulk → 200 for manager", async () => {
    const res = await req(managerSession, "POST", "/invoices/approve-bulk", {
      ids: [INVOICE_ID],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { approved: string[]; skipped: string[] };
    expect(json.approved).toContain(INVOICE_ID);
    expect(json.skipped).toHaveLength(0);
  });

  it("POST /draft-config → 403 for manager (admin-only)", async () => {
    const res = await req(managerSession, "POST", "/draft-config", { runDayOfMonth: 20 });
    expect(res.status).toBe(403);
    expect(createDraftConfigService).not.toHaveBeenCalled();
  });

  it("PATCH /draft-config/:id → 403 for manager (admin-only)", async () => {
    const res = await req(managerSession, "PATCH", `/draft-config/${CONFIG_ID}`, {
      runDayOfMonth: 20,
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(res.status).toBe(403);
    expect(patchDraftConfigService).not.toHaveBeenCalled();
  });

  it("POST /draft-runs → 200 for manager (trigger role=manager)", async () => {
    const res = await req(managerSession, "POST", "/draft-runs", { periodMonth: PERIOD });
    expect(res.status).toBe(200);
    const json = (await res.json()) as typeof runSummary;
    expect(json.draftsCreated).toBe(2);
    expect(triggerRunService).toHaveBeenCalledWith(
      expect.objectContaining({ actorRole: "manager" }),
      PERIOD,
    );
  });
});

// ── (d) admin POST draft-config → 200/201 ────────────────────────────────────

describe("RBAC: admin role", () => {
  it("POST /draft-config → 201 for admin", async () => {
    const res = await req(adminSession, "POST", "/draft-config", { runDayOfMonth: 25 });
    expect(res.status).toBe(201);
    const json = (await res.json()) as typeof configRow;
    expect(json.runDayOfMonth).toBe(25);
    expect(createDraftConfigService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      expect.objectContaining({ runDayOfMonth: 25 }),
    );
  });

  it("PATCH /draft-config/:id → 200 for admin", async () => {
    const res = await req(adminSession, "PATCH", `/draft-config/${CONFIG_ID}`, {
      runDayOfMonth: 20,
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(res.status).toBe(200);
    expect(patchDraftConfigService).toHaveBeenCalledWith(
      expect.objectContaining({ actorRole: "admin" }),
      CONFIG_ID,
      expect.objectContaining({ runDayOfMonth: 20, expectedUpdatedAt: UPDATED_AT }),
    );
  });
});

// ── (e) PATCH config stale → 409 ─────────────────────────────────────────────

describe("ServiceResult passthrough", () => {
  it("PATCH /draft-config/:id with stale updatedAt → 409 from service", async () => {
    vi.mocked(patchDraftConfigService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Record changed since you loaded it",
    });
    const res = await req(adminSession, "PATCH", `/draft-config/${CONFIG_ID}`, {
      runDayOfMonth: 20,
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Record changed since you loaded it" });
  });

  it("POST /invoices/:id/void with service 409 (non-voidable state) → 409", async () => {
    vi.mocked(voidInvoiceService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Invoice not voidable from its current state or changed since loaded",
    });
    const res = await req(managerSession, "POST", `/invoices/${INVOICE_ID}/void`, {
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(res.status).toBe(409);
  });
});

// ── (f) POST /draft-runs returns run summary ──────────────────────────────────

describe("POST /draft-runs (manual trigger)", () => {
  it("manager POST returns the mocked run summary", async () => {
    const res = await req(managerSession, "POST", "/draft-runs", { periodMonth: PERIOD });
    expect(res.status).toBe(200);
    const json = (await res.json()) as typeof runSummary;
    expect(json.runId).toBe(runSummary.runId);
    expect(json.status).toBe("completed");
    expect(json.draftsCreated).toBe(2);
    expect(json.draftsSkipped).toBe(0);
  });

  it("editor POST /draft-runs → 403 (manager-only)", async () => {
    const res = await req(editorSession, "POST", "/draft-runs", { periodMonth: PERIOD });
    expect(res.status).toBe(403);
    expect(triggerRunService).not.toHaveBeenCalled();
  });
});

// ── GET /draft-runs (list) + GET /draft-runs/:id (detail) ─────────────────────

describe("GET /draft-runs (run ledger list)", () => {
  it("editor GET → 200 with items + total; filter + pagination params reach the service", async () => {
    const res = await req(editorSession, "GET", `/draft-runs?status=completed&periodMonth=${PERIOD}&limit=5&offset=10`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: typeof runRow[]; total: number };
    expect(json.total).toBe(1);
    expect(json.items[0]!.id).toBe(RUN_ID);
    // The validated query (filters + coerced pagination) reaches the service.
    expect(listDraftRunsService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u3", actorRole: "editor" }),
      expect.objectContaining({ status: "completed", periodMonth: PERIOD, limit: 5, offset: 10 }),
    );
  });

  it("defaults pagination (limit:20, offset:0) when not supplied", async () => {
    const res = await req(editorSession, "GET", "/draft-runs");
    expect(res.status).toBe(200);
    expect(listDraftRunsService).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 20, offset: 0 }),
    );
  });

  it("invalid status enum → 400 (Zod), service not called", async () => {
    const res = await req(editorSession, "GET", "/draft-runs?status=bogus");
    expect(res.status).toBe(400);
    expect(listDraftRunsService).not.toHaveBeenCalled();
  });

  it("returns 404 when the feature flag is off", async () => {
    delete process.env.ENABLE_PHASE2_AUTODRAFT;
    try {
      const res = await req(editorSession, "GET", "/draft-runs");
      expect(res.status).toBe(404);
      expect(listDraftRunsService).not.toHaveBeenCalled();
    } finally {
      process.env.ENABLE_PHASE2_AUTODRAFT = "1";
    }
  });
});

describe("GET /draft-runs/:id (run detail)", () => {
  it("editor GET → 200 with the mapped run row", async () => {
    const res = await req(editorSession, "GET", `/draft-runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as typeof runRow;
    expect(json.id).toBe(RUN_ID);
    expect(json.draftsCreated).toBe(3);
    expect(getDraftRunService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u3", actorRole: "editor" }),
      RUN_ID,
    );
  });

  it("returns 404 when the service reports the run is not found", async () => {
    vi.mocked(getDraftRunService).mockResolvedValueOnce({ ok: false, status: 404, error: "Draft run not found" });
    const res = await req(editorSession, "GET", `/draft-runs/${RUN_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Draft run not found" });
  });

  it("returns 404 when the feature flag is off", async () => {
    delete process.env.ENABLE_PHASE2_AUTODRAFT;
    try {
      const res = await req(editorSession, "GET", `/draft-runs/${RUN_ID}`);
      expect(res.status).toBe(404);
      expect(getDraftRunService).not.toHaveBeenCalled();
    } finally {
      process.env.ENABLE_PHASE2_AUTODRAFT = "1";
    }
  });
});

// ── (g) Zod-invalid body → 400 ───────────────────────────────────────────────

describe("Zod validation → 400", () => {
  it("POST /draft-runs with missing periodMonth → 400", async () => {
    const res = await req(managerSession, "POST", "/draft-runs", {});
    expect(res.status).toBe(400);
    expect(triggerRunService).not.toHaveBeenCalled();
  });

  it("POST /draft-runs with invalid periodMonth format → 400", async () => {
    const res = await req(managerSession, "POST", "/draft-runs", { periodMonth: "2026/06" });
    expect(res.status).toBe(400);
    expect(triggerRunService).not.toHaveBeenCalled();
  });

  it("POST /invoices/approve-bulk with empty ids array → 400", async () => {
    const res = await req(managerSession, "POST", "/invoices/approve-bulk", { ids: [] });
    expect(res.status).toBe(400);
    expect(approveBulkService).not.toHaveBeenCalled();
  });

  it("POST /draft-config with runDayOfMonth out of range (> 28) → 400", async () => {
    const res = await req(adminSession, "POST", "/draft-config", { runDayOfMonth: 31 });
    expect(res.status).toBe(400);
    expect(createDraftConfigService).not.toHaveBeenCalled();
  });

  it("PATCH /draft-config/:id missing expectedUpdatedAt → 400", async () => {
    const res = await req(adminSession, "PATCH", `/draft-config/${CONFIG_ID}`, {
      runDayOfMonth: 20,
    });
    expect(res.status).toBe(400);
    expect(patchDraftConfigService).not.toHaveBeenCalled();
  });
});

// ── route order: approve-bulk before :id/approve ─────────────────────────────

describe("route order: /invoices/approve-bulk not captured as :id", () => {
  it("POST /invoices/approve-bulk hits approveBulkService, not approveInvoiceService", async () => {
    const res = await req(managerSession, "POST", "/invoices/approve-bulk", {
      ids: [INVOICE_ID],
    });
    expect(res.status).toBe(200);
    expect(approveBulkService).toHaveBeenCalled();
    expect(approveInvoiceService).not.toHaveBeenCalled();
  });
});

// ── 401 for missing session ───────────────────────────────────────────────────

describe("auth: missing session", () => {
  it("GET /draft-config with no session → 401", async () => {
    const res = await req(null, "GET", "/draft-config");
    expect(res.status).toBe(401);
  });
});
