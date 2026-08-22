ALTER TABLE "DocumentTemplate" ADD COLUMN "bodyTemplate" TEXT;

CREATE TABLE "TenancyAgreement" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "tenancyId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "contentHtml" TEXT NOT NULL,
  "fileName" TEXT,
  "pdfKey" TEXT,
  "generatedAt" TIMESTAMP(3),
  "generatedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenancyAgreement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenancyAgreement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TenancyAgreement_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TenancyAgreement_organizationId_tenancyId_version_key" ON "TenancyAgreement"("organizationId", "tenancyId", "version");
CREATE INDEX "TenancyAgreement_organizationId_tenancyId_status_idx" ON "TenancyAgreement"("organizationId", "tenancyId", "status");
