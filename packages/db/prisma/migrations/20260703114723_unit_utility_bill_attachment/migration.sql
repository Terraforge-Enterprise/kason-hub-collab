-- CreateTable
CREATE TABLE "UnitUtilityBillAttachment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "billId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitUtilityBillAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnitUtilityBillAttachment_organizationId_billId_idx" ON "UnitUtilityBillAttachment"("organizationId", "billId");

-- AddForeignKey
ALTER TABLE "UnitUtilityBillAttachment" ADD CONSTRAINT "UnitUtilityBillAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitUtilityBillAttachment" ADD CONSTRAINT "UnitUtilityBillAttachment_billId_fkey" FOREIGN KEY ("billId") REFERENCES "UnitUtilityBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
