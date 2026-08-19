-- P4 (spec R12a): overpayment Credit Note lines settle no charge and carry no
-- category. Widen BillingDocumentLine.chargeId + categoryId to NULLABLE
-- (additive, reversible). Existing rows keep their non-null values; no rewrite.
BEGIN;

ALTER TABLE "BillingDocumentLine"
  ALTER COLUMN "chargeId" DROP NOT NULL;

ALTER TABLE "BillingDocumentLine"
  ALTER COLUMN "categoryId" DROP NOT NULL;

COMMIT;
