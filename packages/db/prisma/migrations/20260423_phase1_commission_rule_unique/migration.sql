-- Enforce one CommissionRule per (organization, side, effectiveFrom).
-- Prevents duplicate rate rows that would make commission evaluation
-- non-deterministic. See review finding Schema #4 (MEDIUM).

CREATE UNIQUE INDEX "CommissionRule_organizationId_side_effectiveFrom_key"
    ON "CommissionRule"("organizationId", "side", "effectiveFrom");
