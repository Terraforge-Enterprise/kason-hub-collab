-- Add sourcing fields to Property so agents can submit new properties to
-- the source queue (mirror of Unit's sourcing pattern, additive only).
-- Stored as String (not enum) to align with SalesUnit.sourceFlag.
ALTER TABLE "Property"
  ADD COLUMN "sourceFlag"            TEXT NOT NULL DEFAULT 'COMPANY',
  ADD COLUMN "sourcingAgentId"       UUID,
  ADD COLUMN "sourcingApproved"      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sourcingApprovedById"  UUID,
  ADD COLUMN "sourcingApprovedAt"    TIMESTAMP(3),
  ADD COLUMN "sourcingAmendmentNote" TEXT,
  ADD COLUMN "sourcingCancelled"     BOOLEAN NOT NULL DEFAULT false;

-- FKs (mirror of Unit; SET NULL on delete so audit history is preserved).
ALTER TABLE "Property"
  ADD CONSTRAINT "Property_sourcingAgentId_fkey"
    FOREIGN KEY ("sourcingAgentId") REFERENCES "Party"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Property_sourcingApprovedById_fkey"
    FOREIGN KEY ("sourcingApprovedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial index for the source queue: pending agent submissions only.
CREATE INDEX "Property_sourcing_pending_idx"
  ON "Property" ("organizationId", "sourcingAgentId", "sourcingApproved")
  WHERE "sourceFlag" = 'AGENT_SOURCED' AND "sourcingCancelled" = false;
