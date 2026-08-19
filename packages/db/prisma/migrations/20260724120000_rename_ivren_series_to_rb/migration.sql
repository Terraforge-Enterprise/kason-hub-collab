-- Rename the rent document series IVREN -> RB (letting-commission-rb).
--
-- Rent is the OWNER's money passing through KAEN (PAYABLE_TO_OWNER), NOT a KAEN tax
-- "IV"nvoice, so the rent-bill series drops the misleading "IV" prefix. The series is
-- RENAMED, not replaced:
--   * DocumentSeries.code / prefix : IVREN -> RB  (new rent bills mint as RB-####).
--   * ReferenceSequence counter "series:IVREN" -> "series:RB" IN LOCKSTEP — the counter
--     lives in ReferenceSequence keyed docType = 'series:' || DocumentSeries.code
--     (see apps/api/src/lib/reference-codes/series-numbers.ts), so renaming it here keeps
--     RB numbering CONTINUOUS from the same counter (no restart, no risk of a new RB-####
--     colliding with anything).
--   * Legacy IVREN-#### BillingDocuments are DELIBERATELY LEFT UNTOUCHED. Issued documents
--     are immutable: their numbers are referenced by e-invoice (MyInvois) submissions,
--     rendered/cached PDFs, and audit metadata. Their customer-facing "Rental Bill" label
--     still resolves via the IVREN legacy alias kept in pdf.service.ts / document-helpers.ts.
--     (A legacy IVREN-#### doc now points at an RB-coded series row — the label matches the
--     number prefix, not the series code, so resolution is unaffected.)
--
-- Forward-only; a pure rename (no column/type change). IDEMPOTENT: a re-run finds no IVREN
-- rows and no-ops. The NOT EXISTS guards make it safe for an org that already carries an RB
-- series/counter (e.g. freshly seeded on the new code) — that org is left as-is rather than
-- violating @@unique(organizationId, code) / @@unique(organizationId, docType, year).

UPDATE "DocumentSeries" AS ds
   SET "code" = 'RB', "prefix" = 'RB'
 WHERE ds."code" = 'IVREN'
   AND NOT EXISTS (
     SELECT 1 FROM "DocumentSeries" AS d2
      WHERE d2."organizationId" = ds."organizationId"
        AND d2."code" = 'RB'
   );

UPDATE "ReferenceSequence" AS rs
   SET "docType" = 'series:RB'
 WHERE rs."docType" = 'series:IVREN'
   AND NOT EXISTS (
     SELECT 1 FROM "ReferenceSequence" AS r2
      WHERE r2."organizationId" = rs."organizationId"
        AND r2."docType" = 'series:RB'
        AND r2."year" = rs."year"
   );
