-- Per-bill owner/tenant bearer for non-electricity utilities + owner-borne utilities snapshot.
-- Additive only (nullable / defaulted). Reversible: DROP the four columns.
ALTER TABLE "UnitUtilityBill" ADD COLUMN "indahWaterBearer" TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE "UnitUtilityBill" ADD COLUMN "cleaningBearer" TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE "UnitUtilityBill" ADD COLUMN "wifiBearer" TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE "UnitUtilityBill" ADD COLUMN "ownerBorneUtilities" DECIMAL(12,2);
