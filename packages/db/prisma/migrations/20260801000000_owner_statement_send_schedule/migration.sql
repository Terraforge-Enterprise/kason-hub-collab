-- Owner-statement auto-send schedule: WHEN the just-ended month's frozen owner
-- statements go out, in the ORG'S OWN timezone (Organization."timezone"), never UTC.
--
-- ADDITIVE + REVERSIBLE: two defaulted NOT NULL columns on a per-org singleton
-- table. No backfill, no row rewritten in a way that changes money — Organization
-- holds policy, never amounts. Every existing org gets "the 3rd at 09:00 local".
--
-- Rollback:
--   ALTER TABLE "Organization" DROP COLUMN "ownerStatementSendDay";
--   ALTER TABLE "Organization" DROP COLUMN "ownerStatementSendHour";

ALTER TABLE "Organization"
  ADD COLUMN "ownerStatementSendDay" INTEGER NOT NULL DEFAULT 3;

ALTER TABLE "Organization"
  ADD COLUMN "ownerStatementSendHour" INTEGER NOT NULL DEFAULT 9;

-- Bound the schedule in the database too, not only in zod: a stray API client or a
-- manual psql UPDATE must not be able to park the send day somewhere it can never
-- fire.
--
-- Day is capped at 28 ON PURPOSE. February has no 29th in common years, so a
-- sendDay of 29/30/31 would make the statement silently never go out in those
-- months — a missing-money-document bug that reports as "nothing happened".
ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_ownerStatementSendDay_range"
  CHECK ("ownerStatementSendDay" >= 1 AND "ownerStatementSendDay" <= 28);

ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_ownerStatementSendHour_range"
  CHECK ("ownerStatementSendHour" >= 0 AND "ownerStatementSendHour" <= 23);
