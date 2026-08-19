-- CreateTable
CREATE TABLE "BillingDocument" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "docType" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "seriesId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" UUID NOT NULL,
    "billingMonth" DATE,
    "counterpartyType" TEXT NOT NULL,
    "partyId" UUID NOT NULL,
    "tenancyId" UUID,
    "propertyId" UUID,
    "apartmentId" UUID,
    "listingId" UUID,
    "originalDocumentId" UUID,
    "statementInvoiceId" UUID,
    "creditAmount" DECIMAL(12,2),
    "reason" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "sstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "pdfKey" TEXT,
    "idempotencyKey" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingDocumentLine" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "chargeId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "sstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "sstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "BillingDocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingDocument_organizationId_apartmentId_billingMonth_idx" ON "BillingDocument"("organizationId", "apartmentId", "billingMonth");

-- CreateIndex
CREATE INDEX "BillingDocument_organizationId_partyId_docType_idx" ON "BillingDocument"("organizationId", "partyId", "docType");

-- CreateIndex
CREATE INDEX "BillingDocument_organizationId_docType_status_idx" ON "BillingDocument"("organizationId", "docType", "status");

-- CreateIndex
CREATE INDEX "BillingDocument_organizationId_originalDocumentId_idx" ON "BillingDocument"("organizationId", "originalDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingDocument_organizationId_documentNumber_key" ON "BillingDocument"("organizationId", "documentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BillingDocument_organizationId_idempotencyKey_key" ON "BillingDocument"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingDocumentLine_documentId_idx" ON "BillingDocumentLine"("documentId");

-- CreateIndex
CREATE INDEX "BillingDocumentLine_chargeId_idx" ON "BillingDocumentLine"("chargeId");

-- AddForeignKey
ALTER TABLE "BillingDocument" ADD CONSTRAINT "BillingDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingDocumentLine" ADD CONSTRAINT "BillingDocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "BillingDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable RLS (deny-all posture, no CREATE POLICY — the Hono API connects as the
-- postgres superuser; RLS is defense-in-depth vs direct anon/authenticated access).
ALTER TABLE "BillingDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingDocumentLine" ENABLE ROW LEVEL SECURITY;
