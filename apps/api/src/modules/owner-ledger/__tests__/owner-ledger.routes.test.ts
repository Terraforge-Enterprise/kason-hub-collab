import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Mock service so the DB is never reached — routes are tested in isolation.
vi.mock("../owner-ledger.service", () => ({
  createEntryService: vi.fn(),
  listEntriesService: vi.fn(),
  getEntryService: vi.fn(),
  updateEntryService: vi.fn(),
  voidEntryService: vi.fn(),
  getSummaryService: vi.fn(),
  getTaxSummaryService: vi.fn(),
  getOrgUnitsSummaryService: vi.fn(),
  getApartmentContextService: vi.fn(),
}));

vi.mock("../owner-ledger.sync", () => ({
  syncMonthService: vi.fn(),
}));

vi.mock("../../../lib/storage", () => ({
  createSignedUploadUrl: vi.fn(),
}));

import { ownerLedgerRoutes } from "../owner-ledger.routes";
import {
  createEntryService,
  listEntriesService,
  getEntryService,
  updateEntryService,
  voidEntryService,
  getSummaryService,
  getTaxSummaryService,
} from "../owner-ledger.service";
import { syncMonthService } from "../owner-ledger.sync";
import { createSignedUploadUrl } from "../../../lib/storage";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerLedgerRoutes);
  return app;
}

// ─── Stable UUIDs ─────────────────────────────────────────────────────────────

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ENTRY = "22222222-2222-4222-8222-222222222222";
const ENTRY = "33333333-3333-4333-8333-333333333333";
const PROPERTY = "44444444-4444-4444-8444-444444444444";

// ─── Sessions ─────────────────────────────────────────────────────────────────

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };
const ownerPortalSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

// ─── Fixture data ─────────────────────────────────────────────────────────────

const UPDATED_AT = "2026-06-01T00:00:00.000Z";
const BUMPED_AT = "2026-06-02T00:00:00.000Z";

const createdEntry = {
  id: ENTRY,
  organizationId: "o1",
  ownerPartyId: OWNER,
  propertyId: PROPERTY,
  apartmentId: null,
  unitCode: null,
  listingId: null,
  tenancyId: null,
  statementMonth: "2026-06-01T00:00:00.000Z",
  transactionDate: "2026-06-15T00:00:00.000Z",
  direction: "income",
  category: "rental_income",
  description: null,
  remarks: null,
  amount: "2500.00",
  chargedAmount: null,
  debitAdjustmentAmount: "0.00",
  creditAdjustmentAmount: "0.00",
  sstAmount: null,
  paidBy: "kaen",
  paymentStatus: "paid",
  taxCategory: "check_with_tax_agent",
  includeInPayout: true,
  attachmentKeys: [],
  sourceType: "manual",
  sourceChargeId: null,
  sourceUtilityBillId: null,
  status: "active",
  createdById: "u1",
  updatedById: "u1",
  createdAt: UPDATED_AT,
  updatedAt: UPDATED_AT,
};

const validEntryBody = {
  ownerPartyId: OWNER,
  propertyId: PROPERTY,
  statementMonth: "2026-06",
  transactionDate: "2026-06-15",
  direction: "income",
  category: "rental_income",
  amount: "2500.00",
  paidBy: "kaen",
};

// ─── Enable flag by default ───────────────────────────────────────────────────

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});

afterAll(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createSignedUploadUrl).mockResolvedValue({
    uploadUrl: "https://mock-storage.supabase.co/object/sign/owner-ledger-entries/test-uuid.jpg",
    method: "PUT",
    headers: {
      "content-type": "image/jpeg",
      authorization: "Bearer mock-token",
      "x-upsert": "true",
    },
    storageKey: "owner-ledger-entries/test-uuid.jpg",
  });
  vi.mocked(createEntryService).mockResolvedValue({ ok: true, status: 201, data: createdEntry });
  vi.mocked(listEntriesService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { rows: [], total: 0 },
  });
  vi.mocked(getEntryService).mockResolvedValue({ ok: true, status: 200, data: createdEntry });
  vi.mocked(updateEntryService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { ...createdEntry, amount: "2600.00", updatedAt: BUMPED_AT },
  });
  vi.mocked(voidEntryService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { ...createdEntry, status: "void", updatedAt: BUMPED_AT },
  });
  vi.mocked(syncMonthService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { created: 3, updated: 1, skipped: 0, reversed: 0 },
  });
  vi.mocked(getSummaryService).mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      grossRental: "2500.00",
      totalExpenses: "300.00",
      netRentalAfterExpenses: "2200.00",
      netPayoutToOwner: "2200.00",
      payoutsTotal: "0.00",
      passThroughIncome: "0.00",
      byCategory: { management_fee: "300.00" },
      broughtForward: "0.00",
      periodGross: "2500.00",
      periodExpenses: "300.00",
      periodPayouts: "0.00",
      netThisPeriod: "2200.00",
      depositCollected: "0.00",
      carriedForward: "2200.00",
    },
  });
  vi.mocked(getTaxSummaryService).mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      byTaxCategory: { check_with_tax_agent: "300.00" },
      byCategory: { management_fee: "300.00" },
      totalExpenses: "300.00",
    },
  });
});

// ─── Flag gate ────────────────────────────────────────────────────────────────

describe("owner-ledger flag gate", () => {
  it("returns canonical 404 while ENABLE_PHASE2_OWNER_BILLING is dark, even for a manager", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await makeApp(managerSession).request("/entries");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });

  it("lets a manager through to GET /entries when the flag is on", async () => {
    const res = await makeApp(managerSession).request("/entries");
    expect(res.status).toBe(200);
  });
});

// ─── POST /entries (write = admin) ────────────────────────────────────────────

describe("POST /entries (write = admin)", () => {
  it("403s for a portal (owner) session", async () => {
    const res = await makeApp(ownerPortalSession).request("/entries", {
      method: "POST",
      body: JSON.stringify(validEntryBody),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(createEntryService).not.toHaveBeenCalled();
  });

  it("403s for a manager (write requires admin)", async () => {
    const res = await makeApp(managerSession).request("/entries", {
      method: "POST",
      body: JSON.stringify(validEntryBody),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(createEntryService).not.toHaveBeenCalled();
  });

  it("403s for an editor operator session", async () => {
    const res = await makeApp(editorSession).request("/entries", {
      method: "POST",
      body: JSON.stringify(validEntryBody),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(createEntryService).not.toHaveBeenCalled();
  });

  it("401s for a missing session", async () => {
    const res = await makeApp(null).request("/entries", {
      method: "POST",
      body: JSON.stringify(validEntryBody),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("admin with a valid body gets 201 and the row", async () => {
    const res = await makeApp(adminSession).request("/entries", {
      method: "POST",
      body: JSON.stringify(validEntryBody),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: typeof createdEntry };
    expect(json.data.direction).toBe("income");
    expect(json.data.amount).toBe("2500.00");
    expect(createEntryService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      expect.objectContaining({ ownerPartyId: OWNER, direction: "income", amount: "2500.00" }),
    );
  });

  it("400s for an invalid body (missing propertyId)", async () => {
    const res = await makeApp(adminSession).request("/entries", {
      method: "POST",
      body: JSON.stringify({ ownerPartyId: OWNER, direction: "income" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(createEntryService).not.toHaveBeenCalled();
  });

  it("400s for malformed JSON", async () => {
    const res = await makeApp(adminSession).request("/entries", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });
});

// ─── GET /entries (read = manager) ───────────────────────────────────────────

describe("GET /entries (read = manager)", () => {
  it("403s for a portal (owner) session even with the flag on", async () => {
    const res = await makeApp(ownerPortalSession).request("/entries");
    expect(res.status).toBe(403);
  });

  it("403s for an editor operator session", async () => {
    const res = await makeApp(editorSession).request("/entries");
    expect(res.status).toBe(403);
  });

  it("manager can list entries and the org comes from the session", async () => {
    const res = await makeApp(managerSession).request(
      `/entries?ownerPartyId=${OWNER}&limit=25&offset=10`,
    );
    expect(res.status).toBe(200);
    expect(listEntriesService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2" }),
      expect.objectContaining({ ownerPartyId: OWNER }),
      { limit: 25, offset: 10 },
    );
  });

  it("admin (>= manager) can also read", async () => {
    const res = await makeApp(adminSession).request("/entries");
    expect(res.status).toBe(200);
  });

  it("defaults paging to limit 50 / offset 0 when omitted", async () => {
    const res = await makeApp(managerSession).request("/entries");
    expect(res.status).toBe(200);
    expect(listEntriesService).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Object),
      { limit: 50, offset: 0 },
    );
  });

  it("returns rows + total under data", async () => {
    vi.mocked(listEntriesService).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { rows: [createdEntry], total: 1 },
    });
    const res = await makeApp(managerSession).request("/entries");
    const json = (await res.json()) as { data: { rows: unknown[]; total: number } };
    expect(json.data.rows).toHaveLength(1);
    expect(json.data.total).toBe(1);
  });
});

// ─── GET /entries/:id (read = manager) ───────────────────────────────────────

describe("GET /entries/:id (read = manager)", () => {
  it("403s for an editor (read requires manager)", async () => {
    const res = await makeApp(editorSession).request(`/entries/${ENTRY}`);
    expect(res.status).toBe(403);
  });

  it("manager gets 200 for an id in their org", async () => {
    const res = await makeApp(managerSession).request(`/entries/${ENTRY}`);
    expect(res.status).toBe(200);
    expect(getEntryService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      ENTRY,
    );
  });

  it("returns 404 for an id from another org (service 404 → HTTP 404)", async () => {
    vi.mocked(getEntryService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Not found",
    });
    const res = await makeApp(managerSession).request(`/entries/${OTHER_ORG_ENTRY}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

// ─── PATCH /entries/:id (write = admin) ───────────────────────────────────────

describe("PATCH /entries/:id (write = admin)", () => {
  const validPatch = { amount: "2600.00", expectedUpdatedAt: UPDATED_AT };

  it("403s for a manager (write requires admin)", async () => {
    const res = await makeApp(managerSession).request(`/entries/${ENTRY}`, {
      method: "PATCH",
      body: JSON.stringify(validPatch),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(updateEntryService).not.toHaveBeenCalled();
  });

  it("admin PATCH is rejected read-only (409)", async () => {
    vi.mocked(updateEntryService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Ledger entries are read-only; void and re-add",
    });
    const res = await makeApp(adminSession).request(`/entries/${ENTRY}`, {
      method: "PATCH",
      body: JSON.stringify(validPatch),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Ledger entries are read-only; void and re-add" });
    expect(updateEntryService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      ENTRY,
      expect.objectContaining({ amount: "2600.00", expectedUpdatedAt: UPDATED_AT }),
    );
  });

  it("maps a 409 ServiceResult to HTTP 409 (stale concurrency token)", async () => {
    vi.mocked(updateEntryService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "stale",
    });
    const res = await makeApp(adminSession).request(`/entries/${ENTRY}`, {
      method: "PATCH",
      body: JSON.stringify({ amount: "2600.00", expectedUpdatedAt: "2026-05-01T00:00:00.000Z" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale" });
  });

  it("400s a PATCH that omits expectedUpdatedAt", async () => {
    const res = await makeApp(adminSession).request(`/entries/${ENTRY}`, {
      method: "PATCH",
      body: JSON.stringify({ amount: "2600.00" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(updateEntryService).not.toHaveBeenCalled();
  });

  it("returns 404 when the service 404s (cross-org / missing)", async () => {
    vi.mocked(updateEntryService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Not found",
    });
    const res = await makeApp(adminSession).request(`/entries/${OTHER_ORG_ENTRY}`, {
      method: "PATCH",
      body: JSON.stringify(validPatch),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("400s for malformed JSON", async () => {
    const res = await makeApp(adminSession).request(`/entries/${ENTRY}`, {
      method: "PATCH",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });
});

// ─── POST /entries/:id/void (write = admin) ───────────────────────────────────

describe("POST /entries/:id/void (write = admin)", () => {
  it("403s for a manager (write requires admin)", async () => {
    const res = await makeApp(managerSession).request(`/entries/${ENTRY}/void`, {
      method: "POST",
      body: JSON.stringify({ expectedUpdatedAt: UPDATED_AT }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(voidEntryService).not.toHaveBeenCalled();
  });

  it("admin void gets 200 with status void", async () => {
    const res = await makeApp(adminSession).request(`/entries/${ENTRY}/void`, {
      method: "POST",
      body: JSON.stringify({ expectedUpdatedAt: UPDATED_AT }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { status: string } };
    expect(json.data.status).toBe("void");
    expect(voidEntryService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "admin" }),
      ENTRY,
      UPDATED_AT,
    );
  });

  it("400s when expectedUpdatedAt is missing from the body", async () => {
    const res = await makeApp(adminSession).request(`/entries/${ENTRY}/void`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(voidEntryService).not.toHaveBeenCalled();
  });

  it("400s when expectedUpdatedAt is not a valid datetime string (Zod validation)", async () => {
    const res = await makeApp(adminSession).request(`/entries/${ENTRY}/void`, {
      method: "POST",
      body: JSON.stringify({ expectedUpdatedAt: "not-a-date" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(voidEntryService).not.toHaveBeenCalled();
  });

  it("maps a 409 ServiceResult to HTTP 409", async () => {
    vi.mocked(voidEntryService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "stale",
    });
    const res = await makeApp(adminSession).request(`/entries/${ENTRY}/void`, {
      method: "POST",
      body: JSON.stringify({ expectedUpdatedAt: "2026-05-01T00:00:00.000Z" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(409);
  });
});

// ─── POST /sync (write = admin) ───────────────────────────────────────────────

describe("POST /sync (write = admin)", () => {
  const validSyncBody = { ownerPartyId: OWNER, month: "2026-06" };

  it("403s for a manager (sync write requires admin)", async () => {
    const res = await makeApp(managerSession).request("/sync", {
      method: "POST",
      body: JSON.stringify(validSyncBody),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(syncMonthService).not.toHaveBeenCalled();
  });

  it("admin sync gets 200 with created/updated/skipped counts", async () => {
    const res = await makeApp(adminSession).request("/sync", {
      method: "POST",
      body: JSON.stringify(validSyncBody),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { created: number; updated: number; skipped: number } };
    expect(json.data.created).toBe(3);
    expect(json.data.updated).toBe(1);
    expect(syncMonthService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "admin" }),
      expect.objectContaining({ ownerPartyId: OWNER, month: "2026-06" }),
    );
  });

  it("400s for an invalid body (missing ownerPartyId)", async () => {
    const res = await makeApp(adminSession).request("/sync", {
      method: "POST",
      body: JSON.stringify({ month: "2026-06" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(syncMonthService).not.toHaveBeenCalled();
  });
});

// ─── GET /summary (read = manager) ───────────────────────────────────────────

describe("GET /summary (read = manager)", () => {
  const validQuery = `fromMonth=2026-01&toMonth=2026-06`;

  it("403s for a portal session", async () => {
    const res = await makeApp(ownerPortalSession).request(`/summary?${validQuery}`);
    expect(res.status).toBe(403);
  });

  it("403s for an editor operator session", async () => {
    const res = await makeApp(editorSession).request(`/summary?${validQuery}`);
    expect(res.status).toBe(403);
  });

  it("manager gets 200 with computed totals", async () => {
    const res = await makeApp(managerSession).request(`/summary?${validQuery}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        grossRental: string;
        totalExpenses: string;
        netRentalAfterExpenses: string;
        netPayoutToOwner: string;
        byCategory: Record<string, string>;
      };
    };
    expect(json.data.grossRental).toBe("2500.00");
    expect(json.data.totalExpenses).toBe("300.00");
    expect(json.data.netRentalAfterExpenses).toBe("2200.00");
    expect(json.data.byCategory).toHaveProperty("management_fee");
    expect(getSummaryService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ fromMonth: "2026-01", toMonth: "2026-06" }),
    );
  });

  it("admin (>= manager) can also read summary", async () => {
    const res = await makeApp(adminSession).request(`/summary?${validQuery}`);
    expect(res.status).toBe(200);
  });

  it("accepts a missing fromMonth as an open (all-time) lower bound", async () => {
    const res = await makeApp(managerSession).request("/summary?toMonth=2026-06");
    expect(res.status).toBe(200);
    expect(getSummaryService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ toMonth: "2026-06" }),
    );
  });

  it("passes optional ownerPartyId filter to the service", async () => {
    const res = await makeApp(managerSession).request(
      `/summary?fromMonth=2026-01&toMonth=2026-06&ownerPartyId=${OWNER}`,
    );
    expect(res.status).toBe(200);
    expect(getSummaryService).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerPartyId: OWNER, fromMonth: "2026-01", toMonth: "2026-06" }),
    );
  });
});

// ─── GET /entries — T2′ read-through sync ─────────────────────────────────────
//
// When the request is scoped to a SPECIFIC ownerPartyId + month the route must
// call syncMonthService once before returning entries (so the admin sees current
// data without a manual "Sync" click).  When either param is absent the sync
// must NOT fire (avoid syncing the entire listing on every all-owners query).

describe("GET /entries — T2′ read-through sync", () => {
  it("calls syncMonthService when both ownerPartyId and month are present", async () => {
    const res = await makeApp(managerSession).request(
      `/entries?ownerPartyId=${OWNER}&month=2026-06`,
    );
    expect(res.status).toBe(200);
    expect(syncMonthService).toHaveBeenCalledTimes(1);
    expect(syncMonthService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      { ownerPartyId: OWNER, month: "2026-06" },
    );
  });

  it("does NOT call syncMonthService when only ownerPartyId is present (no month)", async () => {
    const res = await makeApp(managerSession).request(`/entries?ownerPartyId=${OWNER}`);
    expect(res.status).toBe(200);
    expect(syncMonthService).not.toHaveBeenCalled();
  });

  it("does NOT call syncMonthService when only month is present (no ownerPartyId)", async () => {
    const res = await makeApp(managerSession).request("/entries?month=2026-06");
    expect(res.status).toBe(200);
    expect(syncMonthService).not.toHaveBeenCalled();
  });

  it("does NOT call syncMonthService on the all-entries listing (no params)", async () => {
    const res = await makeApp(managerSession).request("/entries");
    expect(res.status).toBe(200);
    expect(syncMonthService).not.toHaveBeenCalled();
  });

  it("still returns 200 and existing entries when sync throws (error swallowed)", async () => {
    vi.mocked(syncMonthService).mockRejectedValueOnce(new Error("DB down"));
    const res = await makeApp(managerSession).request(
      `/entries?ownerPartyId=${OWNER}&month=2026-06`,
    );
    expect(res.status).toBe(200);
    expect(listEntriesService).toHaveBeenCalled();
    const json = (await res.json()) as { data: { rows: unknown[]; total: number } };
    expect(json.data).toBeDefined();
  });

  it("still returns 200 when sync returns ok:false (error swallowed)", async () => {
    vi.mocked(syncMonthService).mockResolvedValueOnce({
      ok: false as const,
      status: 400,
      error: "Invalid month format",
    });
    const res = await makeApp(managerSession).request(
      `/entries?ownerPartyId=${OWNER}&month=2026-06`,
    );
    expect(res.status).toBe(200);
    expect(listEntriesService).toHaveBeenCalled();
  });
});

// ─── GET /tax-summary (read = manager) ───────────────────────────────────────

describe("GET /tax-summary (read = manager)", () => {
  const validQuery = `fromMonth=2026-01&toMonth=2026-06`;

  it("403s for a portal session", async () => {
    const res = await makeApp(ownerPortalSession).request(`/tax-summary?${validQuery}`);
    expect(res.status).toBe(403);
  });

  it("manager gets 200 with tax totals", async () => {
    const res = await makeApp(managerSession).request(`/tax-summary?${validQuery}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        byTaxCategory: Record<string, string>;
        byCategory: Record<string, string>;
        totalExpenses: string;
      };
    };
    expect(json.data.totalExpenses).toBe("300.00");
    expect(json.data.byTaxCategory).toHaveProperty("check_with_tax_agent");
    expect(getTaxSummaryService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ fromMonth: "2026-01", toMonth: "2026-06" }),
    );
  });

  it("accepts a missing toMonth as an open (all-time) upper bound", async () => {
    const res = await makeApp(managerSession).request("/tax-summary?fromMonth=2026-01");
    expect(res.status).toBe(200);
    expect(getTaxSummaryService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ fromMonth: "2026-01" }),
    );
  });
});

// ─── POST /entries/attachments/upload-url (write = admin) ────────────────────

describe("POST /entries/attachments/upload-url (write = admin)", () => {
  const validUploadBody = { filename: "receipt.jpg", mimeType: "image/jpeg", sizeBytes: 1024 };

  it("403s for a manager (write requires admin)", async () => {
    const res = await makeApp(managerSession).request("/entries/attachments/upload-url", {
      method: "POST",
      body: JSON.stringify(validUploadBody),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("401s for a missing session", async () => {
    const res = await makeApp(null).request("/entries/attachments/upload-url", {
      method: "POST",
      body: JSON.stringify(validUploadBody),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("400s for an unsupported mimeType (text/plain is not in the whitelist)", async () => {
    const res = await makeApp(adminSession).request("/entries/attachments/upload-url", {
      method: "POST",
      body: JSON.stringify({ filename: "file.txt", mimeType: "text/plain", sizeBytes: 512 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("200 with { data: { uploadUrl, storageKey, method } } for admin + allowed mimeType; storageKey is owner-ledger-entries/<uuid>.jpg and client filename is absent", async () => {
    const res = await makeApp(adminSession).request("/entries/attachments/upload-url", {
      method: "POST",
      body: JSON.stringify(validUploadBody),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { uploadUrl: string; storageKey: string; method: string };
    };
    expect(json.data.uploadUrl).toBeDefined();
    expect(json.data.method).toBe("PUT");
    // storageKey must be owner-ledger-entries/<uuid>.<ext> — never the client filename
    expect(json.data.storageKey).toMatch(/^owner-ledger-entries\/.+\.jpg$/);
    expect(json.data.storageKey).not.toContain("receipt");
    // Verify the route passed the right storageKey + contentType to the storage helper
    expect(createSignedUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: expect.stringMatching(/^owner-ledger-entries\/.+\.jpg$/),
        contentType: "image/jpeg",
      }),
    );
  });
});
