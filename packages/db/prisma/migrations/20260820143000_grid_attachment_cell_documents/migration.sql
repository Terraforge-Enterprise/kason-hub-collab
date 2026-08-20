ALTER TABLE "GridAttachment"
  ADD COLUMN "cellKey" TEXT,
  ADD COLUMN "columnId" TEXT,
  ADD COLUMN "documentKind" TEXT;

ALTER TABLE "GridAttachment"
  ADD CONSTRAINT "GridAttachment_documentKind_check"
  CHECK ("documentKind" IS NULL OR "documentKind" IN ('invoice', 'receipt'));

CREATE INDEX "GridAttachment_organizationId_apartmentId_periodMonth_cellKey_columnId_documentKind_idx"
  ON "GridAttachment"("organizationId", "apartmentId", "periodMonth", "cellKey", "columnId", "documentKind");
