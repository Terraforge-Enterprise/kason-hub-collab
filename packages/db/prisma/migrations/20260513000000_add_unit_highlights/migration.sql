-- Add free-form per-apartment highlights ("Near KLCC", "Corner unit") to
-- Unit. Apartment-scoped by convention — every sibling row sharing
-- (propertyId, unitCode) carries the same list. Fan-out enforced at the
-- batch service layer (see 2026-05-13 apartment-aggregation-and-highlights
-- design spec). Surfaced on listings + full-text search; not a filter
-- facet.
ALTER TABLE "Unit"
  ADD COLUMN "highlights" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
