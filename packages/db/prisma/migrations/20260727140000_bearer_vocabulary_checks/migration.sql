-- Data-integrity pass 3 (2026-07-27): the bearer family.
--
-- 13 CHECK constraints across 7 tables. Chosen deliberately over the other remaining
-- money vocabularies because "who bears this cost — owner or tenant" SURVIVES the
-- accounting collapse the client asked for on 2026-07-27. That direction explicitly
-- keeps WiFi/Cleaning as "just Owner-or-Tenant" and kills the Profit/Expense nature
-- question instead. Constraining docType / ChargeCategory / OwnerLedgerEntry.category
-- / commercialPurpose / revenueRecognition / settlementRecipient right now would
-- encode vocabularies that are about to be deleted, so they are left alone.
--
-- Prisma cannot express CHECK; these live in SQL only. Drift guard at
-- apps/api/src/modules/billing/__tests__/charge-vocabulary-constraints.integration.test.ts
-- (a DEVELOPER check — no workflow sets RUN_INTEGRATION).
--
-- PRE-FLIGHT (run before writing this file): zero violating rows in LOCAL and in UAT.
-- Prod was NOT queried — cd-prod-deploy.yml:7 runs no migrations, so prod applies
-- nothing here automatically; whoever performs the manual prod catch-up must re-run
-- the same pre-flight first.

-- ─────────────────────────────────────────────────────────────────────────────
-- A. The 12 owner|tenant bearers.
--
-- EVIDENCE (unanimous):
--   • Zod       : `bearer = z.enum(["owner","tenant"])`  shared/schemas/bills-grid.ts:13
--                 `utilityBearer = z.enum(["owner","tenant"]).optional()`  schemas/meter.ts:66
--   • Defaults  : every column defaults to 'owner' except GridExpense.bearer ('tenant')
--   • Writes    : no bearer write anywhere in scripts/ or prisma/seed.ts (zero grep hits);
--                 every api write is a literal 'owner'/'tenant' or a Zod-validated value
--   • Swept data: local ∪ UAT hold only {owner, tenant}
-- All 12 are NOT NULL with defaults, so no NULL case arises.
--
-- NOTE: a DTO mapper deliberately tolerates an out-of-vocabulary bearer by excluding it
-- from totals (proved by bills-grid/__tests__/row-dto-mappers.test.ts:141). That branch
-- becomes unreachable for stored rows once these constraints exist; the test still passes
-- because it exercises the mapper in isolation, not the database.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "UnitUtilityBill"        ADD CONSTRAINT "UnitUtilityBill_indahWaterBearer_check"        CHECK ("indahWaterBearer"     IN ('owner','tenant'));
ALTER TABLE "UnitUtilityBill"        ADD CONSTRAINT "UnitUtilityBill_cleaningBearer_check"          CHECK ("cleaningBearer"       IN ('owner','tenant'));
ALTER TABLE "UnitUtilityBill"        ADD CONSTRAINT "UnitUtilityBill_wifiBearer_check"              CHECK ("wifiBearer"           IN ('owner','tenant'));

ALTER TABLE "UnitBillsGridEntry"     ADD CONSTRAINT "UnitBillsGridEntry_cleaningBearer_check"       CHECK ("cleaningBearer"       IN ('owner','tenant'));
ALTER TABLE "UnitBillsGridEntry"     ADD CONSTRAINT "UnitBillsGridEntry_wifiBearer_check"           CHECK ("wifiBearer"           IN ('owner','tenant'));
ALTER TABLE "UnitBillsGridEntry"     ADD CONSTRAINT "UnitBillsGridEntry_maintenanceFeeBearer_check" CHECK ("maintenanceFeeBearer" IN ('owner','tenant'));

ALTER TABLE "UnitBillsBearerConfig"  ADD CONSTRAINT "UnitBillsBearerConfig_cleaningBearer_check"       CHECK ("cleaningBearer"       IN ('owner','tenant'));
ALTER TABLE "UnitBillsBearerConfig"  ADD CONSTRAINT "UnitBillsBearerConfig_wifiBearer_check"           CHECK ("wifiBearer"           IN ('owner','tenant'));
ALTER TABLE "UnitBillsBearerConfig"  ADD CONSTRAINT "UnitBillsBearerConfig_maintenanceFeeBearer_check" CHECK ("maintenanceFeeBearer" IN ('owner','tenant'));

ALTER TABLE "GridExpense"            ADD CONSTRAINT "GridExpense_bearer_check"                      CHECK ("bearer" IN ('owner','tenant'));
ALTER TABLE "RecurringChargeRevision" ADD CONSTRAINT "RecurringChargeRevision_bearer_check"         CHECK ("bearer" IN ('owner','tenant'));
ALTER TABLE "GridEntryRecurringLine"  ADD CONSTRAINT "GridEntryRecurringLine_bearer_check"          CHECK ("bearer" IN ('owner','tenant'));

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Tenancy.commissionSstBearer — owner|KAEN, NOT owner|tenant.
--
-- NEAR-MISS WORTH RECORDING: this column carries the "Bearer" suffix and sits in the
-- same conceptual family, but its vocabulary is DIFFERENT — the tenant never bears the
-- SST on KAEN's own letting commission. Swept data shows only {owner} because 'kaen'
-- has not been exercised yet, so BOTH the name and the data would have led to the wrong
-- constraint. Only the Zod enum revealed it:
--   z.enum(["owner","kaen"])  — was inline in schemas/tenancy.ts x2 and schemas/inventory.ts x1
-- Lumping this into section A would have broken the letting-commission SST feature the
-- first time an admin selected KAEN.
--
-- Those three inline copies are now consolidated into COMMISSION_SST_BEARER
-- (shared/constants/statuses.ts) so this CHECK has one source of truth to bind against.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_commissionSstBearer_check" CHECK ("commissionSstBearer" IN ('owner','kaen'));

-- Plain CHECK (no NOT VALID / VALIDATE split): every target table is small, and Prisma
-- runs the file in one transaction so the split buys nothing here — see the note in
-- 20260727130000. Use the split form if any of these tables ever grows large.
