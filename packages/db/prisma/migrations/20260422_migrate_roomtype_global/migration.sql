-- RoomType was per-property; commit a720d29 promoted it to organization-scoped
-- (dropped propertyId, added sortOrder). Prod Supabase never received the
-- migration so RoomType queries failed once API code referenced the new shape.
--
-- Existing per-property duplicates are de-duped by (organizationId, name) —
-- keeping the oldest ctid per pair.

DELETE FROM "RoomType" rt
USING "RoomType" rt2
WHERE rt."ctid" < rt2."ctid"
  AND rt."organizationId" = rt2."organizationId"
  AND rt."name" = rt2."name";

ALTER TABLE "RoomType" DROP CONSTRAINT "RoomType_propertyId_fkey";
DROP INDEX "RoomType_organizationId_propertyId_name_key";
DROP INDEX "RoomType_organizationId_propertyId_isActive_idx";
ALTER TABLE "RoomType" DROP COLUMN "propertyId";

ALTER TABLE "RoomType" ADD COLUMN "sortOrder" integer NOT NULL DEFAULT 0;

CREATE INDEX "RoomType_organizationId_isActive_sortOrder_idx"
  ON "RoomType"("organizationId", "isActive", "sortOrder");
CREATE INDEX "RoomType_organizationId_createdAt_idx"
  ON "RoomType"("organizationId", "createdAt");
