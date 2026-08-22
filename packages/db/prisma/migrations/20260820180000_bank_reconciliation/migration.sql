CREATE TABLE "BankReconciliationAccount" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "bankName" TEXT NOT NULL,
  "nickname" TEXT NOT NULL,
  "maskedAccountNumber" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BankReconciliationAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BankReconciliationTransaction" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "transactionDate" DATE NOT NULL,
  "description" TEXT NOT NULL,
  "reference" TEXT,
  "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "balance" DECIMAL(14,2),
  "source" TEXT NOT NULL DEFAULT 'manual',
  "importBatchKey" TEXT,
  "fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unmatched',
  "apartmentId" UUID,
  "responsibility" TEXT,
  "gridExpenseId" UUID,
  "chargeRequired" BOOLEAN NOT NULL DEFAULT false,
  "matchNotes" TEXT,
  "categorizedById" UUID,
  "categorizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BankReconciliationTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BankReconciliationTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankReconciliationAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BankReconciliationTransaction_amount_check" CHECK ("debit" >= 0 AND "credit" >= 0 AND NOT ("debit" > 0 AND "credit" > 0)),
  CONSTRAINT "BankReconciliationTransaction_status_check" CHECK ("status" IN ('unmatched','matched','review')),
  CONSTRAINT "BankReconciliationTransaction_responsibility_check" CHECK ("responsibility" IS NULL OR "responsibility" IN ('tenant','owner','company','pending'))
);

CREATE INDEX "BankReconciliationAccount_organizationId_active_idx" ON "BankReconciliationAccount"("organizationId", "active");
CREATE UNIQUE INDEX "BankReconciliationTransaction_organizationId_accountId_fingerprint_key" ON "BankReconciliationTransaction"("organizationId", "accountId", "fingerprint");
CREATE INDEX "BankReconciliationTransaction_organizationId_status_transactionDate_idx" ON "BankReconciliationTransaction"("organizationId", "status", "transactionDate");
CREATE INDEX "BankReconciliationTransaction_organizationId_apartmentId_chargeRequired_idx" ON "BankReconciliationTransaction"("organizationId", "apartmentId", "chargeRequired");
CREATE INDEX "BankReconciliationTransaction_organizationId_gridExpenseId_idx" ON "BankReconciliationTransaction"("organizationId", "gridExpenseId");
