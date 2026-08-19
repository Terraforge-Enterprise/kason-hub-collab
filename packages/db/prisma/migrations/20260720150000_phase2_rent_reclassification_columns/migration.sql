-- Spec 1 rent-reclassification (Phase 1): additive, nullable classification columns.
-- Forward-only; no backfill; all new columns nullable or defaulted.
ALTER TABLE "Charge"
  ADD COLUMN "commercialPurpose" TEXT,
  ADD COLUMN "provenanceType" TEXT,
  ADD COLUMN "provenanceId" UUID,
  ADD COLUMN "nonBillable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "economicClassificationStatus" TEXT,
  ADD COLUMN "economicClassificationReason" TEXT;

ALTER TABLE "BillingDocument"
  ADD COLUMN "commercialDocumentType" TEXT,
  ADD COLUMN "ledgerTreatment" TEXT,
  ADD COLUMN "principalOwnerId" UUID,
  ADD COLUMN "collectedOnBehalfOfOwnerId" UUID,
  ADD COLUMN "ownerRefDiffersReason" TEXT,
  ADD COLUMN "legacyClassification" TEXT;
