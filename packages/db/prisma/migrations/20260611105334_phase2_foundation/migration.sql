/*
  Warnings:

  - A unique constraint covering the columns `[organizationId,idempotencyKey]` on the table `Payment` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Charge" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" UUID,
ADD COLUMN     "billingMonth" DATE,
ADD COLUMN     "invoiceId" UUID;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "attachmentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "bankCode" TEXT,
ADD COLUMN     "gatewayStatus" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerTxnId" TEXT;

-- AlterTable
ALTER TABLE "PaymentAllocation" ADD COLUMN     "prorateRatio" DECIMAL(5,4);

-- AlterTable
ALTER TABLE "Tenancy" ADD COLUMN     "accessCardNo" TEXT,
ADD COLUMN     "agentLabel" TEXT,
ADD COLUMN     "numberOfPax" INTEGER;

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "unitKind" TEXT;

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "partyId" UUID NOT NULL,
    "ownerPartyId" UUID,
    "tenancyId" UUID,
    "propertyId" UUID,
    "invoiceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "periodMonth" TIMESTAMP(3),
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "sstAmount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "pdfKey" TEXT,
    "attachmentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "idempotencyKey" TEXT,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ElectricityMeter" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "meterNumber" TEXT,
    "ratePerKwh" DECIMAL(6,4) NOT NULL DEFAULT 0.6000,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ElectricityMeter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterReading" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "meterId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "periodMonth" TIMESTAMP(3) NOT NULL,
    "previousReading" DECIMAL(12,2) NOT NULL,
    "currentReading" DECIMAL(12,2) NOT NULL,
    "consumption" DECIMAL(12,2) NOT NULL,
    "ratePerKwh" DECIMAL(6,4) NOT NULL,
    "computedAmount" DECIMAL(12,2) NOT NULL,
    "imageKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "chargeId" UUID,
    "submittedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeterReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagementFeeConfig" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ownerPartyId" UUID NOT NULL,
    "propertyId" UUID,
    "feeType" TEXT NOT NULL,
    "feeValue" DECIMAL(10,2) NOT NULL,
    "capAmount" DECIMAL(10,2),
    "sstPercent" DECIMAL(5,2) NOT NULL DEFAULT 8.00,
    "freePeriodStart" TIMESTAMP(3),
    "freePeriodEnd" TIMESTAMP(3),
    "cleaningAutoBill" DECIMAL(10,2) DEFAULT 100.00,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagementFeeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'todo',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "category" TEXT,
    "sortOrder" INTEGER,
    "attachmentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assigneeUserId" UUID,
    "relatedUnitId" UUID,
    "ticketId" UUID,
    "createdBy" UUID NOT NULL,
    "dueOn" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "warrantyFlag" BOOLEAN NOT NULL DEFAULT false,
    "attachmentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resolvedAt" TIMESTAMP(3),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketHistory" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "entry" TEXT NOT NULL,
    "attachmentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "actorUserId" UUID NOT NULL,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "partyId" UUID,
    "userId" UUID,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftConfig" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "runDayOfMonth" INTEGER NOT NULL DEFAULT 25,
    "dueDayOffset" INTEGER,
    "includeRent" BOOLEAN NOT NULL DEFAULT true,
    "includeElectricity" BOOLEAN NOT NULL DEFAULT true,
    "includeMgmtFee" BOOLEAN NOT NULL DEFAULT true,
    "includeCleaning" BOOLEAN NOT NULL DEFAULT true,
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DraftConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceDraftRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "periodMonth" TIMESTAMP(3) NOT NULL,
    "runDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "draftsCreated" INTEGER NOT NULL DEFAULT 0,
    "draftsSkipped" INTEGER NOT NULL DEFAULT 0,
    "errorText" TEXT,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceDraftRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "sourceFile" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'running',
    "rowsParsed" INTEGER NOT NULL DEFAULT 0,
    "partiesCreated" INTEGER NOT NULL DEFAULT 0,
    "partiesMatched" INTEGER NOT NULL DEFAULT 0,
    "tenanciesCreated" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "errorText" TEXT,
    "reportKey" TEXT,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_organizationId_status_idx" ON "Invoice"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_ownerPartyId_idx" ON "Invoice"("organizationId", "ownerPartyId");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_tenancyId_idx" ON "Invoice"("organizationId", "tenancyId");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_periodMonth_idx" ON "Invoice"("organizationId", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_invoiceNumber_key" ON "Invoice"("organizationId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_idempotencyKey_key" ON "Invoice"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ElectricityMeter_organizationId_unitId_key" ON "ElectricityMeter"("organizationId", "unitId");

-- CreateIndex
CREATE INDEX "MeterReading_organizationId_unitId_periodMonth_idx" ON "MeterReading"("organizationId", "unitId", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "MeterReading_organizationId_unitId_periodMonth_key" ON "MeterReading"("organizationId", "unitId", "periodMonth");

-- CreateIndex
CREATE INDEX "ManagementFeeConfig_organizationId_ownerPartyId_idx" ON "ManagementFeeConfig"("organizationId", "ownerPartyId");

-- CreateIndex
CREATE INDEX "Task_organizationId_status_idx" ON "Task"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Task_organizationId_assigneeUserId_idx" ON "Task"("organizationId", "assigneeUserId");

-- CreateIndex
CREATE INDEX "Task_organizationId_relatedUnitId_idx" ON "Task"("organizationId", "relatedUnitId");

-- CreateIndex
CREATE INDEX "Ticket_organizationId_unitId_idx" ON "Ticket"("organizationId", "unitId");

-- CreateIndex
CREATE INDEX "Ticket_organizationId_status_idx" ON "Ticket"("organizationId", "status");

-- CreateIndex
CREATE INDEX "TicketHistory_organizationId_unitId_occurredOn_idx" ON "TicketHistory"("organizationId", "unitId", "occurredOn");

-- CreateIndex
CREATE INDEX "DeviceToken_organizationId_partyId_idx" ON "DeviceToken"("organizationId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_organizationId_token_key" ON "DeviceToken"("organizationId", "token");

-- CreateIndex
CREATE UNIQUE INDEX "DraftConfig_organizationId_key" ON "DraftConfig"("organizationId");

-- CreateIndex
CREATE INDEX "InvoiceDraftRun_organizationId_periodMonth_idx" ON "InvoiceDraftRun"("organizationId", "periodMonth");

-- CreateIndex
CREATE INDEX "InvoiceDraftRun_organizationId_runDate_idx" ON "InvoiceDraftRun"("organizationId", "runDate");

-- CreateIndex
CREATE INDEX "ImportRun_organizationId_createdAt_idx" ON "ImportRun"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Charge_organizationId_invoiceId_idx" ON "Charge"("organizationId", "invoiceId");

-- CreateIndex
CREATE INDEX "Party_organizationId_primaryPhone_idx" ON "Party"("organizationId", "primaryPhone");

-- CreateIndex
CREATE INDEX "Payment_organizationId_provider_providerTxnId_idx" ON "Payment"("organizationId", "provider", "providerTxnId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_organizationId_idempotencyKey_key" ON "Payment"("organizationId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_ownerPartyId_fkey" FOREIGN KEY ("ownerPartyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElectricityMeter" ADD CONSTRAINT "ElectricityMeter_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElectricityMeter" ADD CONSTRAINT "ElectricityMeter_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "ElectricityMeter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagementFeeConfig" ADD CONSTRAINT "ManagementFeeConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagementFeeConfig" ADD CONSTRAINT "ManagementFeeConfig_ownerPartyId_fkey" FOREIGN KEY ("ownerPartyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_relatedUnitId_fkey" FOREIGN KEY ("relatedUnitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketHistory" ADD CONSTRAINT "TicketHistory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketHistory" ADD CONSTRAINT "TicketHistory_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketHistory" ADD CONSTRAINT "TicketHistory_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftConfig" ADD CONSTRAINT "DraftConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceDraftRun" ADD CONSTRAINT "InvoiceDraftRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: deny-all posture (20260506 lockdown). Every NEW table must enable RLS in
-- its own migration — the 20260520 resweep exists because earlier new tables
-- shipped open to PostgREST anon/authenticated on Supabase. Promotion CI runs
-- scripts/check-new-tables-have-rls.ts.
ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ElectricityMeter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MeterReading" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManagementFeeConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TicketHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeviceToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DraftConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceDraftRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportRun" ENABLE ROW LEVEL SECURITY;
