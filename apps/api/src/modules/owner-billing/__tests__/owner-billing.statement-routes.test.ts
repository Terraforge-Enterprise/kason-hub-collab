import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Mock the service so the DB is never reached — routes tested in isolation.
vi.mock("../owner-billing.service", () => ({
  createFeeConfigService: vi.fn(),
  listFeeConfigsService: vi.fn(),
  getFeeConfigService: vi.fn(),
  updateFeeConfigService: vi.fn(),
  retireFeeConfigService: vi.fn(),
  restoreFeeConfigService: vi.fn(),
  generateStatementService: vi.fn(),
  listStatementsService: vi.fn(),
}));

import { ownerBillingRoutes } from "../owner-billing.routes";
import { generateStatementService, listStatementsService } from "../owner-billing.service";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerBillingRoutes);
  return app;
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const INVOICE = "44444444-4444-4444-8444-444444444444";

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };
const ownerPortalSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

const statementRow = {
  id: INVOICE,
  invoiceNumber: "OS-202606-11111111",
  invoiceType: "owner_statement",
  status: "draft",
  ownerPartyId: OWNER,
  partyId: OWNER,
  periodMonth: "2026-06-01T00:00:00.000Z",
  invoiceDate: "2026-06-15T00:00:00.000Z",
  dueDate: null,
  currency: "MYR",
  totalAmount: "316.00",
  sstAmount: "16.00",
  pdfKey: null,
  attachmentKeys: [],
  lines: [
    {
      id: "c1",
      chargeNumber: "OSC-1",
      chargeType: "management_fee",
      unitId: "u1",
      description: null,
      amount: "200.00",
      currency: "MYR",
      status: "draft",
      updatedAt: "2026-06-15T00:00:00.000Z",
    },
  ],
  createdAt: "2026-06-15T00:00:00.000Z",
  updatedAt: "2026-06-15T00:00:00.000Z",
};

const validBody = { ownerPartyId: OWNER, billingMonth: "2026-06" };

function postStatement(session: SessionPayload | null, body: unknown) {
  return makeApp(session).request("/statements", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});
afterAll(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateStatementService).mockResolvedValue({ ok: true, status: 201, data: statementRow });
  vi.mocked(listStatementsService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { items: [], limit: 50, offset: 0 },
  });
});

describe("POST /statements (generate = admin)", () => {
  it("403s for an editor operator session", async () => {
    const res = await postStatement(editorSession, validBody);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(generateStatementService).not.toHaveBeenCalled();
  });

  it("403s for a manager (generate requires admin)", async () => {
    const res = await postStatement(managerSession, validBody);
    expect(res.status).toBe(403);
    expect(generateStatementService).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await postStatement(ownerPortalSession, validBody);
    expect(res.status).toBe(403);
  });

  it("401s for a missing session", async () => {
    const res = await postStatement(null, validBody);
    expect(res.status).toBe(401);
  });

  it("admin gets 201 + the row on a fresh statement, with org/actor ctx forwarded", async () => {
    const res = await postStatement(adminSession, validBody);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: typeof statementRow };
    expect(json.data.invoiceType).toBe("owner_statement");
    expect(json.data.status).toBe("draft");
    expect(generateStatementService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      expect.objectContaining({ ownerPartyId: OWNER, billingMonth: "2026-06" }),
    );
  });

  it("returns 200 (not 201) when the service reports the existing draft (idempotent re-run)", async () => {
    vi.mocked(generateStatementService).mockResolvedValueOnce({ ok: true, status: 200, data: statementRow });
    const res = await postStatement(adminSession, validBody);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string } };
    expect(json.data.id).toBe(INVOICE);
  });

  it("maps a service 404 (cross-org owner) to HTTP 404", async () => {
    vi.mocked(generateStatementService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Owner not found in this organization",
    });
    const res = await postStatement(adminSession, validBody);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Owner not found in this organization" });
  });

  it("400s a body with a bad billingMonth format", async () => {
    const res = await postStatement(adminSession, { ownerPartyId: OWNER, billingMonth: "2026-6" });
    expect(res.status).toBe(400);
    expect(generateStatementService).not.toHaveBeenCalled();
  });

  it("400s a body with a non-uuid ownerPartyId", async () => {
    const res = await postStatement(adminSession, { ownerPartyId: "not-a-uuid", billingMonth: "2026-06" });
    expect(res.status).toBe(400);
    expect(generateStatementService).not.toHaveBeenCalled();
  });

  it("accepts a per-unit (apartmentId) statement — forwards the apartment scope to the service (201)", async () => {
    // Per-unit statements are first-class (an admin/accountant per-unit view): a
    // body carrying a VALID apartmentId is accepted and the scope is forwarded to
    // the service. The combined "All Units" statement is the no-apartmentId case
    // (tested above). Per-unit statements are kept off the owner portal separately.
    const APT = "22222222-2222-4222-8222-222222222222";
    const res = await postStatement(adminSession, {
      ownerPartyId: OWNER,
      billingMonth: "2026-06",
      apartmentId: APT,
    });
    expect(res.status).toBe(201);
    expect(generateStatementService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "admin" }),
      expect.objectContaining({ ownerPartyId: OWNER, billingMonth: "2026-06", apartmentId: APT }),
    );
  });

  it("400s a per-unit body with a non-uuid apartmentId", async () => {
    const res = await postStatement(adminSession, {
      ownerPartyId: OWNER,
      billingMonth: "2026-06",
      apartmentId: "not-a-uuid",
    });
    expect(res.status).toBe(400);
    expect(generateStatementService).not.toHaveBeenCalled();
  });

  it("returns 400 Invalid JSON body for malformed JSON", async () => {
    const res = await makeApp(adminSession).request("/statements", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("404s the POST while the flag is dark, before the role check", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await postStatement(adminSession, validBody);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});

describe("GET /statements (list = manager)", () => {
  it("403s for an editor (list requires manager)", async () => {
    const res = await makeApp(editorSession).request("/statements");
    expect(res.status).toBe(403);
    expect(listStatementsService).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await makeApp(ownerPortalSession).request("/statements");
    expect(res.status).toBe(403);
  });

  it("manager can list; ownerPartyId/status/billingMonth + paging reach the service with the SESSION org", async () => {
    const res = await makeApp(managerSession).request(
      `/statements?ownerPartyId=${OWNER}&status=draft&billingMonth=2026-06&limit=25&offset=10`,
    );
    expect(res.status).toBe(200);
    expect(listStatementsService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2" }),
      expect.objectContaining({ ownerPartyId: OWNER, status: "draft", billingMonth: "2026-06" }),
      { limit: 25, offset: 10 },
    );
  });

  it("admin (>= manager) can also list", async () => {
    const res = await makeApp(adminSession).request("/statements");
    expect(res.status).toBe(200);
  });

  it("defaults paging to limit 50 / offset 0 when omitted", async () => {
    await makeApp(managerSession).request("/statements");
    expect(listStatementsService).toHaveBeenCalledWith(expect.anything(), expect.any(Object), {
      limit: 50,
      offset: 0,
    });
  });

  it("400s a non-uuid ownerPartyId filter", async () => {
    const res = await makeApp(managerSession).request("/statements?ownerPartyId=not-a-uuid");
    expect(res.status).toBe(400);
    expect(listStatementsService).not.toHaveBeenCalled();
  });

  it("400s a bad billingMonth filter format", async () => {
    const res = await makeApp(managerSession).request("/statements?billingMonth=2026-6");
    expect(res.status).toBe(400);
    expect(listStatementsService).not.toHaveBeenCalled();
  });

  it("returns the service envelope under data", async () => {
    vi.mocked(listStatementsService).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { items: [statementRow], limit: 50, offset: 0 },
    });
    const res = await makeApp(managerSession).request("/statements");
    const json = (await res.json()) as { data: { items: unknown[]; limit: number } };
    expect(json.data.items).toHaveLength(1);
    expect(json.data.limit).toBe(50);
  });

  it("404s the GET while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await makeApp(managerSession).request("/statements");
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});
