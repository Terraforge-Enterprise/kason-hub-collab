-- CreateTable
CREATE TABLE "Carpark" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "apartmentId" UUID NOT NULL,
    "ownerPartyId" UUID,
    "label" TEXT NOT NULL,
    "monthlyRate" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Carpark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarparkAssignment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "carparkId" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "monthlyCharge" DECIMAL(12,2) NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarparkAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Carpark_organizationId_propertyId_status_idx" ON "Carpark"("organizationId", "propertyId", "status");

-- CreateIndex
CREATE INDEX "Carpark_organizationId_apartmentId_idx" ON "Carpark"("organizationId", "apartmentId");

-- CreateIndex
CREATE INDEX "Carpark_organizationId_ownerPartyId_idx" ON "Carpark"("organizationId", "ownerPartyId");

-- CreateIndex
CREATE INDEX "CarparkAssignment_organizationId_carparkId_status_idx" ON "CarparkAssignment"("organizationId", "carparkId", "status");

-- CreateIndex
CREATE INDEX "CarparkAssignment_organizationId_tenancyId_status_idx" ON "CarparkAssignment"("organizationId", "tenancyId", "status");

-- AddForeignKey
ALTER TABLE "Carpark" ADD CONSTRAINT "Carpark_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Carpark" ADD CONSTRAINT "Carpark_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Carpark" ADD CONSTRAINT "Carpark_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Carpark" ADD CONSTRAINT "Carpark_ownerPartyId_fkey" FOREIGN KEY ("ownerPartyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarparkAssignment" ADD CONSTRAINT "CarparkAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarparkAssignment" ADD CONSTRAINT "CarparkAssignment_carparkId_fkey" FOREIGN KEY ("carparkId") REFERENCES "Carpark"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarparkAssignment" ADD CONSTRAINT "CarparkAssignment_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable RLS (deny-all posture, no CREATE POLICY — the Hono API connects as the postgres
-- superuser; RLS is defense-in-depth vs direct anon/authenticated access). Matches every
-- other Phase-2 table.
ALTER TABLE "Carpark" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CarparkAssignment" ENABLE ROW LEVEL SECURITY;
