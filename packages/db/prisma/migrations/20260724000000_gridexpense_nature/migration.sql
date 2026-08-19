-- GridExpense per-row Expense/Profit "nature" routing (gridexpense-nature): additive,
-- NULLABLE `nature` column on GridExpense. Forward-only. Domain "expense" | "profit" is
-- validated in the app (not a DB enum), matching the sibling Charge.nature column and the
-- other string routing columns (bearer/fundedBy/revenueRecognition/…). NULL = "expense"
-- (today's EB / owner-deduction routing, backward-compatible). No backfill: legacy rows
-- stay NULL and route exactly as before. Rollback = DROP COLUMN "nature".
ALTER TABLE "GridExpense" ADD COLUMN "nature" TEXT;
