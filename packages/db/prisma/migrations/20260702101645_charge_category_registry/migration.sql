-- AlterTable
ALTER TABLE "Charge" ADD COLUMN     "categoryId" UUID;

-- CreateTable
CREATE TABLE "ChargeCategory" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "seriesId" UUID NOT NULL,
    "defaultSstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "eInvoiceEligible" BOOLEAN NOT NULL DEFAULT false,
    "ledgerCategory" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargeCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSeries" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "includeYear" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSeries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChargeCategory_organizationId_active_sortOrder_idx" ON "ChargeCategory"("organizationId", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ChargeCategory_organizationId_code_key" ON "ChargeCategory"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ChargeCategory_organizationId_name_key" ON "ChargeCategory"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSeries_organizationId_code_key" ON "DocumentSeries"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Charge_organizationId_categoryId_idx" ON "Charge"("organizationId", "categoryId");

-- AddForeignKey
ALTER TABLE "ChargeCategory" ADD CONSTRAINT "ChargeCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeCategory" ADD CONSTRAINT "ChargeCategory_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "DocumentSeries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSeries" ADD CONSTRAINT "DocumentSeries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ChargeCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Enable RLS (deny-all posture, no CREATE POLICY — the Hono API connects as the
-- postgres superuser; RLS is defense-in-depth vs direct anon/authenticated access).
ALTER TABLE "ChargeCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentSeries" ENABLE ROW LEVEL SECURITY;
