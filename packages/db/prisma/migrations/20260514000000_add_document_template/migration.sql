-- CreateTable
CREATE TABLE "DocumentTemplate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "docType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "refPrefix" TEXT NOT NULL DEFAULT '',
    "refSeparator" TEXT NOT NULL DEFAULT '-',
    "refPadding" INTEGER NOT NULL DEFAULT 5,
    "refIncludeYear" BOOLEAN NOT NULL DEFAULT false,
    "headerFields" JSONB NOT NULL DEFAULT '{}',
    "orgRegNo" TEXT,
    "orgSalesTaxId" TEXT,
    "orgServiceTaxId" TEXT,
    "orgAddressLines" JSONB NOT NULL DEFAULT '[]',
    "orgEmail" TEXT,
    "orgContact" TEXT,
    "logoKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentTemplate_organizationId_idx" ON "DocumentTemplate"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_organizationId_docType_key" ON "DocumentTemplate"("organizationId", "docType");

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
