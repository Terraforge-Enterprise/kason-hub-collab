import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("../portal.documents.repository", () => ({
  listDocuments: vi.fn(),
  verifyFileOwnership: vi.fn(),
  listTenantBillingDocuments: vi.fn(),
  findOwnTenantBillingDocument: vi.fn(),
}));
vi.mock("../../../billing-documents/pdf.service", () => ({
  getBillingDocumentPdfUrl: vi.fn(),
}));

import { portalDocumentsRoutes } from "../portal.documents.routes";
import { listTenantBillingDocuments, findOwnTenantBillingDocument } from "../portal.documents.repository";
import { getBillingDocumentPdfUrl } from "../../../billing-documents/pdf.service";

type PortalSession = { userId: string; userType: string; partyId: string; orgId: string };
const tenant: PortalSession = { userId: "u1", userType: "tenant", partyId: "p1", orgId: "o1" };

function makeApp(session: PortalSession) {
  const app = new Hono<{ Variables: { session: PortalSession } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", portalDocumentsRoutes);
  return app;
}

const DOC = {
  id: "doc-1", docType: "debit_note", documentNumber: "DEP-0007", status: "issued",
  issuedAt: "2026-07-02T00:00:00.000Z", billingMonth: "2026-07-01", total: "980.00",
  reason: null, originalDocumentNumber: null,
  // Non-credit-note ⇒ no spendable balance to report.
  creditRemaining: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
});

describe("portal tenant billing documents", () => {
  it("GET /billing lists own documents", async () => {
    vi.mocked(listTenantBillingDocuments).mockResolvedValue([DOC]);
    const res = await makeApp(tenant).request("/billing");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { documents: [DOC] } });
    expect(listTenantBillingDocuments).toHaveBeenCalledWith({ partyId: "p1", orgId: "o1" });
  });

  it("GET /billing is an empty list while the flag is dark (no DB touch)", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const res = await makeApp(tenant).request("/billing");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { documents: [] } });
    expect(listTenantBillingDocuments).not.toHaveBeenCalled();
  });

  it("GET /billing/:id/pdf returns the signed url for an OWN document", async () => {
    vi.mocked(findOwnTenantBillingDocument).mockResolvedValue({ id: "doc-1" });
    vi.mocked(getBillingDocumentPdfUrl).mockResolvedValue({ url: "https://signed/x.pdf" });
    const res = await makeApp(tenant).request("/billing/doc-1/pdf");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { downloadUrl: "https://signed/x.pdf" } });
  });

  it("GET /billing/:id/pdf 404s a cross-party document (never leaks existence)", async () => {
    vi.mocked(findOwnTenantBillingDocument).mockResolvedValue(null);
    const res = await makeApp(tenant).request("/billing/doc-other/pdf");
    expect(res.status).toBe(404);
    expect(getBillingDocumentPdfUrl).not.toHaveBeenCalled();
  });

  it("GET /billing/:id/pdf 404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const res = await makeApp(tenant).request("/billing/doc-1/pdf");
    expect(res.status).toBe(404);
  });
});
