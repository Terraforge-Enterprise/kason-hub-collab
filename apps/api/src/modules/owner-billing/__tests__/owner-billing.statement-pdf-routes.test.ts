import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Mock the service so the DB / Storage / Chromium are never reached — routes
// tested in isolation (mirrors owner-billing.statement-status-routes.test.ts).
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
  regenerateStatementPdf: vi.fn(),
  getStatementPdfUrl: vi.fn(),
  createCleaningBillService: vi.fn(),
  updateCleaningBillService: vi.fn(),
  voidCleaningBillService: vi.fn(),
}));

vi.mock("../owner-billing-receipts.service", () => ({
  uploadReceiptsService: vi.fn(),
  detachReceiptService: vi.fn(),
}));

import { ownerBillingRoutes } from "../owner-billing.routes";
import { regenerateStatementPdf, getStatementPdfUrl } from "../owner-billing.service";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerBillingRoutes);
  return app;
}

const INVOICE = "44444444-4444-4444-8444-444444444444";

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };
const ownerPortalSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});
afterAll(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(regenerateStatementPdf).mockResolvedValue({
    ok: true,
    status: 200,
    data: { pdfKey: "owner-statements/o/202606.pdf", downloadUrl: "https://signed.example/os.pdf" },
  });
  vi.mocked(getStatementPdfUrl).mockResolvedValue({
    ok: true,
    status: 200,
    data: { downloadUrl: "https://signed.example/os.pdf" },
  });
});

function regenerate(session: SessionPayload | null) {
  return makeApp(session).request(`/statements/${INVOICE}/regenerate-pdf`, { method: "POST" });
}
function getPdf(session: SessionPayload | null) {
  return makeApp(session).request(`/statements/${INVOICE}/pdf`, { method: "GET" });
}

describe("POST /statements/:id/regenerate-pdf (admin)", () => {
  it("admin can regenerate; id + ctx forwarded; returns pdfKey + downloadUrl", async () => {
    const res = await regenerate(adminSession);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { pdfKey: string; downloadUrl: string } };
    expect(json.data.pdfKey).toBe("owner-statements/o/202606.pdf");
    expect(json.data.downloadUrl).toBe("https://signed.example/os.pdf");
    expect(regenerateStatementPdf).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      INVOICE,
    );
  });

  it("403s for a manager (regenerate requires admin)", async () => {
    const res = await regenerate(managerSession);
    expect(res.status).toBe(403);
    expect(regenerateStatementPdf).not.toHaveBeenCalled();
  });

  it("403s for an editor", async () => {
    const res = await regenerate(editorSession);
    expect(res.status).toBe(403);
  });

  it("403s for a portal (owner) session", async () => {
    const res = await regenerate(ownerPortalSession);
    expect(res.status).toBe(403);
  });

  it("401s for a missing session", async () => {
    const res = await regenerate(null);
    expect(res.status).toBe(401);
  });

  it("maps a service 404 to HTTP 404", async () => {
    vi.mocked(regenerateStatementPdf).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Statement not found",
    });
    const res = await regenerate(adminSession);
    expect(res.status).toBe(404);
  });

  it("404s while the flag is dark, before the role check", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await regenerate(adminSession);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});

describe("GET /statements/:id/pdf (manager)", () => {
  it("manager can fetch; returns the signed download URL", async () => {
    const res = await getPdf(managerSession);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { downloadUrl: string } };
    expect(json.data.downloadUrl).toBe("https://signed.example/os.pdf");
    expect(getStatementPdfUrl).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "manager" }),
      INVOICE,
    );
  });

  it("admin can fetch too (manager+ allowed)", async () => {
    const res = await getPdf(adminSession);
    expect(res.status).toBe(200);
  });

  it("403s for an editor (below manager)", async () => {
    const res = await getPdf(editorSession);
    expect(res.status).toBe(403);
    expect(getStatementPdfUrl).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await getPdf(ownerPortalSession);
    expect(res.status).toBe(403);
  });

  it("maps a service 404 (no pdfKey) to HTTP 404", async () => {
    vi.mocked(getStatementPdfUrl).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "PDF not generated",
    });
    const res = await getPdf(managerSession);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "PDF not generated" });
  });

  it("404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await getPdf(managerSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});
