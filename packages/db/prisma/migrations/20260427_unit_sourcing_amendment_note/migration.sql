-- Inventory rental-side parity with SalesUnit: capture rejection / amendment
-- notes from manager review of agent-sourced Units. Mirrors
-- SalesUnit.amendmentNotes added in 20260427070753.
ALTER TABLE "Unit" ADD COLUMN "sourcingAmendmentNote" TEXT;
