-- AlterTable (additive, nullable — existing rows unaffected)
-- NOTE: Prisma's diff engine also proposed
--   ALTER TABLE "Party" ALTER COLUMN "idNumberNormalized" DROP DEFAULT;
-- here. This is the same pre-existing false diff documented in
-- 20260710220119_tenancy_commission_fields/migration.sql: schema.prisma
-- declares Party.idNumberNormalized as a plain field, but it was created as
-- a Postgres GENERATED ALWAYS AS (...) STORED column via raw SQL. DROP
-- DEFAULT on a generated column errors (SQLSTATE 42601), and this migration
-- is scoped to the additive BillingDocument.paymentId column only — the
-- statement is omitted here, out of scope (P2 T5, R13).
ALTER TABLE "BillingDocument" ADD COLUMN     "paymentId" UUID;

-- CreateIndex
CREATE INDEX "BillingDocument_organizationId_paymentId_idx" ON "BillingDocument"("organizationId", "paymentId");
