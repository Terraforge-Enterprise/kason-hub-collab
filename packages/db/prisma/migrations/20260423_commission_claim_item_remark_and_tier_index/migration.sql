-- Rescue migration — recovers two schema items that the Prisma schema has
-- long described but that never reached Supabase. They were defined in the
-- root-only `prisma/migrations/20260420_commission_settings_revision`
-- migration which was superseded before it ever ran against prod. When the
-- root `prisma/` tree is deleted as part of the 2026-04-23 consolidation,
-- those two items would be lost without this rescue.
--
-- Both are additive and safe:
--   1. CommissionClaimItem.remark is nullable, so existing rows don't need
--      a default. API already declares the field (packages/db/prisma/schema.prisma),
--      so post-migration the client stops lying about DB shape.
--   2. AgentTierMapping(organizationId, createdAt) is a plain btree index —
--      no data changes, no locks beyond the CREATE INDEX itself.

ALTER TABLE "CommissionClaimItem" ADD COLUMN "remark" VARCHAR(1000);

CREATE INDEX "AgentTierMapping_organizationId_createdAt_idx"
  ON "AgentTierMapping"("organizationId", "createdAt");
