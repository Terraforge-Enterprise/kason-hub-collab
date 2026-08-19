-- Additive: race-safe duplicate-charge prevention (Spec 2 R1). Partial unique
-- indexes cannot be expressed in Prisma @@unique — they live only here.
CREATE UNIQUE INDEX "Charge_unit_category_month_amount_active_key"
  ON "Charge" ("unitId", "categoryId", "billingMonth", "amount")
  WHERE "status" NOT IN ('void', 'credited') AND "categoryId" IS NOT NULL;

CREATE UNIQUE INDEX "Charge_carpark_category_month_amount_active_key"
  ON "Charge" ("carparkId", "categoryId", "billingMonth", "amount")
  WHERE "status" NOT IN ('void', 'credited') AND "categoryId" IS NOT NULL;
