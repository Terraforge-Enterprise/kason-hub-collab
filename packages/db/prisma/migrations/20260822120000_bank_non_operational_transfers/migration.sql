ALTER TABLE "BankReconciliationTransaction"
  ADD COLUMN "transactionCategory" TEXT,
  ADD COLUMN "destinationAccount" TEXT,
  ADD COLUMN "transferPurpose" TEXT;

CREATE INDEX "BankReconciliationTransaction_organizationId_transactionCategory_transactionDate_idx"
  ON "BankReconciliationTransaction"("organizationId", "transactionCategory", "transactionDate");
