-- Per-Room Unit Media — CONTRACT phase.
--
-- Drops the legacy Apartment-level media columns now that all reads/writes
-- live on Listing (per spec 2026-05-24). Pair to the earlier
-- `20260524100000_per_room_unit_media` (EXPAND) migration which added the
-- Listing columns and backfilled them from Apartment.
--
-- Run order across environments:
--   1. expand migration runs → both old + new columns coexist
--   2. application code deploys → reads/writes Listing.* only
--   3. operator manually verifies (SQL diff Apartment.* vs Unit.*, UI smoke)
--   4. THIS contract migration runs → Apartment columns dropped
--
-- After this point, rollback to apartment-level media requires restoring
-- columns from backup or running a new ADD COLUMN migration with a
-- reverse-backfill from Listing.

ALTER TABLE "Apartment" DROP COLUMN "photoKeys";
ALTER TABLE "Apartment" DROP COLUMN "videoKeys";
ALTER TABLE "Apartment" DROP COLUMN "coverPhotoKey";
