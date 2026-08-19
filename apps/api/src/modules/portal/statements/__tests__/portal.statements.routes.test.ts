/**
 * Route-level tests for the owner-portal own-statements surface (Task E3).
 *
 * Mirrors the E1 financials route-test harness
 * (modules/portal/financials/__tests__/portal.financials.routes.test.ts): the
 * repository + storage are mocked so the DB / Supabase are never reached, and the
 * statements router is mounted under the SAME portalUserTypeGuard("owner") the
 * portal index applies, so the 403 path is exercised the way production wires it.
 *
 * THE critical contract is cross-owner isolation: owner A may list only A's
 * statements and may download only A's PDF; requesting owner B's statement id
 * resolves to a 404 (the repository's owner+org scope returns null → 404). When
 * ENABLE_PHASE2_OWNER_BILLING is OFF the surface is dark (empty list / 404).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Hono } from "hono";
import type { PortalEnv, PortalSessionPayload } from "../../auth/portal.auth.types";

// Mock the repository so the DB is never reached — route tested in isolation.
vi.mock("../portal.statements.repository", () => ({
  listOwnStatements: vi.fn(),
  findOwnStatementPdfKey: vi.fn(),
  getOwnStatementDetail: vi.fn(),
  listOwnStatementDocuments: vi.fn(),
  findOwnStatementDocument: vi.fn(),
}));

// Mock storage so no Supabase signed-URL call is made.
vi.mock("../../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
}));

// Mock the billing-documents PDF service so the /documents/:docId/pdf route is
// tested in isolation (no DB, no Chromium render).
vi.mock("../../../billing-documents/pdf.service", () => ({
  getBillingDocumentPdfUrl: vi.fn(),
}));

import { portalStatementsRoutes } from "../portal.statements.routes";
import {
  listOwnStatements,
  findOwnStatementPdfKey,
  getOwnStatementDetail,
  listOwnStatementDocuments,
  findOwnStatementDocument,
} from "../portal.statements.repository";
import { createSignedDownloadUrl } from "../../../../lib/storage";
import { getBillingDocumentPdfUrl } from "../../../billing-documents/pdf.service";
import { portalUserTypeGuard } from "../../portal.middleware";

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STMT_A = "11111111-1111-4111-8111-111111111111";
const STMT_B = "22222222-2222-4222-8222-222222222222";

function ownerSession(partyId: string): PortalSessionPayload {
  return {
    userId: `user-${partyId.slice(0, 4)}`,
    orgId: "org-1",
    role: "viewer",
    userType: "owner",
    partyId,
    iat: 0,
    absoluteExp: 0,
  };
}

const agentSession: PortalSessionPayload = {
  userId: "user-agent",
  orgId: "org-1",
  role: "viewer",
  userType: "agent",
  partyId: "agent-party",
  iat: 0,
  absoluteExp: 0,
};

/** Build the app the way portal/index.ts mounts statements: owner-guard + router. */
function makeApp(session: PortalSessionPayload | null) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.use("/statements/*", portalUserTypeGuard("owner"));
  app.route("/statements", portalStatementsRoutes);
  return app;
}

const statementsA = [
  { id: STMT_A, periodMonth: "2026-06-01T00:00:00.000Z", status: "approved", totalAmount: "316.00", netRemittance: "1184.00" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
  delete process.env.ENABLE_PHASE2_BILLING_DOCS;
});

describe("GET /statements — flag OFF (dark)", () => {
  it("returns an empty list and never touches the repository", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    const res = await makeApp(ownerSession(OWNER_A)).request("/statements?month=2026-06");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { month: "2026-06", statements: [] } });
    expect(listOwnStatements).not.toHaveBeenCalled();
  });
});

describe("GET /statements — flag ON (own list only)", () => {
  it("lists ONLY this owner's statements, scoped to the owner+org", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    vi.mocked(listOwnStatements).mockResolvedValue(statementsA as never);

    const res = await makeApp(ownerSession(OWNER_A)).request("/statements?month=2026-06");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.month).toBe("2026-06");
    expect(body.data.statements).toEqual(statementsA);
    // Repository invoked with owner A's scope + the month filter.
    expect(listOwnStatements).toHaveBeenCalledWith(
      { partyId: OWNER_A, orgId: "org-1" },
      "2026-06",
    );
  });

  it("owner A's request is scoped to A — owner B's partyId never reaches the repo", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    vi.mocked(listOwnStatements).mockImplementation(async (scope) => {
      expect(scope.partyId).toBe(OWNER_A);
      expect(scope.partyId).not.toBe(OWNER_B);
      return statementsA as never;
    });

    const res = await makeApp(ownerSession(OWNER_A)).request("/statements");
    expect(res.status).toBe(200);
    // No month query → repo called with undefined month.
    expect(listOwnStatements).toHaveBeenCalledWith({ partyId: OWNER_A, orgId: "org-1" }, undefined);
  });
});

const detailA = {
  id: STMT_A,
  periodMonth: "2026-06-01T00:00:00.000Z",
  status: "approved",
  currency: "MYR",
  totalAmount: "316.00",
  sstAmount: "16.00",
  collectedRent: "1500.00",
  totalDeductions: "316.00",
  netRemittance: "1184.00",
  lines: [
    {
      id: "line-fee",
      chargeNumber: "OSC-202606-0001",
      chargeType: "management_fee",
      unitId: "unit-1",
      description: "Management fee",
      amount: "200.00",
      currency: "MYR",
      status: "posted",
    },
    {
      id: "line-clean",
      chargeNumber: "OSC-202606-0002",
      chargeType: "cleaning",
      unitId: "unit-1",
      description: "Cleaning",
      amount: "100.00",
      currency: "MYR",
      status: "posted",
    },
  ],
  feeBreakdown: { percentLabel: "10%", base: "200.00", sst: "16.00", total: "216.00" },
};

describe("GET /statements/:id — flag ON (own detail with lines + totals)", () => {
  it("returns the owner's OWN statement detail: lines + netRemittance/feeBreakdown", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    vi.mocked(getOwnStatementDetail).mockResolvedValue(detailA as never);

    const res = await makeApp(ownerSession(OWNER_A)).request(`/statements/${STMT_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(STMT_A);
    expect(body.data.lines).toHaveLength(2);
    expect(body.data.netRemittance).toBe("1184.00");
    expect(body.data.feeBreakdown).toEqual({ percentLabel: "10%", base: "200.00", sst: "16.00", total: "216.00" });
    // The repo was queried with owner A's scope + the requested id.
    expect(getOwnStatementDetail).toHaveBeenCalledWith({ partyId: OWNER_A, orgId: "org-1" }, STMT_A);
  });

  it("CROSS-OWNER ISOLATION: owner A requesting owner B's statement id → 404, no detail leaked", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    // Owner+org scope in the repo returns null for a statement that is not A's.
    vi.mocked(getOwnStatementDetail).mockResolvedValue(null);

    const res = await makeApp(ownerSession(OWNER_A)).request(`/statements/${STMT_B}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Statement not found" });
    // The repo was queried with owner A's scope (B's data can never resolve).
    expect(getOwnStatementDetail).toHaveBeenCalledWith({ partyId: OWNER_A, orgId: "org-1" }, STMT_B);
  });

  it("404 (dark) when the flag is off — never touches the repo", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    const res = await makeApp(ownerSession(OWNER_A)).request(`/statements/${STMT_A}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(getOwnStatementDetail).not.toHaveBeenCalled();
  });
});

describe("GET /statements/:id/pdf — flag ON", () => {
  it("returns a signed URL for the owner's OWN statement that has a pdfKey", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    vi.mocked(findOwnStatementPdfKey).mockResolvedValue({ pdfKey: "owner-statements/org-1/202606.pdf" });

    const res = await makeApp(ownerSession(OWNER_A)).request(`/statements/${STMT_A}/pdf`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.downloadUrl).toBe("https://signed.example/owner-statements/org-1/202606.pdf");
    expect(findOwnStatementPdfKey).toHaveBeenCalledWith({ partyId: OWNER_A, orgId: "org-1" }, STMT_A);
    expect(createSignedDownloadUrl).toHaveBeenCalledWith("owner-statements/org-1/202606.pdf");
  });

  it("CROSS-OWNER ISOLATION: owner A requesting owner B's statement id → 404, no URL minted", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    // Owner+org scope in the repo returns null for a statement that is not A's.
    vi.mocked(findOwnStatementPdfKey).mockResolvedValue(null);

    const res = await makeApp(ownerSession(OWNER_A)).request(`/statements/${STMT_B}/pdf`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Statement not found" });
    // The repo was queried with owner A's scope (B's data can never resolve).
    expect(findOwnStatementPdfKey).toHaveBeenCalledWith({ partyId: OWNER_A, orgId: "org-1" }, STMT_B);
    // No signed URL is minted for a statement that isn't the caller's.
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("404 'PDF not generated' when the OWN statement exists but has no pdfKey", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    vi.mocked(findOwnStatementPdfKey).mockResolvedValue({ pdfKey: null });

    const res = await makeApp(ownerSession(OWNER_A)).request(`/statements/${STMT_A}/pdf`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "PDF not generated" });
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("404 (dark) when the flag is off — never touches the repo or storage", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    const res = await makeApp(ownerSession(OWNER_A)).request(`/statements/${STMT_A}/pdf`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(findOwnStatementPdfKey).not.toHaveBeenCalled();
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });
});

const statementDocsA = [
  {
    id: "doc-ivown-1",
    docType: "invoice",
    documentNumber: "IVOWN-0001",
    status: "issued",
    issuedAt: "2026-06-30T00:00:00.000Z",
    total: "216.00",
    reason: null,
  },
];

describe("GET /statements/:id/documents — flag ON (docs behind ONE own statement)", () => {
  it("returns the accounting documents linked to the owner's OWN statement", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    vi.mocked(listOwnStatementDocuments).mockResolvedValue(statementDocsA as never);

    const res = await makeApp(ownerSession(OWNER_A)).request(`/statements/${STMT_A}/documents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { documents: statementDocsA } });
    expect(listOwnStatementDocuments).toHaveBeenCalledWith({ partyId: OWNER_A, orgId: "org-1" }, STMT_A);
  });

  it("CROSS-OWNER ISOLATION: owner A requesting owner B's statement id → 404, no documents leaked", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    // The repo's owner+org scope resolves null for a statement that isn't A's.
    vi.mocked(listOwnStatementDocuments).mockResolvedValue(null);

    const res = await makeApp(ownerSession(OWNER_A)).request(`/statements/${STMT_B}/documents`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Statement not found" });
    expect(listOwnStatementDocuments).toHaveBeenCalledWith({ partyId: OWNER_A, orgId: "org-1" }, STMT_B);
  });

  it("empty list (dark) when the flag is off — never touches the repo", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const res = await makeApp(ownerSession(OWNER_A)).request(`/statements/${STMT_A}/documents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { documents: [] } });
    expect(listOwnStatementDocuments).not.toHaveBeenCalled();
  });
});

describe("GET /statements/documents/:docId/pdf — flag ON", () => {
  it("returns the signed url for ONE of this owner's accounting documents", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    vi.mocked(findOwnStatementDocument).mockResolvedValue({ id: "doc-ivown-1" });
    vi.mocked(getBillingDocumentPdfUrl).mockResolvedValue({ url: "https://signed/ivown-1.pdf" });

    const res = await makeApp(ownerSession(OWNER_A)).request("/statements/documents/doc-ivown-1/pdf");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { downloadUrl: "https://signed/ivown-1.pdf" } });
    expect(findOwnStatementDocument).toHaveBeenCalledWith({ partyId: OWNER_A, orgId: "org-1" }, "doc-ivown-1");
  });

  it("CROSS-OWNER ISOLATION: a document that isn't this owner's → 404, no url minted", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    vi.mocked(findOwnStatementDocument).mockResolvedValue(null);

    const res = await makeApp(ownerSession(OWNER_A)).request("/statements/documents/doc-other/pdf");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Document not found" });
    expect(getBillingDocumentPdfUrl).not.toHaveBeenCalled();
  });

  it("404 (dark) when the flag is off — never touches the repo", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const res = await makeApp(ownerSession(OWNER_A)).request("/statements/documents/doc-ivown-1/pdf");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(findOwnStatementDocument).not.toHaveBeenCalled();
  });
});

describe("statements — userType guard", () => {
  it("403 for a non-owner userType (agent) on the list", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(agentSession).request("/statements?month=2026-06");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(listOwnStatements).not.toHaveBeenCalled();
  });

  it("403 for a non-owner userType (agent) on the pdf download", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(agentSession).request(`/statements/${STMT_A}/pdf`);
    expect(res.status).toBe(403);
    expect(findOwnStatementPdfKey).not.toHaveBeenCalled();
  });

  it("403 for a non-owner userType (agent) on the detail", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(agentSession).request(`/statements/${STMT_A}`);
    expect(res.status).toBe(403);
    expect(getOwnStatementDetail).not.toHaveBeenCalled();
  });

  it("403 when there is no session at all", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(null).request("/statements?month=2026-06");
    expect(res.status).toBe(403);
  });
});
