-- Backfill billingMonth on pre-existing active categorized charges so the
-- Spec2-R1 duplicate-charge dedup (which keys on billingMonth) is not blind to
-- rows created before this feature (the old create path set categoryId but left
-- billingMonth NULL). Without this, a NULL-billingMonth row is invisible to BOTH
-- guards -- the check-first misses it (`NULL = <date>` is never true) and the
-- partial unique index has no NULLS NOT DISTINCT (it treats NULL as distinct) --
-- so re-creating an identical charge silently double-charges.
--
-- Derived to match createChargeService's firstOfMonthUtc(dueDate.slice(0,7)):
-- the UTC first-of-month of the charge's due date. Charge.dueDate is a
-- Postgres `date` (@db.Date, no time/zone), so date_trunc('month', "dueDate")
-- yields that month's 1st exactly (verified by round-trip against local Postgres).
--
-- Idempotent (WHERE billingMonth IS NULL). The status/categoryId predicate is
-- the SAME as the two partial unique indexes from migration
-- 20260706120000_charge_duplicate_prevention, so this backfills exactly the rows
-- those indexes cover -- legacy (categoryId NULL) and void/credited rows stay NULL.
-- Data-only migration: no schema change, so no RLS / changelog impact.
UPDATE "Charge"
SET "billingMonth" = date_trunc('month', "dueDate")::date
WHERE "billingMonth" IS NULL
  AND "status" NOT IN ('void', 'credited')
  AND "categoryId" IS NOT NULL;
