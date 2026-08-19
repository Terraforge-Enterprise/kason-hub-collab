import { Hono } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { isPhase2FlagEnabled } from "../../../lib/feature-flags";
import { createSignedDownloadUrl } from "../../../lib/storage";
import { getBillingDocumentPdfUrl } from "../../billing-documents/pdf.service";
import {
  listOwnStatements,
  findOwnStatementPdfKey,
  getOwnStatementDetail,
  listOwnStatementDocuments,
  findOwnStatementDocument,
} from "./portal.statements.repository";

const portalStatementsRoutes = new Hono<PortalEnv>();

// GET /portal-api/statements?month=YYYY-MM — list THIS owner's owner_statement
// Invoices. Owner+org scoped in the repository (ownerPartyId === session.partyId
// AND organizationId === session.orgId). When ENABLE_PHASE2_OWNER_BILLING is OFF
// the feature is dark: return an empty list without touching the DB.
portalStatementsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const month = c.req.query("month");

  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")) {
    return c.json({ data: { month: month ?? null, statements: [] } });
  }

  const scope = { partyId: session.partyId, orgId: session.orgId };
  const statements = await listOwnStatements(scope, month);
  return c.json({ data: { month: month ?? null, statements } });
});

// GET /portal-api/statements/documents/:docId/pdf — signed URL for ONE of this
// owner's accounting documents (IVOWN/CN). 3 static+param segments — no clash
// with GET /:id. Dark (404) when ENABLE_PHASE2_BILLING_DOCS is off.
portalStatementsRoutes.get("/documents/:docId/pdf", async (c) => {
  const session = c.get("session");
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
    return c.json({ error: "not_found" }, 404);
  }
  const scope = { partyId: session.partyId, orgId: session.orgId };
  const own = await findOwnStatementDocument(scope, c.req.param("docId"));
  if (!own) return c.json({ error: "Document not found" }, 404);
  const result = await getBillingDocumentPdfUrl(session.orgId, own.id);
  if (!result) return c.json({ error: "Document not found" }, 404);
  return c.json({ data: { downloadUrl: result.url } });
});

// GET /portal-api/statements/:id/documents — the accounting documents behind
// ONE own statement (IVOWN invoice + CNs against it). Cross-owner → 404.
// Dark → empty list (the statement page renders nothing).
portalStatementsRoutes.get("/:id/documents", async (c) => {
  const session = c.get("session");
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
    return c.json({ data: { documents: [] } });
  }
  const scope = { partyId: session.partyId, orgId: session.orgId };
  const documents = await listOwnStatementDocuments(scope, c.req.param("id"));
  if (documents === null) return c.json({ error: "Statement not found" }, 404);
  return c.json({ data: { documents } });
});

// GET /portal-api/statements/:id — detail for ONE of THIS owner's statements:
// its non-void child Charge lines + the money rollup (collectedRent /
// totalDeductions / netRemittance + feeBreakdown) the portal financials surface
// and the statement PDF agree on. Owner+org scoped in the repository: a statement
// belonging to a different owner (or org) resolves to null → 404 (never leak its
// existence — the critical cross-owner contract). Dark (404) when the flag is off.
portalStatementsRoutes.get("/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");

  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")) {
    return c.json({ error: "not_found" }, 404);
  }

  const scope = { partyId: session.partyId, orgId: session.orgId };
  const statement = await getOwnStatementDetail(scope, id);
  // Not this owner's statement (cross-owner / cross-org / unknown) → 404.
  if (!statement) {
    return c.json({ error: "Statement not found" }, 404);
  }
  return c.json({ data: statement });
});

// GET /portal-api/statements/:id/pdf — signed download URL for ONE of this
// owner's statements. Owner+org scoped: a statement belonging to a different
// owner resolves to null → 404 (never leak its existence). When the statement
// exists but has no pdfKey → 404 "PDF not generated". Dark (404) when the flag is
// off — these are NEW routes, so there is no prior behavior to preserve.
portalStatementsRoutes.get("/:id/pdf", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");

  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")) {
    return c.json({ error: "not_found" }, 404);
  }

  const scope = { partyId: session.partyId, orgId: session.orgId };
  const result = await findOwnStatementPdfKey(scope, id);
  // Not this owner's statement (cross-owner / cross-org / unknown) → 404.
  if (!result) {
    return c.json({ error: "Statement not found" }, 404);
  }
  // Statement exists but the soft-copy PDF was never generated → 404.
  if (!result.pdfKey) {
    return c.json({ error: "PDF not generated" }, 404);
  }
  const downloadUrl = await createSignedDownloadUrl(result.pdfKey);
  return c.json({ data: { downloadUrl } });
});

export { portalStatementsRoutes };
