-- Recurring-charges feature: exempt recurring custom charges from the amount-based
-- duplicate-prevention index.
--
-- The partial unique index Charge_unit_category_month_amount_active_key
-- (unitId, categoryId, billingMonth, amount) was built for meter/utility charges, whose
-- categories already differ per utility, so two live charges never coincide there. Recurring
-- custom charges all share ONE of exactly two seeded categories (recurring_other_owner /
-- recurring_other_tenant), so two DIFFERENT-named recurring fees of the same amount on one
-- apartment-month (e.g. two RM50 owner fees) would collide and fail to bill.
--
-- Recurring charges carry their OWN idempotency instead: a unique chargeNumber
-- (GRIDRECUR-<ym>-<definitionId>[-r<revision>]) under @@unique(organizationId, chargeNumber),
-- plus the re-Bill credit-then-reissue supersede path (old charges → status 'credited' before
-- the fresh mint). So exempt any charge carrying a sourceRecurringLineId from the amount index.
--
-- Additive + reversible: utility/meter/manual charges (sourceRecurringLineId NULL) keep the
-- full amount-based duplicate guarantee unchanged. The carpark index is untouched — recurring
-- charges never carry a carparkId (NULL never collides in that index).
DROP INDEX IF EXISTS "Charge_unit_category_month_amount_active_key";
CREATE UNIQUE INDEX "Charge_unit_category_month_amount_active_key"
  ON "Charge" ("unitId", "categoryId", "billingMonth", "amount")
  WHERE "status" NOT IN ('void', 'credited') AND "categoryId" IS NOT NULL AND "sourceRecurringLineId" IS NULL;
