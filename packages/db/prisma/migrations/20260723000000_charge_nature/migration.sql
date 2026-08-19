-- Charge Expense/Profit "nature" routing (Task 2): additive, NULLABLE `nature` column on
-- Charge + the recurring config revision + its per-Bill snapshot line. Forward-only.
-- Domain "expense" | "profit" is validated in the app (not a DB enum), matching the sibling
-- string columns (fundedBy/revenueRecognition/…). Rollback = DROP COLUMN "nature" on each.
ALTER TABLE "RecurringChargeRevision" ADD COLUMN "nature" TEXT;

ALTER TABLE "GridEntryRecurringLine" ADD COLUMN "nature" TEXT;

ALTER TABLE "Charge" ADD COLUMN "nature" TEXT;

-- Backfill: existing recurring config is effectively "profit" today (no EB routing yet), so
-- flipping legacy NULL revisions to 'profit' changes no booked document. Idempotent.
UPDATE "RecurringChargeRevision" SET "nature" = 'profit' WHERE "nature" IS NULL;
