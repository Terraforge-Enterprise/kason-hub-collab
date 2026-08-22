-- Management-fee precedence is now unit > property > owner default.
-- Nullable keeps every existing configuration valid and unchanged.
ALTER TABLE "ManagementFeeConfig"
ADD COLUMN "apartmentId" UUID;

CREATE INDEX "ManagementFeeConfig_organizationId_apartmentId_idx"
ON "ManagementFeeConfig"("organizationId", "apartmentId");
