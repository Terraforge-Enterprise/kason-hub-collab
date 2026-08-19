-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedById" UUID,
ALTER COLUMN "status" SET DEFAULT 'unverified';

-- AlterTable
ALTER TABLE "RenovationProgress" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" UUID;

-- CreateTable
CREATE TABLE "RenovationStage" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenovationStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenovationStageProgress" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "progressId" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "RenovationStageProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesClaimDefault" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "appliesTo" TEXT NOT NULL DEFAULT '__catchall__',
    "commissionType" TEXT NOT NULL,
    "commissionValue" DECIMAL(10,2) NOT NULL,
    "paymentType" TEXT NOT NULL DEFAULT 'full',
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "SalesClaimDefault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesClaimDefaultSplit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "defaultId" UUID NOT NULL,
    "roleLabel" TEXT NOT NULL,
    "splitType" TEXT NOT NULL,
    "splitValue" DECIMAL(10,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SalesClaimDefaultSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectVerificationTransition" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedById" UUID NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "ProjectVerificationTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RenovationStage_organizationId_archived_sortOrder_idx" ON "RenovationStage"("organizationId", "archived", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RenovationStage_organizationId_key_key" ON "RenovationStage"("organizationId", "key");

-- CreateIndex
CREATE INDEX "RenovationStageProgress_organizationId_status_idx" ON "RenovationStageProgress"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RenovationStageProgress_progressId_stageId_key" ON "RenovationStageProgress"("progressId", "stageId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesClaimDefault_organizationId_appliesTo_key" ON "SalesClaimDefault"("organizationId", "appliesTo");

-- CreateIndex
CREATE INDEX "SalesClaimDefaultSplit_defaultId_idx" ON "SalesClaimDefaultSplit"("defaultId");

-- CreateIndex
CREATE INDEX "ProjectVerificationTransition_organizationId_projectId_idx" ON "ProjectVerificationTransition"("organizationId", "projectId");

-- AddForeignKey
ALTER TABLE "RenovationStage" ADD CONSTRAINT "RenovationStage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationStageProgress" ADD CONSTRAINT "RenovationStageProgress_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationStageProgress" ADD CONSTRAINT "RenovationStageProgress_progressId_fkey" FOREIGN KEY ("progressId") REFERENCES "RenovationProgress"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationStageProgress" ADD CONSTRAINT "RenovationStageProgress_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "RenovationStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesClaimDefault" ADD CONSTRAINT "SalesClaimDefault_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesClaimDefaultSplit" ADD CONSTRAINT "SalesClaimDefaultSplit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesClaimDefaultSplit" ADD CONSTRAINT "SalesClaimDefaultSplit_defaultId_fkey" FOREIGN KEY ("defaultId") REFERENCES "SalesClaimDefault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectVerificationTransition" ADD CONSTRAINT "ProjectVerificationTransition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectVerificationTransition" ADD CONSTRAINT "ProjectVerificationTransition_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
