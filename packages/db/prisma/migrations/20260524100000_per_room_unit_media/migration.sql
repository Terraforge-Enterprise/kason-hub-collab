-- Per-Room Unit Media — EXPAND phase.
--
-- Splits the original combined migration into expand + contract so UAT (and
-- any future deploy) can verify backfill correctness with both old and new
-- columns coexisting, before the destructive DROP runs in a follow-up
-- contract migration.
--
-- Spec: docs/superpowers/specs/2026-05-24-per-room-unit-media-design.md
--
-- Steps in this file:
--   1. ADD photoKeys / videoKeys / coverPhotoKey on "Unit" (Listing).
--   2. UPDATE backfill — copy each parent Apartment's arrays onto EVERY
--      child Listing of that Apartment. After this, every room's gallery
--      mirrors the legacy apartment-level shared gallery; rooms diverge as
--      admins upload / delete per-room.
--
-- The DROP of Apartment columns runs in a SEPARATE follow-up migration
-- (`*_drop_apartment_media_columns`) AFTER manual verification on each
-- environment. Until that contract migration runs, both old and new
-- columns coexist — old code can still read Apartment.*, new code reads
-- Listing.*.

-- 1. Add columns on Listing (Prisma maps Listing → "Unit").
ALTER TABLE "Unit" ADD COLUMN "photoKeys"     TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Unit" ADD COLUMN "videoKeys"     TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Unit" ADD COLUMN "coverPhotoKey" TEXT;

-- 2. Backfill from parent Apartment. Each child Listing inherits its
--    parent's full arrays.
UPDATE "Unit" u
SET    "photoKeys"     = a."photoKeys",
       "videoKeys"     = a."videoKeys",
       "coverPhotoKey" = a."coverPhotoKey"
FROM   "Apartment" a
WHERE  u."apartmentId" = a.id;
