-- Reverts 20260521000000_add_legal_entity_name. Run manually:
--   psql $DATABASE_URL < down.sql
-- (Prisma has no native down-migrate; this is the documented revert path.)

ALTER TABLE "OrganizationCardSettings" DROP COLUMN IF EXISTS "legalEntityName";
