-- Proforma spec R3/R5 (2026-08-10) — the graduation link.
--
-- Set on a graduated `invoice` pointing at the `proforma` its lines came from. Null on
-- every other document. NOT `originalDocumentId`: four paths read that column's NULL as
-- the "head of chain" sentinel, so reusing it would make a graduated invoice invisible to
-- the credit-note and grid-provenance paths.
--
-- Additive and nullable: no data rewrite, no column drop, no type change. Safe to apply
-- with ENABLE_PROFORMA_INVOICES off — the column is inert until the graduation hook
-- writes it, and existing rows are unaffected.
ALTER TABLE "BillingDocument" ADD COLUMN "proformaDocumentId" UUID;

-- Serves R5's immutability check (`proformaDocumentId IS NOT NULL` excludes a document
-- from the grid's reclaimable set) and the graduation idempotency lookup, both of which
-- are org-scoped.
CREATE INDEX "BillingDocument_organizationId_proformaDocumentId_idx"
  ON "BillingDocument"("organizationId", "proformaDocumentId");
