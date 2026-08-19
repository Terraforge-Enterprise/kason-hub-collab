-- Reverts owner_ledger_utility_unique. Run manually: psql "$DATABASE_URL" -f down.sql ; then DELETE its row from "_prisma_migrations".
DROP INDEX IF EXISTS "OwnerLedgerEntry_org_sourceType_sourceUtilityBillId_key";
