ALTER TABLE "UnitReservation"
  ADD COLUMN "disabledClauseIndexes" INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN "termsAddendum" TEXT,
  ADD COLUMN "approvalReviewedAt" TIMESTAMP(3),
  ADD COLUMN "approvalReviewedById" UUID,
  ADD COLUMN "approvalNote" TEXT;
