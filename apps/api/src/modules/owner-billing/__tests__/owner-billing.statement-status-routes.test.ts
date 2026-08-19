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
  approveStatementService: vi.fn(),
  voidStatementService: vi.fn(),
  sendStatementService: vi.fn(),
}));

import { ownerBillingRoutes } from "../owner-billing.routes";
import {
  approveStatementService,
  sendStatementService,
  voidStatementService,
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

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };
const ownerPortalSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

const statementRow = {
  id: INVOICE,
  invoiceNumber: "OS-202606-11111111",
  invoiceType: "owner_statement",
  status: "approved",
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
  lines: [],
  createdAt: "2026-06-15T00:00:00.000Z",
  updatedAt: "2026-06-15T00:00:00.000Z",
};

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
  vi.mocked(approveStatementService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { ...statementRow, status: "approved" },
  });
  vi.mocked(voidStatementService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { ...statementRow, status: "void" },
  });
  vi.mocked(sendStatementService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { statement: { ...statementRow, status: "sent" }, downloadUrl: "https://signed.example/os.pdf" },
  });
});

function approve(session: SessionPayload | null) {
  return makeApp(session).request(`/statements/${INVOICE}/approve`, { method: "POST" });
}
function voidStatement(session: SessionPayload | null) {
  return makeApp(session).request(`/statements/${INVOICE}/void`, { method: "POST" });
}
function send(session: SessionPayload | null) {
  return makeApp(session).request(`/statements/${INVOICE}/send`, { method: "POST" });
}

describe("POST /statements/:id/approve (approve = admin)", () => {
  it("admin can approve; id + ctx forwarded", async () => {
    const res = await approve(adminSession);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: typeof statementRow };
    expect(json.data.status).toBe("approved");
    expect(approveStatementService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      INVOICE,
    );
  });

  it("403s for a manager (approve now requires admin)", async () => {
    const res = await approve(managerSession);
    expect(res.status).toBe(403);
    expect(approveStatementService).not.toHaveBeenCalled();
  });

  it("403s for an editor (below admin)", async () => {
    const res = await approve(editorSession);
    expect(res.status).toBe(403);
    expect(approveStatementService).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await approve(ownerPortalSession);
    expect(res.status).toBe(403);
  });

  it("401s for a missing session", async () => {
    const res = await approve(null);
    expect(res.status).toBe(401);
  });

  it("maps a service 409 (non-draft) to HTTP 409", async () => {
    vi.mocked(approveStatementService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Statement can no longer be approved",
    });
    const res = await approve(adminSession);
    expect(res.status).toBe(409);
  });

  it("maps a service 404 to HTTP 404", async () => {
    vi.mocked(approveStatementService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Statement not found",
    });
    const res = await approve(adminSession);
    expect(res.status).toBe(404);
  });

  it("404s while the flag is dark, before the role check", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await approve(adminSession);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});

describe("POST /statements/:id/void (void = admin)", () => {
  it("admin can void; id + ctx forwarded", async () => {
    const res = await voidStatement(adminSession);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: typeof statementRow };
    expect(json.data.status).toBe("void");
    // P3 Task 5: the route always forwards a (possibly-undefined) reason body —
    // ENABLE_PHASE2_BILLING_DOCS is dark in this file, so the 3rd arg is undefined.
    expect(voidStatementService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "admin" }),
      INVOICE,
      undefined,
    );
  });

  it("403s for a manager (void requires admin)", async () => {
    const res = await voidStatement(managerSession);
    expect(res.status).toBe(403);
    expect(voidStatementService).not.toHaveBeenCalled();
  });

  it("403s for an editor", async () => {
    const res = await voidStatement(editorSession);
    expect(res.status).toBe(403);
  });

  it("maps a service 409 (paid) to HTTP 409", async () => {
    vi.mocked(voidStatementService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Statement can no longer be voided",
    });
    const res = await voidStatement(adminSession);
    expect(res.status).toBe(409);
  });

  it("maps a service 404 to HTTP 404", async () => {
    vi.mocked(voidStatementService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Statement not found",
    });
    const res = await voidStatement(adminSession);
    expect(res.status).toBe(404);
  });

  it("404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await voidStatement(adminSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});

describe("POST /statements/:id/send (send = admin; soft-copy only)", () => {
  it("admin can send; returns the statement + signed download URL", async () => {
    const res = await send(adminSession);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { statement: typeof statementRow; downloadUrl: string };
    };
    expect(json.data.statement.status).toBe("sent");
    expect(json.data.downloadUrl).toBe("https://signed.example/os.pdf");
    expect(sendStatementService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "admin" }),
      INVOICE,
    );
  });

  it("403s for a manager (send now requires admin)", async () => {
    const res = await send(managerSession);
    expect(res.status).toBe(403);
    expect(sendStatementService).not.toHaveBeenCalled();
  });

  it("403s for an editor (below admin)", async () => {
    const res = await send(editorSession);
    expect(res.status).toBe(403);
    expect(sendStatementService).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await send(ownerPortalSession);
    expect(res.status).toBe(403);
  });

  it("maps a service 409 (draft) to HTTP 409", async () => {
    vi.mocked(sendStatementService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Statement must be approved before it can be sent",
    });
    const res = await send(adminSession);
    expect(res.status).toBe(409);
  });

  it("maps a service 400 (no pdfKey) to HTTP 400", async () => {
    vi.mocked(sendStatementService).mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: "Generate the statement PDF before sending",
    });
    const res = await send(adminSession);
    expect(res.status).toBe(400);
  });

  it("maps a service 404 to HTTP 404", async () => {
    vi.mocked(sendStatementService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Statement not found",
    });
    const res = await send(adminSession);
    expect(res.status).toBe(404);
  });

  it("404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await send(adminSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});
