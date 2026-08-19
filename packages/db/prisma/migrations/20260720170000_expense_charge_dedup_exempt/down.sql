-- Rollback: restore the prior predicate (recurring-exempt only, no expense exemption).
DROP INDEX IF EXISTS "Charge_unit_category_month_amount_active_key";
CREATE UNIQUE INDEX "Charge_unit_category_month_amount_active_key"
  ON "Charge" ("unitId", "categoryId", "billingMonth", "amount")
  WHERE "status" NOT IN ('void', 'credited') AND "categoryId" IS NOT NULL AND "sourceRecurringLineId" IS NULL;
