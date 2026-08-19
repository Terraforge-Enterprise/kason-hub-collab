-- BillingDocumentLine.isTax — persist what the mint already knew.
--
-- `mintExpenseChargesTx` (bills-grid) mints an SST sibling Charge so the tax has a
-- row a payment can settle; `issueGroupedGridInvoiceTx` marks its document line
-- `isTax` and `issueDocumentTx` excludes it from `subtotal`. That flag lived only
-- on the mint INPUT and was dropped before persistence, so no reader could tell a
-- tax line from a real one: an IVOWN with one SST-bearing expense rendered three
-- rows whose Amount column summed to the TOTAL (1.88) while the document printed
-- Subtotal 1.80 underneath — unreconcilable, and the same RM 0.08 shown twice.
--
-- Additive and reversible: NOT NULL with a false default, so every existing row is
-- correct-by-default and only the backfill below flips the genuine tax lines.
ALTER TABLE "BillingDocumentLine" ADD COLUMN "isTax" BOOLEAN NOT NULL DEFAULT false;

-- Backfill. The SST sibling is recognised by its charge NUMBER, the same structural
-- signal `isExpenseSstChargeNumber` (bills-grid/issue-grouped.ts) uses:
--   /^GRIDEXP-.+-SST(-r\d+)?$/
-- `-SST` sits BEFORE the re-Bill `-r<n>` suffix, so revised documents match too.
-- Scoped through the Charge join, so a line whose description merely mentions SST
-- can never be swept in.
--
-- ⚠️ docType SCOPE IS MONEY-CRITICAL, not tidiness. `isTax` means "this line's amount is
-- ALREADY counted via a sibling's rate, so it was excluded from this document's stored
-- subtotal". That is only true where the mint actually passed the flag —
-- `issueGroupedGridInvoiceTx`, which mints `invoice` and `debit_note` and nothing else.
--
-- Other document kinds COPY an invoice's lines and drop the flag on the way:
-- receipts.service.ts:85-90 and oea-backfill.ts:117-122 both build lines with only
-- {chargeId, categoryId, description, amount, sstRate}. issueDocumentTx therefore counted
-- the sibling INTO their stored subtotal. Flipping `isTax` on one of those lines after the
-- fact would make `foldTaxLines` erase a row whose amount the document's own subtotal still
-- includes — a receipt that prints one RM 1.00 row under a Subtotal of RM 1.08, with the
-- RM 0.08 the payer actually paid appearing nowhere.
--
-- Rows minted AFTER this migration are safe either way (those services still omit the flag,
-- so their lines default to false and render in full). This clause protects the rows that
-- already exist.
UPDATE "BillingDocumentLine" l
SET "isTax" = true
FROM "Charge" c, "BillingDocument" d
WHERE c.id = l."chargeId"
  AND d.id = l."documentId"
  AND d."docType" IN ('invoice', 'debit_note')
  AND c."chargeNumber" ~ '^GRIDEXP-.+-SST(-r[0-9]+)?$';
