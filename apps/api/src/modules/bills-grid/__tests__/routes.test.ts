import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// The router imports its services eagerly; stub ALL of them so RBAC + the
// Result→HTTP mapping is what these tests measure (never the DB). Mirrors
// meter/__tests__/routes.test.ts.
const {
  getGridServiceMock,
  saveEntryServiceMock,
  updateLinesServiceMock,
  billServiceMock,
  getBearerConfigServiceMock,
  setBearerConfigServiceMock,
  createExpensesServiceMock,
  listExpensesServiceMock,
  updateExpenseServiceMock,
  voidExpenseServiceMock,
  saveReadingsServiceMock,
  uploadAttachmentServiceMock,
  listAttachmentsServiceMock,
  deleteAttachmentServiceMock,
  uploadLineAttachmentServiceMock,
  listLineAttachmentServiceMock,
} = vi.hoisted(() => ({
  getGridServiceMock: vi.fn(),
  saveEntryServiceMock: vi.fn(),
  updateLinesServiceMock: vi.fn(),
  billServiceMock: vi.fn(),
  getBearerConfigServiceMock: vi.fn(),
  setBearerConfigServiceMock: vi.fn(),
  createExpensesServiceMock: vi.fn(),
  listExpensesServiceMock: vi.fn(),
  updateExpenseServiceMock: vi.fn(),
  voidExpenseServiceMock: vi.fn(),
  saveReadingsServiceMock: vi.fn(),
  uploadAttachmentServiceMock: vi.fn(),
  listAttachmentsServiceMock: vi.fn(),
  deleteAttachmentServiceMock: vi.fn(),
  uploadLineAttachmentServiceMock: vi.fn(),
  listLineAttachmentServiceMock: vi.fn(),
}));
vi.mock("../service", () => ({
  getGridService: getGridServiceMock,
  saveEntryService: saveEntryServiceMock,
  updateLinesService: updateLinesServiceMock,
  billService: billServiceMock,
  getBearerConfigService: getBearerConfigServiceMock,
  setBearerConfigService: setBearerConfigServiceMock,
  createExpensesService: createExpensesServiceMock,
  listExpensesService: listExpensesServiceMock,
  updateExpenseService: updateExpenseServiceMock,
  voidExpenseService: voidExpenseServiceMock,
  saveReadingsService: saveReadingsServiceMock,
  uploadAttachmentService: uploadAttachmentServiceMock,
  listAttachmentsService: listAttachmentsServiceMock,
  deleteAttachmentService: deleteAttachmentServiceMock,
  uploadLineAttachmentService: uploadLineAttachmentServiceMock,
  listLineAttachmentService: listLineAttachmentServiceMock,
}));

// meter/__tests__/routes.test.ts:61-65 — the only session-injection pattern that works.
function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => { if (session) c.set("session", session); await next(); });
  return app;
}
const editor: SessionPayload = { userId: "u1", orgId: "o1", role: "editor", userType: "operator" };
const manager: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
// `viewer` is not in require-role.ts's VALID_ROLES ({admin, manager, editor}) → 403.
const viewer = { userId: "u3", orgId: "o1", role: "viewer", userType: "operator" } as unknown as SessionPayload;

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const VALID_ROW = { apartmentId: VALID_UUID, expectedUpdatedAt: "2026-07-10T00:00:00.000Z" };
const BILL_BODY = JSON.stringify({ period: "2026-07-01", rows: [VALID_ROW] });
const SAVE_BODY = JSON.stringify({ period: "2026-07-01" });
const LINES_BODY = JSON.stringify({
  tnbPattern: "recharged", airPattern: "recharged",
  cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
});
const BEARER_BODY = JSON.stringify({
  tnbPattern: "recharged", airPattern: "recharged",
  cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
  cleaningRecurringAmount: "100.00",
});
const EXPENSE_BODY = JSON.stringify({
  apartmentId: VALID_UUID, billingMonth: "2026-07-01", bearer: "owner",
  items: [{ description: "Repair", amount: "10.00", withSST: false }],
});
const READINGS_BODY = JSON.stringify({
  period: "2026-07-01",
  readings: [{ listingId: VALID_UUID, tenancyId: null, partyId: null, previousKwh: null, currentKwh: null, amount: null }],
});
const json = (method: "POST" | "PUT" | "PATCH", body: string): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body });
const del: RequestInit = { method: "DELETE" };
const ok = (data: unknown, status = 200) => ({ ok: true as const, status, data });
const errR = (status: number, error: string) => ({ ok: false as const, status, error });

/** Boot the router with the flag ON and the given session mounted. */
async function buildApp(session: SessionPayload | null) {
  process.env.ENABLE_PHASE2_BILLS_GRID = "true";
  vi.resetModules();
  const { billsGridRoutes } = await import("../routes");
  const app = makeApp(session);
  app.route("/", billsGridRoutes);
  return app;
}

afterEach(() => { delete process.env.ENABLE_PHASE2_BILLS_GRID; vi.clearAllMocks(); });

// ── 1. Flag gate PRECEDES requireRole ────────────────────────────────────────
describe("bills-grid routes — flag gate before RBAC", () => {
  it("flag off: an unauthenticated GET returns the canonical 404 before requireRole", async () => {
    delete process.env.ENABLE_PHASE2_BILLS_GRID;
    vi.resetModules();
    const { billsGridRoutes } = await import("../routes");
    const app = makeApp(null); // no session at all
    app.route("/", billsGridRoutes);
    const res = await app.request("/");
    expect(res.status).toBe(404); // not 401 — the surface does not exist while dark
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("flag off: even a valid manager POST /bill is 404 (surface absent)", async () => {
    delete process.env.ENABLE_PHASE2_BILLS_GRID;
    vi.resetModules();
    const { billsGridRoutes } = await import("../routes");
    const app = makeApp(manager); app.route("/", billsGridRoutes);
    const res = await app.request("/bill", json("POST", BILL_BODY));
    expect(res.status).toBe(404);
    expect(billServiceMock).not.toHaveBeenCalled();
  });

  it("flag on + no session: 401", async () => {
    const app = await buildApp(null);
    const res = await app.request("/");
    expect(res.status).toBe(401);
  });
});

// ── 2. RBAC — editor allowed on read/save; editor 403 on Bill/bearer/void ─────
describe("bills-grid routes — RBAC matrix", () => {
  it("editor allowed on read: GET / → 200, getGridService runs", async () => {
    getGridServiceMock.mockResolvedValue(ok({ period: "2026-07-01", periods: [], rows: [] }));
    const app = await buildApp(editor);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(getGridServiceMock).toHaveBeenCalled();
  });

  it("editor allowed on Save: PUT /apartments/:id/entries → 200", async () => {
    saveEntryServiceMock.mockResolvedValue(ok({ id: VALID_UUID, updatedAt: "x" }));
    const app = await buildApp(editor);
    const res = await app.request(`/apartments/${VALID_UUID}/entries`, json("PUT", SAVE_BODY));
    expect(res.status).toBe(200);
    expect(saveEntryServiceMock).toHaveBeenCalled();
  });

  it("editor allowed on expense create: POST /expenses → 201", async () => {
    createExpensesServiceMock.mockResolvedValue(ok({ ids: [VALID_UUID], total: "10.00" }, 201));
    const app = await buildApp(editor);
    const res = await app.request("/expenses", json("POST", EXPENSE_BODY));
    expect(res.status).toBe(201);
    expect(createExpensesServiceMock).toHaveBeenCalled();
  });

  it("editor allowed on reading write: PUT /apartments/:id/meter-readings → 200", async () => {
    saveReadingsServiceMock.mockResolvedValue(ok({ results: [] }));
    const app = await buildApp(editor);
    const res = await app.request(`/apartments/${VALID_UUID}/meter-readings`, json("PUT", READINGS_BODY));
    expect(res.status).toBe(200);
    expect(saveReadingsServiceMock).toHaveBeenCalled();
  });

  it("editor allowed to READ bearer-config: GET → 200", async () => {
    getBearerConfigServiceMock.mockResolvedValue(ok({ apartmentId: VALID_UUID, isLocked: false }));
    const app = await buildApp(editor);
    const res = await app.request(`/apartments/${VALID_UUID}/bearer-config`);
    expect(res.status).toBe(200);
    expect(getBearerConfigServiceMock).toHaveBeenCalled();
  });

  it("editor cannot bill: POST /bill → 403 Forbidden, service never runs", async () => {
    const app = await buildApp(editor);
    const res = await app.request("/bill", json("POST", BILL_BODY));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(billServiceMock).not.toHaveBeenCalled();
  });

  it("editor cannot write bearer-config: PUT → 403, service never runs", async () => {
    const app = await buildApp(editor);
    const res = await app.request(`/apartments/${VALID_UUID}/bearer-config`, json("PUT", BEARER_BODY));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(setBearerConfigServiceMock).not.toHaveBeenCalled();
  });

  it("editor cannot patch line settings: PATCH /entries/:id/lines → 403 (manager-gated)", async () => {
    const app = await buildApp(editor);
    const res = await app.request(`/entries/${VALID_UUID}/lines`, json("PATCH", LINES_BODY));
    expect(res.status).toBe(403);
    expect(updateLinesServiceMock).not.toHaveBeenCalled();
  });

  it("editor cannot void an expense: POST /expenses/:id/void → 403, service never runs", async () => {
    const app = await buildApp(editor);
    const res = await app.request(`/expenses/${VALID_UUID}/void`, json("POST", "{}"));
    expect(res.status).toBe(403);
    expect(voidExpenseServiceMock).not.toHaveBeenCalled();
  });

  it("editor cannot delete an attachment: DELETE → 403, service never runs", async () => {
    const app = await buildApp(editor);
    const res = await app.request(`/apartments/${VALID_UUID}/attachments/${VALID_UUID}`, del);
    expect(res.status).toBe(403);
    expect(deleteAttachmentServiceMock).not.toHaveBeenCalled();
  });

  it("manager can bill: 200 with the per-row manifest", async () => {
    billServiceMock.mockResolvedValue(ok({ results: [{ apartmentId: VALID_UUID, outcome: "billed" }] }));
    const app = await buildApp(manager);
    const res = await app.request("/bill", json("POST", BILL_BODY));
    expect(res.status).toBe(200);
    expect(billServiceMock).toHaveBeenCalled();
  });

  it("manager can write bearer-config: PUT → 200", async () => {
    setBearerConfigServiceMock.mockResolvedValue(ok({ id: VALID_UUID, isLocked: true, updatedAt: "x" }));
    const app = await buildApp(manager);
    const res = await app.request(`/apartments/${VALID_UUID}/bearer-config`, json("PUT", BEARER_BODY));
    expect(res.status).toBe(200);
    expect(setBearerConfigServiceMock).toHaveBeenCalled();
  });

  it("manager can patch line settings: PATCH /entries/:id/lines → 200", async () => {
    updateLinesServiceMock.mockResolvedValue(ok({ id: VALID_UUID, updatedAt: "x" }));
    const app = await buildApp(manager);
    const res = await app.request(`/entries/${VALID_UUID}/lines`, json("PATCH", LINES_BODY));
    expect(res.status).toBe(200);
    expect(updateLinesServiceMock).toHaveBeenCalled();
  });

  it("manager can void an expense: POST /expenses/:id/void → 200", async () => {
    voidExpenseServiceMock.mockResolvedValue(ok({ id: VALID_UUID }));
    const app = await buildApp(manager);
    const res = await app.request(`/expenses/${VALID_UUID}/void`, json("POST", "{}"));
    expect(res.status).toBe(200);
    expect(voidExpenseServiceMock).toHaveBeenCalled();
  });

  it("manager can delete an attachment: DELETE → 200 {ok:true}", async () => {
    deleteAttachmentServiceMock.mockResolvedValue(ok({ id: VALID_UUID }));
    const app = await buildApp(manager);
    const res = await app.request(`/apartments/${VALID_UUID}/attachments/${VALID_UUID}`, del);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteAttachmentServiceMock).toHaveBeenCalled();
  });

  it("viewer 403: a role outside VALID_ROLES is Forbidden on a write endpoint", async () => {
    const app = await buildApp(viewer);
    const bill = await app.request("/bill", json("POST", BILL_BODY));
    expect(bill.status).toBe(403);
    expect(await bill.json()).toEqual({ error: "Forbidden" });
    expect(billServiceMock).not.toHaveBeenCalled();

    // Also 403 on an editor-gated endpoint, where role *rank* would not block it:
    // require-role.ts rejects any role absent from VALID_ROLES before atLeast().
    const save = await app.request(`/apartments/${VALID_UUID}/entries`, json("PUT", SAVE_BODY));
    expect(save.status).toBe(403);
    expect(saveEntryServiceMock).not.toHaveBeenCalled();
  });
});

// ── 3. Validation — 400 Zod (bills-grid labels) + 400 bad path UUID ──────────
describe("bills-grid routes — 400 validation", () => {
  it("Zod 400 uses the bills-grid label map, not the raw path", async () => {
    const app = await buildApp(editor);
    const res = await app.request(
      `/apartments/${VALID_UUID}/entries`,
      json("PUT", JSON.stringify({ period: "2026-07-01", tnbTotal: "=SUM(A1)" })),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    // "TNB total" proves DOMAIN_FIELD_LABELS["bills-grid"].tnbTotal is wired
    // (the "tenancy" domain's empty map would echo the raw "tnbTotal").
    expect(body.fieldErrors.tnbTotal).toMatch(/TNB total/);
    expect(saveEntryServiceMock).not.toHaveBeenCalled();
  });

  it("Invalid id: a malformed path UUID is 400 before the body is parsed", async () => {
    const app = await buildApp(manager);
    const res = await app.request("/entries/not-a-uuid/lines", json("PATCH", "{}"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid id" });
    expect(updateLinesServiceMock).not.toHaveBeenCalled();
  });
});

// ── 4. Result→HTTP mapping is faithful; there is NO 422 anywhere ─────────────
describe("bills-grid routes — Result→HTTP mapping (no 422)", () => {
  it("saveEntry 409 STALE → 409", async () => {
    saveEntryServiceMock.mockResolvedValue(errR(409, "STALE"));
    const app = await buildApp(editor);
    const res = await app.request(`/apartments/${VALID_UUID}/entries`, json("PUT", SAVE_BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "STALE" });
  });

  it("saveEntry 404 APARTMENT_NOT_FOUND → 404", async () => {
    saveEntryServiceMock.mockResolvedValue(errR(404, "APARTMENT_NOT_FOUND"));
    const app = await buildApp(editor);
    const res = await app.request(`/apartments/${VALID_UUID}/entries`, json("PUT", SAVE_BODY));
    expect(res.status).toBe(404);
  });

  it("updateLines 409 ENTRY_LOCKED → 409", async () => {
    updateLinesServiceMock.mockResolvedValue(errR(409, "ENTRY_LOCKED"));
    const app = await buildApp(manager);
    const res = await app.request(`/entries/${VALID_UUID}/lines`, json("PATCH", LINES_BODY));
    expect(res.status).toBe(409);
  });

  it("createExpenses 409 ENTRY_LOCKED → 409", async () => {
    createExpensesServiceMock.mockResolvedValue(errR(409, "ENTRY_LOCKED"));
    const app = await buildApp(editor);
    const res = await app.request("/expenses", json("POST", EXPENSE_BODY));
    expect(res.status).toBe(409);
  });

  it("deleteAttachment 502 ATTACHMENT_DELETE_FAILED → 502", async () => {
    deleteAttachmentServiceMock.mockResolvedValue(errR(502, "ATTACHMENT_DELETE_FAILED"));
    const app = await buildApp(manager);
    const res = await app.request(`/apartments/${VALID_UUID}/attachments/${VALID_UUID}`, del);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "ATTACHMENT_DELETE_FAILED" });
  });

  it("Bill with a failed row stays 200 (per-row manifest, never 422)", async () => {
    billServiceMock.mockResolvedValue(ok({
      results: [{ apartmentId: VALID_UUID, outcome: "compute_error", code: "AIRCON_EXCEEDS_TNB" }],
    }));
    const app = await buildApp(manager);
    const res = await app.request("/bill", json("POST", BILL_BODY));
    expect(res.status).toBe(200); // NOT 422 — compute failure is a row outcome, not a status
    const body = await res.json();
    expect(body.results[0].outcome).toBe("compute_error");
  });
});

// ── 5. Attachment upload (multipart) — editor-OK, 201, service wired ─────────
describe("bills-grid routes — attachment upload", () => {
  it("editor upload with files + ?period → 201, service called per file", async () => {
    uploadAttachmentServiceMock.mockResolvedValue(ok({ id: VALID_UUID, storageKey: "k" }, 201));
    const app = await buildApp(editor);
    const fd = new FormData();
    fd.append("files", new File(["pdf-bytes"], "tnb.pdf", { type: "application/pdf" }));
    const res = await app.request(`/apartments/${VALID_UUID}/attachments?period=2026-07-01`, { method: "POST", body: fd });
    expect(res.status).toBe(201);
    expect(uploadAttachmentServiceMock).toHaveBeenCalled();
  });

  it("upload with no files → 400 Invalid form body, service not called", async () => {
    const app = await buildApp(editor);
    const fd = new FormData();
    const res = await app.request(`/apartments/${VALID_UUID}/attachments?period=2026-07-01`, { method: "POST", body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid form body" });
    expect(uploadAttachmentServiceMock).not.toHaveBeenCalled();
  });
});

// ── 6. Per-line attachments (T1) — POST/GET /expenses/:expenseId/attachments ─
describe("bills-grid routes — per-line attachment upload/list", () => {
  it("editor upload with files → 201, uploadLineAttachmentService called per file", async () => {
    uploadLineAttachmentServiceMock.mockResolvedValue(ok({ id: VALID_UUID, storageKey: "k" }, 201));
    const app = await buildApp(editor);
    const fd = new FormData();
    fd.append("files", new File(["pdf-bytes"], "tnb.pdf", { type: "application/pdf" }));
    const res = await app.request(`/expenses/${VALID_UUID}/attachments`, { method: "POST", body: fd });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: [{ id: VALID_UUID, storageKey: "k" }] });
    expect(uploadLineAttachmentServiceMock).toHaveBeenCalledTimes(1);
  });

  it("upload with no files → 400 Invalid form body, service not called", async () => {
    const app = await buildApp(editor);
    const fd = new FormData();
    const res = await app.request(`/expenses/${VALID_UUID}/attachments`, { method: "POST", body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid form body" });
    expect(uploadLineAttachmentServiceMock).not.toHaveBeenCalled();
  });

  it("POST bad-uuid expenseId → 400 Invalid id, service not called", async () => {
    const app = await buildApp(editor);
    const fd = new FormData();
    fd.append("files", new File(["x"], "a.pdf", { type: "application/pdf" }));
    const res = await app.request("/expenses/not-a-uuid/attachments", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid id" });
    expect(uploadLineAttachmentServiceMock).not.toHaveBeenCalled();
  });

  it("GET bad-uuid expenseId → 400 Invalid id, service not called", async () => {
    const app = await buildApp(editor);
    const res = await app.request("/expenses/not-a-uuid/attachments");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid id" });
    expect(listLineAttachmentServiceMock).not.toHaveBeenCalled();
  });

  it("editor list → 200 { items }, listLineAttachmentService called", async () => {
    const items = [{ id: VALID_UUID, filename: "tnb.pdf", contentType: "application/pdf", sizeBytes: 100, storageKey: "k", uploadedBy: "u1", createdAt: "2026-07-01T00:00:00.000Z" }];
    listLineAttachmentServiceMock.mockResolvedValue(ok({ items }));
    const app = await buildApp(editor);
    const res = await app.request(`/expenses/${VALID_UUID}/attachments`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items });
    expect(listLineAttachmentServiceMock).toHaveBeenCalledWith(expect.anything(), VALID_UUID);
  });

  it("list 404 EXPENSE_NOT_FOUND → 404", async () => {
    listLineAttachmentServiceMock.mockResolvedValue(errR(404, "EXPENSE_NOT_FOUND"));
    const app = await buildApp(editor);
    const res = await app.request(`/expenses/${VALID_UUID}/attachments`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "EXPENSE_NOT_FOUND" });
  });

  it("upload 404 EXPENSE_NOT_FOUND → 404, response short-circuits with the error", async () => {
    uploadLineAttachmentServiceMock.mockResolvedValue(errR(404, "EXPENSE_NOT_FOUND"));
    const app = await buildApp(editor);
    const fd = new FormData();
    fd.append("files", new File(["x"], "a.pdf", { type: "application/pdf" }));
    const res = await app.request(`/expenses/${VALID_UUID}/attachments`, { method: "POST", body: fd });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "EXPENSE_NOT_FOUND" });
  });

  it("upload 502 on the FIRST file short-circuits the loop — the second file's service call never happens", async () => {
    uploadLineAttachmentServiceMock.mockResolvedValueOnce(errR(502, "ATTACHMENT_UPLOAD_FAILED"));
    const app = await buildApp(editor);
    const fd = new FormData();
    fd.append("files", new File(["a"], "a.pdf", { type: "application/pdf" }));
    fd.append("files", new File(["b"], "b.pdf", { type: "application/pdf" }));
    const res = await app.request(`/expenses/${VALID_UUID}/attachments`, { method: "POST", body: fd });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "ATTACHMENT_UPLOAD_FAILED" });
    expect(uploadLineAttachmentServiceMock).toHaveBeenCalledTimes(1); // second file never attempted
  });
});
