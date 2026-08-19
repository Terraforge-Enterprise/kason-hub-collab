-- CreateTable
CREATE TABLE "CreditApplication" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "creditDocumentId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedById" UUID NOT NULL,

    CONSTRAINT "CreditApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditApplication_organizationId_creditDocumentId_idx" ON "CreditApplication"("organizationId", "creditDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditApplication_paymentId_key" ON "CreditApplication"("paymentId");

-- AddForeignKey
ALTER TABLE "CreditApplication" ADD CONSTRAINT "CreditApplication_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditApplication" ADD CONSTRAINT "CreditApplication_creditDocumentId_fkey" FOREIGN KEY ("creditDocumentId") REFERENCES "BillingDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditApplication" ADD CONSTRAINT "CreditApplication_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS lockdown (deny-all default; API connects as table owner and bypasses RLS)
ALTER TABLE "CreditApplication" ENABLE ROW LEVEL SECURITY;
