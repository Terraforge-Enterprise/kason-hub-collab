-- Scheduled auto-billing: the day of month on which an org's DRAFT rental
-- invoices are automatically BILLED (approved → charges posted → tenant-visible).
--
-- NULL = OFF, and NULL is the default, so this migration changes the behaviour of
-- exactly ZERO existing orgs. Every org keeps the human approval gate until an
-- admin sets a day. That direction matters: the opposite default would silently
-- post live receivables for every tenant the next time the cron fired.
--
-- ADDITIVE + REVERSIBLE: a nullable column on a per-org singleton table that holds
-- schedule policy only, never amounts. No backfill, no row rewritten.
--
-- Rollback: ALTER TABLE "DraftConfig" DROP COLUMN "autoBillDayOfMonth";

ALTER TABLE "DraftConfig"
  ADD COLUMN "autoBillDayOfMonth" INTEGER;

-- Bound the day in the database too, not only in zod — same reasoning as
-- DraftConfig_billPeriodOffset_range. Capped at 28 so the day exists in every
-- month (February included); a 31 would silently never fire in four months of
-- the year, which for a BILLING date is a money-visible bug, not a cosmetic one.
-- The constraint is NOT NULL-hostile on purpose: NULL passes a CHECK, which is
-- exactly right here because NULL means "auto-billing is off".
ALTER TABLE "DraftConfig"
  ADD CONSTRAINT "DraftConfig_autoBillDayOfMonth_range"
  CHECK ("autoBillDayOfMonth" IS NULL OR ("autoBillDayOfMonth" >= 1 AND "autoBillDayOfMonth" <= 28));
