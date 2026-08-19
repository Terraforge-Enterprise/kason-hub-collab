import { Hono } from "hono";
import { createSignedDownloadUrl } from "../../../lib/storage";
import { isPhase2FlagEnabled } from "../../../lib/feature-flags";
import { getBillingDocumentPdfUrl } from "../../billing-documents/pdf.service";
import type { PortalEnv } from "../auth/portal.auth.types";
import {
  findOwnTenantBillingDocument,
  listDocuments,
  listTenantBillingDocuments,
  verifyFileOwnership,
} from "./portal.documents.repository";

const portalDocumentsRoutes = new Hono<PortalEnv>();

portalDocumentsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const docs = await listDocuments({ partyId: session.partyId, orgId: session.orgId });
  return c.json({ data: docs });
});

// GET /portal-api/documents/billing — THIS tenant's issued accounting documents
// (Invoices/DNs now; CNs/RNs when Plan 3 lands). Own-data-only. While
// ENABLE_PHASE2_BILLING_DOCS is dark the feature is invisible: empty list,
// no DB touch (same dark-pattern as /portal-api/statements).
portalDocumentsRoutes.get("/billing", async (c) => {
  const session = c.get("session");
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
    return c.json({ data: { documents: [] } });
  }
  const documents = await listTenantBillingDocuments({ partyId: session.partyId, orgId: session.orgId });
  return c.json({ data: { documents } });
});

// GET /portal-api/documents/billing/:id/pdf — signed URL for ONE own document.
// Cross-party/unknown → 404 (never leak existence). Dark → 404 (new route).
portalDocumentsRoutes.get("/billing/:id/pdf", async (c) => {
  const session = c.get("session");
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
    return c.json({ error: "not_found" }, 404);
  }
  const own = await findOwnTenantBillingDocument({ partyId: session.partyId, orgId: session.orgId }, c.req.param("id"));
  if (!own) return c.json({ error: "Document not found" }, 404);
  const result = await getBillingDocumentPdfUrl(session.orgId, own.id);
  if (!result) return c.json({ error: "Document not found" }, 404);
  return c.json({ data: { downloadUrl: result.url } });
});

export const portalFileRoutes = new Hono<PortalEnv>();

portalFileRoutes.get("/", async (c) => {
  const session = c.get("session");
  const key = c.req.query("key");

  if (!key || key.length > 1024) {
    return c.json({ error: "Invalid key" }, 400);
  }

  const doc = await verifyFileOwnership({ partyId: session.partyId, orgId: session.orgId }, key);
  if (!doc) return c.json({ error: "Not found" }, 404);

  try {
    const downloadUrl = await createSignedDownloadUrl(doc.storageKey);
    return c.redirect(downloadUrl, 302);
  } catch {
    return c.json({ error: "File storage is unavailable" }, 503);
  }
});

export { portalDocumentsRoutes };
