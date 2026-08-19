-- Bill-expenses feature (final review fix): exempt expense charges from the amount-based
-- duplicate-prevention index.
--
-- The partial unique index Charge_unit_category_month_amount_active_key
-- (unitId, categoryId, billingMonth, amount) was built for meter/utility charges, whose
-- categories already differ per utility, so two live charges never coincide there. Expense
-- charges (mintExpenseChargesTx, chargeType "expense") that have NO picked category all fall
-- back to ONE of exactly two seeded categories (other_expense_tenant / other_expense_owner),
-- so two DISTINCT GridExpense rows for the SAME tenancy/bearer with the SAME amount in one
-- month (e.g. two RM50 tenant expenses) would collide and fail the whole Bill with a raw
-- Prisma P2002 — rolling back the utility charges too.
--
-- Expense charges carry their OWN idempotency instead: a unique chargeNumber
-- (GRIDEXP-<ym>-<expenseId>[-r<revision>]) under @@unique(organizationId, chargeNumber),
-- plus the re-Bill credit-then-reissue supersede path (old charges → status 'credited'
-- before the fresh mint) — the SAME argument as the recurring-charge exemption
-- (20260720130000_recurring_charge_dedup_exempt). So exempt any charge carrying a
-- sourceGridExpenseId from the amount index, on top of the existing recurring exemption.
--
-- Additive + reversible: utility/meter/manual/recurring charges (sourceGridExpenseId NULL)
-- keep the full amount-based duplicate guarantee unchanged. The carpark index is untouched —
-- expense charges never carry a carparkId (NULL never collides in that index).
DROP INDEX IF EXISTS "Charge_unit_category_month_amount_active_key";
CREATE UNIQUE INDEX "Charge_unit_category_month_amount_active_key"
  ON "Charge" ("unitId", "categoryId", "billingMonth", "amount")
  WHERE "status" NOT IN ('void', 'credited') AND "categoryId" IS NOT NULL AND "sourceRecurringLineId" IS NULL AND "sourceGridExpenseId" IS NULL;
