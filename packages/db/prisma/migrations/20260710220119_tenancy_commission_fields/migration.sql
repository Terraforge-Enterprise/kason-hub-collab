-- AlterTable
-- NOTE: Prisma's diff engine also proposed
--   ALTER TABLE "Party" ALTER COLUMN "idNumberNormalized" DROP DEFAULT;
-- here. That statement is a false diff caused by pre-existing, unrelated
-- drift: schema.prisma declares Party.idNumberNormalized as a plain field,
-- but migration 20260706120000_party_id_number_normalized created it as a
-- Postgres GENERATED ALWAYS AS (...) STORED column via raw SQL. Postgres
-- rejects DROP DEFAULT on a generated column (SQLSTATE 42601), and Task 1 is
-- scoped to additive Tenancy columns only -- the statement was removed here,
-- out of scope for this migration.
ALTER TABLE "Tenancy" ADD COLUMN     "commissionSstBearer" TEXT NOT NULL DEFAULT 'owner',
ADD COLUMN     "firstMonthIsCommission" BOOLEAN NOT NULL DEFAULT false;
