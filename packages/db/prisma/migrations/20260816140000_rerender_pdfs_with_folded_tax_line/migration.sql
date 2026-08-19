-- Re-render the cached PDFs that still print the SST sibling as its own line item.
--
-- `getBillingDocumentPdfUrl` is render-ONCE: if `pdfKey` is set it returns the stored
-- object and never rebuilds the model. So folding the tax line in
-- `buildBillingDocumentPdfModel` reaches only documents whose PDF has not been generated
-- yet — every already-downloaded invoice would keep serving the three-row layout whose
-- Amount column sums to the TOTAL while the Subtotal printed underneath reads lower.
-- That PDF is the copy the tenant and the owner actually receive, so leaving it stale
-- would fix the screen and not the document.
--
-- Clearing the key is the established way to retire a stale render: charge-adjustment.
-- service.ts:241 already does exactly this when a credit/debit note changes an invoice's
-- totals ("clear the render-once key so the next download re-renders").
--
-- SAFE, and narrower than that precedent:
--   • pdfKey is a CACHE, not a money field (pdf.service.ts:418).
--   • Scoped to documents that actually carry an isTax line — nothing else is touched.
--   • The re-render reads the SAME immutable lines and totals. subtotal, sstAmount,
--     total and every line amount are byte-identical; only the tax line stops being
--     printed as a separate row. No money figure changes.
--   • The orphaned S3 object is left in place (harmless); the next GET writes a new one
--     under the same deterministic key `billing-documents/{orgId}/{docId}.pdf`.
UPDATE "BillingDocument"
SET "pdfKey" = NULL
WHERE "pdfKey" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "BillingDocumentLine" l
    WHERE l."documentId" = "BillingDocument".id
      AND l."isTax" = true
  );
