-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "reservationLinkExpiryDays" INTEGER NOT NULL DEFAULT 7;

-- CreateTable
CREATE TABLE "UnitReservation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "referenceCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_customer',
    "issuedByPartyId" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "publicToken" TEXT NOT NULL,
    "propertyId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "carPark" TEXT,
    "proposedMoveIn" TIMESTAMP(3) NOT NULL,
    "proposedMoveOut" TIMESTAMP(3),
    "specialRemarks" TEXT,
    "reservationDeposit" DECIMAL(12,2) NOT NULL,
    "documentationFee" DECIMAL(12,2) NOT NULL,
    "rentalDeposit" DECIMAL(12,2) NOT NULL,
    "utilityDeposit" DECIMAL(12,2) NOT NULL,
    "accessCardDeposit" DECIMAL(12,2) NOT NULL,
    "applicantFullName" TEXT,
    "applicantNric" TEXT,
    "applicantContact" TEXT,
    "applicantEmail" TEXT,
    "signedAt" TIMESTAMP(3),
    "signedFromIp" TEXT,
    "signedUserAgent" TEXT,
    "signatureDrawingKey" TEXT,
    "signatureTypedName" TEXT,
    "signatureAgreementTickedAt" TIMESTAMP(3),
    "signedPdfKey" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitReservationTransition" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "UnitReservationTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UnitReservation_publicToken_key" ON "UnitReservation"("publicToken");

-- CreateIndex
CREATE INDEX "UnitReservation_organizationId_status_idx" ON "UnitReservation"("organizationId", "status");

-- CreateIndex
CREATE INDEX "UnitReservation_organizationId_issuedByPartyId_idx" ON "UnitReservation"("organizationId", "issuedByPartyId");

-- CreateIndex
CREATE INDEX "UnitReservation_expiresAt_idx" ON "UnitReservation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UnitReservation_organizationId_referenceCode_key" ON "UnitReservation"("organizationId", "referenceCode");

-- CreateIndex
CREATE INDEX "UnitReservationTransition_reservationId_changedAt_idx" ON "UnitReservationTransition"("reservationId", "changedAt");

-- AddForeignKey
ALTER TABLE "UnitReservation" ADD CONSTRAINT "UnitReservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitReservation" ADD CONSTRAINT "UnitReservation_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitReservation" ADD CONSTRAINT "UnitReservation_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitReservation" ADD CONSTRAINT "UnitReservation_issuedByPartyId_fkey" FOREIGN KEY ("issuedByPartyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitReservationTransition" ADD CONSTRAINT "UnitReservationTransition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitReservationTransition" ADD CONSTRAINT "UnitReservationTransition_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "UnitReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
