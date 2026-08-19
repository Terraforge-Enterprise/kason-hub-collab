ALTER TABLE "Invoice" ADD COLUMN "apartmentId" UUID;
CREATE INDEX "Invoice_organizationId_apartmentId_idx" ON "Invoice"("organizationId", "apartmentId");
CREATE INDEX "OwnerLedgerEntry_organizationId_apartmentId_statementMonth_idx" ON "OwnerLedgerEntry"("organizationId", "apartmentId", "statementMonth");
