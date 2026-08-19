-- AlterTable: add legalEntityName to OrganizationCardSettings.
-- Nullable + no default; admin sets via Card Settings page. Document
-- templates fall back to Organization.name when null.

ALTER TABLE "OrganizationCardSettings" ADD COLUMN "legalEntityName" TEXT;
