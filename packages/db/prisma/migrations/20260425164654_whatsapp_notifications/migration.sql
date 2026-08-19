-- AlterTable
ALTER TABLE "Party" ADD COLUMN     "notifyOnNewClaim" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "whatsappPhone" TEXT;

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "recipientPartyId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "errorReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationLog_providerMessageId_key" ON "NotificationLog"("providerMessageId");

-- CreateIndex
CREATE INDEX "NotificationLog_claimId_idx" ON "NotificationLog"("claimId");

-- CreateIndex
CREATE INDEX "NotificationLog_recipientPartyId_createdAt_idx" ON "NotificationLog"("recipientPartyId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_organizationId_status_createdAt_idx" ON "NotificationLog"("organizationId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "CommissionClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_recipientPartyId_fkey" FOREIGN KEY ("recipientPartyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
