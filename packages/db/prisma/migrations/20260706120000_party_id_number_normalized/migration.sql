-- R3 infra: normalized IC/passport number for exact-match lookup (e.g. a
-- future reservation -> tenancy conversion matching an existing tenant by
-- NRIC). GENERATED ALWAYS ... STORED so it can never drift from `idNumber`
-- at read time; Postgres itself rejects any direct write to this column
-- (SQLSTATE 428C9), independent of application code.
--
-- MUST mirror normalizeIc() in apps/api/src/lib/normalize-ic.ts exactly:
--   (value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase()
-- Verified empirically (local Postgres 16.13) that JS RegExp and Postgres's
-- regexp_replace agree on this exact character class for the input shapes
-- that matter here (CJK/non-ASCII scripts, Latin-1 supplement letters like
-- "ß", embedded whitespace/tabs, NULL) -- see
-- apps/api/src/lib/__tests__/normalize-ic.test.ts and
-- normalize-ic-column.integration.test.ts for the parity proof.
--
-- NOTE for whoever promotes this to main/uat: unlike a plain nullable
-- ADD COLUMN (metadata-only in PG11+), ADD COLUMN ... GENERATED ... STORED
-- forces a full table rewrite under an ACCESS EXCLUSIVE lock, blocking all
-- Party traffic for the duration. Harmless on this local dev DB's tiny Party
-- table; schedule off-peak against a production-sized one.
--
-- NOTE: a NULL or separator-only idNumber normalizes to '' (empty string),
-- NOT NULL (coalesce(...,'') runs first). Any future lookup keyed on this
-- column MUST reject an empty/blank normalized search value up front, or it
-- will match every Party without an idNumber.
ALTER TABLE "Party" ADD COLUMN "idNumberNormalized" text
  GENERATED ALWAYS AS (upper(regexp_replace(coalesce("idNumber", ''), '[^A-Za-z0-9]', '', 'g'))) STORED;
CREATE INDEX "party_idnum_norm" ON "Party" ("organizationId", "idNumberNormalized");
