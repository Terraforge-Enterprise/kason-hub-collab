CREATE TABLE "BillsGridSummaryNote" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "apartmentId" UUID NOT NULL,
  "periodMonth" DATE NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "updatedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillsGridSummaryNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillsGridSummaryNote_organizationId_apartmentId_periodMonth_key"
  ON "BillsGridSummaryNote"("organizationId", "apartmentId", "periodMonth");
CREATE INDEX "BillsGridSummaryNote_organizationId_periodMonth_idx"
  ON "BillsGridSummaryNote"("organizationId", "periodMonth");
