-- DropForeignKey
ALTER TABLE "Charge" DROP CONSTRAINT "Charge_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_partyId_fkey";

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_ownerPartyId_fkey";

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_tenancyId_fkey";

-- DropForeignKey
ALTER TABLE "ElectricityMeter" DROP CONSTRAINT "ElectricityMeter_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ElectricityMeter" DROP CONSTRAINT "ElectricityMeter_unitId_fkey";

-- DropForeignKey
ALTER TABLE "MeterReading" DROP CONSTRAINT "MeterReading_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "MeterReading" DROP CONSTRAINT "MeterReading_meterId_fkey";

-- DropForeignKey
ALTER TABLE "MeterReading" DROP CONSTRAINT "MeterReading_unitId_fkey";

-- DropForeignKey
ALTER TABLE "ManagementFeeConfig" DROP CONSTRAINT "ManagementFeeConfig_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ManagementFeeConfig" DROP CONSTRAINT "ManagementFeeConfig_ownerPartyId_fkey";

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_relatedUnitId_fkey";

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_unitId_fkey";

-- DropForeignKey
ALTER TABLE "TicketHistory" DROP CONSTRAINT "TicketHistory_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "TicketHistory" DROP CONSTRAINT "TicketHistory_ticketId_fkey";

-- DropForeignKey
ALTER TABLE "TicketHistory" DROP CONSTRAINT "TicketHistory_unitId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceToken" DROP CONSTRAINT "DeviceToken_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceToken" DROP CONSTRAINT "DeviceToken_partyId_fkey";

-- DropForeignKey
ALTER TABLE "DraftConfig" DROP CONSTRAINT "DraftConfig_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "InvoiceDraftRun" DROP CONSTRAINT "InvoiceDraftRun_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ImportRun" DROP CONSTRAINT "ImportRun_organizationId_fkey";

-- DropIndex
DROP INDEX "Party_organizationId_primaryPhone_idx";

-- DropIndex
DROP INDEX "Charge_organizationId_invoiceId_idx";

-- DropIndex
DROP INDEX "Payment_organizationId_provider_providerTxnId_idx";

-- DropIndex
DROP INDEX "Payment_organizationId_idempotencyKey_key";

-- AlterTable
ALTER TABLE "Unit" DROP COLUMN "unitKind";

-- AlterTable
ALTER TABLE "Tenancy" DROP COLUMN "accessCardNo",
DROP COLUMN "agentLabel",
DROP COLUMN "numberOfPax";

-- AlterTable
ALTER TABLE "Charge" DROP COLUMN "approvedAt",
DROP COLUMN "approvedBy",
DROP COLUMN "billingMonth",
DROP COLUMN "invoiceId";

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "attachmentKeys",
DROP COLUMN "bankCode",
DROP COLUMN "gatewayStatus",
DROP COLUMN "idempotencyKey",
DROP COLUMN "provider",
DROP COLUMN "providerTxnId";

-- AlterTable
ALTER TABLE "PaymentAllocation" DROP COLUMN "prorateRatio";

-- DropTable
DROP TABLE "Invoice";

-- DropTable
DROP TABLE "ElectricityMeter";

-- DropTable
DROP TABLE "MeterReading";

-- DropTable
DROP TABLE "ManagementFeeConfig";

-- DropTable
DROP TABLE "Task";

-- DropTable
DROP TABLE "Ticket";

-- DropTable
DROP TABLE "TicketHistory";

-- DropTable
DROP TABLE "DeviceToken";

-- DropTable
DROP TABLE "DraftConfig";

-- DropTable
DROP TABLE "InvoiceDraftRun";

-- DropTable
DROP TABLE "ImportRun";
