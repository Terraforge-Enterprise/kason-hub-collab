ALTER TABLE "TenancyAgreement" ADD COLUMN "templateId" UUID;

CREATE TABLE "TenancyAgreementTemplate" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "contentHtml" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenancyAgreementTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenancyAgreementTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TenancyAgreementTemplate_organizationId_name_key" ON "TenancyAgreementTemplate"("organizationId", "name");
CREATE INDEX "TenancyAgreementTemplate_organizationId_active_isDefault_idx" ON "TenancyAgreementTemplate"("organizationId", "active", "isDefault");
