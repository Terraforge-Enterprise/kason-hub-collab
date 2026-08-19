-- Data-integrity pass 2 (2026-07-27): the first two column-vocabulary CHECK constraints.
--
-- Scope is deliberately TWO columns. Each one below was traced to its actual write
-- paths and verified against swept data in local + UAT before being constrained.
-- Prisma has no CHECK support, so these live in SQL only; schema.prisma carries a
-- pointer comment. `prisma migrate diff` does not see CHECK constraints, so they do
-- not create schema drift, and `db push` will not drop them. (A shadow DB DOES get
-- them — `migrate dev` rebuilds it by replaying every migration file's raw SQL, and
-- these constraints live in exactly that.) The drift test that keeps them honest is at
-- apps/api/src/modules/billing/__tests__/charge-vocabulary-constraints.integration.test.ts
-- (it needs @kason/shared, which packages/db does not depend on). It is a DEVELOPER
-- check, not a CI gate — no workflow sets RUN_INTEGRATION.
--
-- Both columns are NULLABLE and a CHECK passes on NULL, so no `IS NULL OR` is needed
-- and legacy null rows are unaffected.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Charge.nature  →  'expense' | 'profit'  (or NULL)
--
-- EVIDENCE (all four sources agree — this was the easy one):
--   • Zod input validator : z.enum(["expense","profit"])      bills-grid.ts:95
--   • Shared constant     : PROFIT_EXPENSE = ["profit","expense"]
--   • TS annotations      : `"expense" | "profit" | null` at every call site
--   • Swept data          : local {expense, profit} · UAT {expense}
-- Three sibling tables (GridExpense, RecurringChargeRevision, GridEntryRecurringLine)
-- carry the same vocabulary and feed this column; they are intentionally NOT
-- constrained here — a bad value there now fails loudly at Charge mint time.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Charge"
  ADD CONSTRAINT "Charge_nature_check"
  CHECK ("nature" IN ('expense', 'profit')) NOT VALID;

ALTER TABLE "Charge" VALIDATE CONSTRAINT "Charge_nature_check";

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Charge.fundedBy  →  the 5 FUNDED_BY values (or NULL)
--
-- EVIDENCE — four sources DISAGREED; this is why the column was traced by hand:
--   • Schema comment            : 4 values, omits "tenant_funded"          (STALE)
--   • Shared constant FUNDED_BY : 5 values                                 (chosen)
--   • bills-grid local type     : `"owner" | "manager" | "tenant_direct"`  (narrow)
--   • Actual production writes  : only {owner, manager} ever reach the column —
--       service.ts:1393 returns early on "tenant_direct", so that value is filtered
--       out BEFORE tx.charge.create; service.ts:846 writes owner|manager only.
--   • Swept data                : local {owner, manager} · UAT {owner, manager}
--
-- DECISIVE: a LIVE WRITE PATH can set all 5 today. patchEconomicTreatmentInput
-- (packages/shared/src/schemas/billing.ts:57) declares
--   fundedBy: z.enum(["owner","manager","tenant_direct","tenant_funded","third_party"])
-- and is parsed by PATCH /api/billing/charges/:chargeId/economic-treatment
-- (billing.routes.ts:110, requireWorkspaceOrRank("accounting","manager")) — the admin
-- action that sets a charge's authoritative economic classification. A 2- or 3-value
-- CHECK would 500 that endpoint on a legitimate operator correction.
--
-- So the 5-value FUNDED_BY is not a judgement call, it is the only correct answer.
-- (Secondary support: readers issue.service.ts:407 and billing.routes.ts:127 already
-- cast this column to the 5-value shared `FundedBy` type. Arguing from a WRITER is
-- stronger — a reader casting too wide is merely optimistic, whereas a writer that
-- exceeds the CHECK is an outage.)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Charge"
  ADD CONSTRAINT "Charge_fundedBy_check"
  CHECK ("fundedBy" IN ('owner', 'manager', 'tenant_direct', 'tenant_funded', 'third_party')) NOT VALID;

ALTER TABLE "Charge" VALIDATE CONSTRAINT "Charge_fundedBy_check";

-- Note on NOT VALID + VALIDATE: Prisma runs each migration file inside one
-- transaction, so at present these two steps hold the same lock and are equivalent
-- to a plain CHECK. Charge is small today. The split is written this way so that
-- when Charge is large enough to matter, VALIDATE can be moved to its own migration
-- without changing the ADD.
