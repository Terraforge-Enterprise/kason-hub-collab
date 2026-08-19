-- charge-nature-expense-profit-routing Fix 2: the SCALAR WiFi/Cleaning path carries `nature`.
-- Additive, nullable TEXT columns on UnitBillsGridEntry, sourced from the CLEANING/WIFI
-- recurring definition's effective revision at materialize time. Values: "expense" | "profit"
-- (NULL = legacy → KAEN service revenue, byte-identical to pre-feature). Read only by the
-- flag-gated (ENABLE_CHARGE_NATURE_ROUTING) mint. No backfill: legacy rows stay NULL.
ALTER TABLE "UnitBillsGridEntry" ADD COLUMN "cleaningNature" TEXT;
ALTER TABLE "UnitBillsGridEntry" ADD COLUMN "wifiNature" TEXT;
