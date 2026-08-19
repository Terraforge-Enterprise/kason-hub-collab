-- AlterTable
-- Phase-0 agency-accounting economic-treatment fields on Charge (additive,
-- nullable, forward-only — no backfill; see schema.prisma comment on model
-- Charge for field semantics). Nothing reads these columns yet (Tasks 2/5/8
-- will consume them). Hand-written (not `prisma migrate diff`) because this
-- worktree's `.env` points at the shared local `kaenproperties` dev DB, which
-- currently carries a sibling branch's `OwnerStatementPeriod` table/migration
-- not present in this branch's `prisma/migrations/` history; running the
-- differ with `--from-migrations` requires a shadow database (not configured
-- here — see prisma.config.ts, no shadowDatabaseUrl), and `--from-url` would
-- have diffed against the live DB and emitted a destructive
-- `DROP TABLE "OwnerStatementPeriod"` neither branch wants. The 11 statements
-- below are typed to exactly match the corresponding `schema.prisma` field
-- declarations (7 plain String? -> TEXT, actualCost/markupAmount Decimal?
-- @db.Decimal(12,2) -> DECIMAL(12,2), taxRate Decimal? @db.Decimal(5,2) ->
-- DECIMAL(5,2), taxDeterminedAt DateTime? (no @db.Date) -> TIMESTAMP(3)) and
-- formatted to match this repo's existing Prisma-generated `ALTER TABLE
-- "Charge" ADD COLUMN ...` migrations (e.g. 20260611105334_phase2_foundation).
ALTER TABLE "Charge" ADD COLUMN     "fundedBy" TEXT,
ADD COLUMN     "revenueRecognition" TEXT,
ADD COLUMN     "settlementRecipient" TEXT,
ADD COLUMN     "sourceSupplier" TEXT,
ADD COLUMN     "sourceInvoiceIssuedTo" TEXT,
ADD COLUMN     "actualCost" DECIMAL(12,2),
ADD COLUMN     "markupAmount" DECIMAL(12,2),
ADD COLUMN     "taxTreatment" TEXT,
ADD COLUMN     "taxRate" DECIMAL(5,2),
ADD COLUMN     "taxReason" TEXT,
ADD COLUMN     "taxDeterminedAt" TIMESTAMP(3);
