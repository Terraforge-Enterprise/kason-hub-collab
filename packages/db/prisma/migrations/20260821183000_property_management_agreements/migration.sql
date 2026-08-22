CREATE TABLE "PropertyManagementAgreementTemplate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "contentHtml" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PropertyManagementAgreementTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PropertyManagementAgreementTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PropertyManagementAgreementTemplate_organizationId_name_key" ON "PropertyManagementAgreementTemplate"("organizationId", "name");
CREATE INDEX "PropertyManagementAgreementTemplate_organizationId_active_isDefault_idx" ON "PropertyManagementAgreementTemplate"("organizationId", "active", "isDefault");

CREATE TABLE "PropertyManagementAgreement" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "landlordTenancyId" UUID NOT NULL,
  "templateId" UUID,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "contentHtml" TEXT NOT NULL,
  "fileName" TEXT,
  "pdfKey" TEXT,
  "generatedAt" TIMESTAMP(3),
  "generatedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PropertyManagementAgreement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PropertyManagementAgreement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PropertyManagementAgreement_landlordTenancyId_fkey" FOREIGN KEY ("landlordTenancyId") REFERENCES "LandlordTenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PropertyManagementAgreement_organizationId_landlordTenancyId_version_key" ON "PropertyManagementAgreement"("organizationId", "landlordTenancyId", "version");
CREATE INDEX "PropertyManagementAgreement_organizationId_landlordTenancyId_status_idx" ON "PropertyManagementAgreement"("organizationId", "landlordTenancyId", "status");
