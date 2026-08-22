ALTER TABLE "BankReconciliationTransaction"
ADD COLUMN "linkedPaymentId" UUID;

CREATE INDEX "BankReconciliationTransaction_organizationId_linkedPaymentId_idx"
ON "BankReconciliationTransaction"("organizationId", "linkedPaymentId");
