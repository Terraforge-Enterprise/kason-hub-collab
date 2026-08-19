-- CreateTable
CREATE TABLE "ReferenceSequence" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "docType" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ReferenceSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceSequence_organizationId_docType_year_key" ON "ReferenceSequence"("organizationId", "docType", "year");

-- AddForeignKey
ALTER TABLE "ReferenceSequence" ADD CONSTRAINT "ReferenceSequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "Property_sourcing_pending_idx" RENAME TO "Property_organizationId_sourcingAgentId_sourcingApproved_idx";
