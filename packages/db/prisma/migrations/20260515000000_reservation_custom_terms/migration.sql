-- Per-reservation custom T&C list. Empty array = use bundled defaults
-- unchanged; non-empty = use this list verbatim, ignoring defaults.
ALTER TABLE "UnitReservation"
  ADD COLUMN "customTerms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
