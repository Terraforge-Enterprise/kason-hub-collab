/**
 * Canonical POST-ONLY statement statuses an owner may see / download.
 *
 * Single source of truth shared by the portal statement reads (sections / proofs /
 * proof-pack in portal.owner-statements.routes.ts) AND the multi-month export
 * (multi-month-export.service.ts). "draft" and "void" are intentionally excluded:
 * a draft month's figures are still in flux and its evidence must never be served.
 *
 * Mirrors DOWNLOADABLE_STATUSES in apps/web/src/pages/portal/owner-statement.tsx —
 * keep both in sync.
 *
 * Lives in its own tiny module (rather than in the routes file) so the export
 * service can reuse it WITHOUT an import cycle back through the portal routes.
 */
export const PORTAL_VISIBLE_STATEMENT_STATUSES = new Set<string>([
  "sent",
  "approved",
  "paid",
  "partial",
]);
