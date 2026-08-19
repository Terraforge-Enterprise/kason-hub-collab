-- charge-nature gate (2026-07-27): per-unit DEFAULT Expense/Profit nature for the
-- cleaning / wifi SCALAR, set in the Unit setting drawer.
--
-- Additive + reversible: two NULLABLE text columns, no default, no backfill. NULL means
-- "the admin has never decided", which is exactly the state the new bill-time gate
-- (billableNatureUnresolved, apps/api/src/modules/bills-grid/service.ts) fails closed on
-- under ENABLE_CHARGE_NATURE_ROUTING. Deliberately NOT defaulted to 'profit': a default
-- would silently re-create the assumption this gate exists to remove (an unconfigured WiFi
-- scalar billing the OWNER as manager profit on an IVOWN).
--
-- Rollback: ALTER TABLE "UnitBillsBearerConfig" DROP COLUMN "cleaningNature", DROP COLUMN "wifiNature";
ALTER TABLE "UnitBillsBearerConfig"
  ADD COLUMN "cleaningNature" TEXT,
  ADD COLUMN "wifiNature"     TEXT;
