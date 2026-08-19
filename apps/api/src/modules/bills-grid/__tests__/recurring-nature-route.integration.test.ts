import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Task 8 — the recurring APPLY route (`POST /apartments/:id/recurring/apply`) must
// (a) accept an optional `nature`, (b) fail CLOSED with 422 when
// ENABLE_CHARGE_NATURE_ROUTING is ON and `nature` is omitted (never a silent Profit
// default, spec R5), and (c) stay byte-unchanged when the flag is OFF.
//
// routes.ts eagerly imports BOTH ./recurring.service and ./service, so stub both:
// the recurring mock lets us assert the fail-closed guard + the nature pass-through
// without a DB; the ./service stub keeps its real (DB-touching) module from loading.
// Mirrors modules/bills-grid/__tests__/routes.test.ts.
const {
  applyRecurringServiceMock,
  archiveRecurringServiceMock,
  disableRecurringServiceMock,
  listRecurringLinesServiceMock,
  listRecurringServiceMock,
  previewRecurringServiceMock,
} = vi.hoisted(() => ({
  applyRecurringServiceMock: vi.fn(),
  archiveRecurringServiceMock: vi.fn(),
  disableRecurringServiceMock: vi.fn(),
  listRecurringLinesServiceMock: vi.fn(),
  listRecurringServiceMock: vi.fn(),
  previewRecurringServiceMock: vi.fn(),
}));
vi.mock("../recurring.service", () => ({
  applyRecurringService: applyRecurringServiceMock,
  archiveRecurringService: archiveRecurringServiceMock,
  disableRecurringService: disableRecurringServiceMock,
  listRecurringLinesService: listRecurringLinesServiceMock,
  listRecurringService: listRecurringServiceMock,
  previewRecurringService: previewRecurringServiceMock,
}));
// Every ./service export routes.ts touches → a no-op fn. None of these routes are
// exercised here; the stub only prevents the real module (prisma) from loading.
vi.mock("../service", () => ({
  billService: vi.fn(),
  createExpensesService: vi.fn(),
  deleteAttachmentService: vi.fn(),
  getAttachmentUrlService: vi.fn(),
  getBearerConfigService: vi.fn(),
  getGridService: vi.fn(),
  listAttachmentsService: vi.fn(),
  listExpensesService: vi.fn(),
  listLineAttachmentService: vi.fn(),
  saveEntryService: vi.fn(),
  saveReadingsService: vi.fn(),
  setBearerConfigService: vi.fn(),
  updateExpenseService: vi.fn(),
  updateLinesService: vi.fn(),
  uploadAttachmentService: vi.fn(),
  uploadLineAttachmentService: vi.fn(),
  voidExpenseService: vi.fn(),
}));

// routes.test.ts:63-67 — the only session-injection pattern that works.
function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => { if (session) c.set("session", session); await next(); });
  return app;
}
const manager: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const APPLY_URL = `/apartments/${VALID_UUID}/recurring/apply`;

// A valid recurring APPLY body (CLEANING; preview→confirm gate satisfied via
// confirm:true). `nature` is spread in (or omitted) per row.
const applyBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "CLEANING", name: "Cleaning", amount: "100.00", bearer: "owner",
    effectiveFromMonth: "2026-07-01", confirm: true, ...extra,
  });
const post = (body: string): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body });
const ok = (data: unknown, status = 200) => ({ ok: true as const, status, data });

/** Boot the router with BOTH gating flags ON (recurring routes need billing-docs too). */
async function buildApp(session: SessionPayload | null) {
  process.env.ENABLE_PHASE2_BILLS_GRID = "true";
  process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
  vi.resetModules();
  const { billsGridRoutes } = await import("../routes");
  const app = makeApp(session);
  app.route("/", billsGridRoutes);
  return app;
}

afterEach(() => {
  delete process.env.ENABLE_PHASE2_BILLS_GRID;
  delete process.env.ENABLE_PHASE2_BILLING_DOCS;
  delete process.env.ENABLE_CHARGE_NATURE_ROUTING;
  vi.clearAllMocks();
});

describe("recurring apply — nature routing (ENABLE_CHARGE_NATURE_ROUTING)", () => {
  it("flag ON + nature:'expense' → 200 and nature is passed through to applyRecurringService", async () => {
    applyRecurringServiceMock.mockResolvedValue(ok({ definitionId: VALID_UUID, revisionId: VALID_UUID, nature: "expense" }));
    const app = await buildApp(manager);
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const res = await app.request(APPLY_URL, post(applyBody({ nature: "expense" })));
    expect(res.status).toBe(200);
    // The route forwards the parsed nature verbatim → the revision persists nature:"expense".
    expect(applyRecurringServiceMock).toHaveBeenCalledWith(
      expect.anything(),
      VALID_UUID,
      expect.objectContaining({ nature: "expense", confirm: true, kind: "CLEANING" }),
    );
    expect(await res.json()).toMatchObject({ nature: "expense" });
  });

  it("flag ON + nature ABSENT → 422 fail-closed; applyRecurringService never runs (no silent Profit default)", async () => {
    const app = await buildApp(manager);
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const res = await app.request(APPLY_URL, post(applyBody())); // body omits nature
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "NATURE_REQUIRED" });
    expect(applyRecurringServiceMock).not.toHaveBeenCalled();
  });

  it("flag OFF + nature ABSENT → 200 (unchanged); service runs exactly as before", async () => {
    applyRecurringServiceMock.mockResolvedValue(ok({ definitionId: VALID_UUID, revisionId: VALID_UUID, nature: null }));
    const app = await buildApp(manager); // ENABLE_CHARGE_NATURE_ROUTING left unset
    const res = await app.request(APPLY_URL, post(applyBody())); // body omits nature
    expect(res.status).toBe(200);
    expect(applyRecurringServiceMock).toHaveBeenCalled();
  });

  // Refined gate (2026-08-06): only a CREATE of a nature-carrying kind must decide
  // nature up front. Edits copy the prior revision's nature forward service-side, and
  // kinds with no nature slot never needed one — 422ing those made the Setting
  // drawer's Save half-apply (bearer PUT committed, recurring apply rejected).
  it("flag ON + nature ABSENT on an EDIT (definitionId present) → 200, service runs (copy-forward)", async () => {
    applyRecurringServiceMock.mockResolvedValue(ok({ definitionId: VALID_UUID, revisionId: VALID_UUID, nature: "expense" }));
    const app = await buildApp(manager);
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const res = await app.request(APPLY_URL, post(applyBody({ definitionId: VALID_UUID })));
    expect(res.status).toBe(200);
    expect(applyRecurringServiceMock).toHaveBeenCalled();
  });

  it("flag ON + nature ABSENT for a kind with no nature slot (MAINTENANCE) → 200", async () => {
    applyRecurringServiceMock.mockResolvedValue(ok({ definitionId: VALID_UUID, revisionId: VALID_UUID, nature: null }));
    const app = await buildApp(manager);
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const res = await app.request(APPLY_URL, post(applyBody({ kind: "MAINTENANCE", name: "Maintenance" })));
    expect(res.status).toBe(200);
    expect(applyRecurringServiceMock).toHaveBeenCalled();
  });
});
