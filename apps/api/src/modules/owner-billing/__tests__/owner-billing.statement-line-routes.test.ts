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
  getStatementService: vi.fn(),
  addStatementLineService: vi.fn(),
  updateStatementLineService: vi.fn(),
  voidStatementLineService: vi.fn(),
}));

import { ownerBillingRoutes } from "../owner-billing.routes";
import {
  addStatementLineService,
  getStatementService,
  updateStatementLineService,
  voidStatementLineService,
} from "../owner-billing.service";

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
const CHARGE = "55555555-5555-4555-8555-555555555555";

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
  totalAmount: "200.00",
  sstAmount: "0.00",
  pdfKey: null,
  attachmentKeys: ["receipts/a.pdf"],
  lines: [
    {
      id: CHARGE,
      chargeNumber: "OSC-202606-11111111-0001",
      chargeType: "tnb",
      unitId: "u1",
      description: "TNB June",
      amount: "120.00",
      currency: "MYR",
      status: "draft",
      updatedAt: "2026-06-15T00:00:00.000Z",
    },
  ],
  createdAt: "2026-06-15T00:00:00.000Z",
  updatedAt: "2026-06-15T00:00:00.000Z",
};

const addBody = { chargeType: "water", description: "Water June", amount: "80.00" };
const patchBody = { amount: "300.00", expectedUpdatedAt: "2026-06-15T00:00:00.000Z" };

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});
afterAll(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

beforeEach(() => {
  vi.clearAllMocks();
  // ENABLE_PHASE2_BILLING_DOCS is dark in this file — the void route requires a
  // reason body once it's on (spec §4.3), which these void tests don't send.
  // Force dark so a full-suite run with the flag set globally doesn't leak in.
  delete process.env.ENABLE_PHASE2_BILLING_DOCS;
  vi.mocked(getStatementService).mockResolvedValue({ ok: true, status: 200, data: statementRow });
  vi.mocked(addStatementLineService).mockResolvedValue({ ok: true, status: 200, data: statementRow });
  vi.mocked(updateStatementLineService).mockResolvedValue({ ok: true, status: 200, data: statementRow });
  vi.mocked(voidStatementLineService).mockResolvedValue({ ok: true, status: 200, data: statementRow });
});

describe("GET /statements/:id (detail = manager)", () => {
  it("manager can read the detail; org+actor ctx forwarded with the id", async () => {
    const res = await makeApp(managerSession).request(`/statements/${INVOICE}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: typeof statementRow };
    expect(json.data.id).toBe(INVOICE);
    expect(json.data.attachmentKeys).toEqual(["receipts/a.pdf"]);
    expect(getStatementService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2" }),
      INVOICE,
    );
  });

  it("403s for an editor (detail requires manager)", async () => {
    const res = await makeApp(editorSession).request(`/statements/${INVOICE}`);
    expect(res.status).toBe(403);
    expect(getStatementService).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await makeApp(ownerPortalSession).request(`/statements/${INVOICE}`);
    expect(res.status).toBe(403);
  });

  it("maps a service 404 to HTTP 404", async () => {
    vi.mocked(getStatementService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Statement not found",
    });
    const res = await makeApp(managerSession).request(`/statements/${INVOICE}`);
    expect(res.status).toBe(404);
  });

  it("404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await makeApp(managerSession).request(`/statements/${INVOICE}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});

function postLine(session: SessionPayload | null, body: unknown) {
  return makeApp(session).request(`/statements/${INVOICE}/lines`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /statements/:id/lines (add line = admin)", () => {
  it("admin gets 200 + the recomputed statement; id + body forwarded", async () => {
    const res = await postLine(adminSession, addBody);
    expect(res.status).toBe(200);
    expect(addStatementLineService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      INVOICE,
      expect.objectContaining({ chargeType: "water", description: "Water June", amount: "80.00" }),
    );
  });

  it("403s for a manager (add requires admin)", async () => {
    const res = await postLine(managerSession, addBody);
    expect(res.status).toBe(403);
    expect(addStatementLineService).not.toHaveBeenCalled();
  });

  it("403s for an editor", async () => {
    const res = await postLine(editorSession, addBody);
    expect(res.status).toBe(403);
  });

  it("403s for a portal (owner) session", async () => {
    const res = await postLine(ownerPortalSession, addBody);
    expect(res.status).toBe(403);
  });

  it("401s for a missing session", async () => {
    const res = await postLine(null, addBody);
    expect(res.status).toBe(401);
  });

  it("maps a service 409 (non-draft statement) to HTTP 409", async () => {
    vi.mocked(addStatementLineService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Statement is not a draft — lines can no longer be added or edited",
    });
    const res = await postLine(adminSession, addBody);
    expect(res.status).toBe(409);
  });

  it("maps a service 404 (cross-org statement) to HTTP 404", async () => {
    vi.mocked(addStatementLineService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Statement not found",
    });
    const res = await postLine(adminSession, addBody);
    expect(res.status).toBe(404);
  });

  it("400s a body with a bad chargeType", async () => {
    const res = await postLine(adminSession, { chargeType: "bribe", description: "x", amount: "1.00" });
    expect(res.status).toBe(400);
    expect(addStatementLineService).not.toHaveBeenCalled();
  });

  it("400s a body with a negative amount", async () => {
    const res = await postLine(adminSession, { chargeType: "tnb", description: "x", amount: "-1.00" });
    expect(res.status).toBe(400);
  });

  it("400s a body with an empty description", async () => {
    const res = await postLine(adminSession, { chargeType: "tnb", description: "", amount: "1.00" });
    expect(res.status).toBe(400);
  });

  it("returns 400 Invalid JSON body for malformed JSON", async () => {
    const res = await makeApp(adminSession).request(`/statements/${INVOICE}/lines`, {
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
      const res = await postLine(adminSession, addBody);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});

function patchLine(session: SessionPayload | null, body: unknown) {
  return makeApp(session).request(`/statements/${INVOICE}/lines/${CHARGE}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("PATCH /statements/:id/lines/:chargeId (edit line = admin)", () => {
  it("admin gets 200; id + chargeId + patch forwarded", async () => {
    const res = await patchLine(adminSession, patchBody);
    expect(res.status).toBe(200);
    expect(updateStatementLineService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "admin" }),
      INVOICE,
      CHARGE,
      expect.objectContaining({ amount: "300.00", expectedUpdatedAt: "2026-06-15T00:00:00.000Z" }),
    );
  });

  it("403s for a manager", async () => {
    const res = await patchLine(managerSession, patchBody);
    expect(res.status).toBe(403);
    expect(updateStatementLineService).not.toHaveBeenCalled();
  });

  it("maps a service 409 stale to HTTP 409 with the exact message", async () => {
    vi.mocked(updateStatementLineService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Record changed — reloaded",
    });
    const res = await patchLine(adminSession, patchBody);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Record changed — reloaded" });
  });

  it("maps a service 404 (line not on statement) to HTTP 404", async () => {
    vi.mocked(updateStatementLineService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Line not found on this statement",
    });
    const res = await patchLine(adminSession, patchBody);
    expect(res.status).toBe(404);
  });

  it("400s a PATCH missing expectedUpdatedAt (required by statementLinePatch)", async () => {
    const res = await patchLine(adminSession, { amount: "5.00" });
    expect(res.status).toBe(400);
    expect(updateStatementLineService).not.toHaveBeenCalled();
  });

  it("400s a no-op PATCH carrying only expectedUpdatedAt (refine: amount|description required)", async () => {
    const res = await patchLine(adminSession, { expectedUpdatedAt: "2026-06-15T00:00:00.000Z" });
    expect(res.status).toBe(400);
    // No service call → no Charge.updatedAt bump, no empty-diff audit row.
    expect(updateStatementLineService).not.toHaveBeenCalled();
  });
});

function voidLine(session: SessionPayload | null) {
  return makeApp(session).request(`/statements/${INVOICE}/lines/${CHARGE}/void`, {
    method: "POST",
  });
}

describe("POST /statements/:id/lines/:chargeId/void (void line = admin)", () => {
  it("admin gets 200; id + chargeId forwarded", async () => {
    const res = await voidLine(adminSession);
    expect(res.status).toBe(200);
    // P3 Task 5: the route always forwards a (possibly-undefined) reason body —
    // ENABLE_PHASE2_BILLING_DOCS is dark in this file, so the 4th arg is undefined.
    expect(voidStatementLineService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "admin" }),
      INVOICE,
      CHARGE,
      undefined,
    );
  });

  it("403s for a manager", async () => {
    const res = await voidLine(managerSession);
    expect(res.status).toBe(403);
    expect(voidStatementLineService).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await voidLine(ownerPortalSession);
    expect(res.status).toBe(403);
  });

  it("maps a service 404 to HTTP 404", async () => {
    vi.mocked(voidStatementLineService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Line not found on this statement",
    });
    const res = await voidLine(adminSession);
    expect(res.status).toBe(404);
  });

  it("404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await voidLine(adminSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});
