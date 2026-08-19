-- Widen Unit.depositMonths from INTEGER to DECIMAL(4,2) so the rental
-- deposit can be stored as a half-month value (e.g. 2.5). The Decimal
-- precision matches utilitiesDepositMonths so both fields use the same
-- scale across the schema. Existing integer values (2 → 2.00) are
-- preserved verbatim by the implicit cast; the @default(2) on the
-- column carries through.
ALTER TABLE "Unit"
  ALTER COLUMN "depositMonths" TYPE DECIMAL(4, 2)
  USING "depositMonths"::DECIMAL(4, 2);
