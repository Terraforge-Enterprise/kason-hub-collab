-- Accounting-document redesign P1 (2026-07-23): OST-/REM- owner-document display numbering.
-- Two ADDITIVE NULLABLE columns on EXISTING tables (both already RLS-enabled from their
-- original migrations — this migration adds no table, so no new RLS grant is needed).
-- Invoice.statementNumber: OST- number for an owner_statement Invoice, minted at the
--   draft->approved transition (owner-billing.service.ts's approveStatementService).
-- OwnerLedgerEntry.remittanceNumber: REM- number for a real cash-out payout row, minted
--   ONLY at the OWNER_REMITTANCE/PRE_STATEMENT_REMITTANCE write (owner-remittance.service.ts's
--   recordRemittanceService) — never for an OWNER_RECEIVABLE_OFFSET or a reversal row.
-- Both are NEW display numbers gated behind ENABLE_OWNER_DOC_NUMBERING (default OFF); neither
-- replaces an existing identity/dedupe key (Invoice.invoiceNumber's "OS-" slug,
-- OwnerLedgerEntry.idempotencyKey). Forward-only; no backfill; every existing row keeps
-- statementNumber/remittanceNumber = NULL. Generated via `prisma migrate diff` (schema-to-schema,
-- no DB mutation) between HEAD's prisma/schema.prisma and the two-field addition.
-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "statementNumber" TEXT;

-- AlterTable
ALTER TABLE "OwnerLedgerEntry" ADD COLUMN     "remittanceNumber" TEXT;
