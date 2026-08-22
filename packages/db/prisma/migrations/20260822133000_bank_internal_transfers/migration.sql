ALTER TABLE "BankReconciliationTransaction"
  ADD COLUMN "internalTransferPairId" UUID;

CREATE INDEX "BankReconciliationTransaction_organizationId_internalTransferPairId_idx"
  ON "BankReconciliationTransaction"("organizationId", "internalTransferPairId");
