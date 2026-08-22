-- Correct the registered company name in existing workspaces. The shorter
-- "KAEN Properties Sdn Bhd" name is not the legal entity name.
UPDATE "Organization"
SET "name" = 'KAEN Properties Management Sdn Bhd'
WHERE LOWER("name") IN (
  'kaen properties sdn bhd',
  'kaen properties sdn. bhd.',
  'kaen properties management sdn bhd'
);

UPDATE "OrganizationCardSettings"
SET "legalEntityName" = 'KAEN PROPERTIES MANAGEMENT SDN BHD'
WHERE "legalEntityName" IS NULL
   OR LOWER("legalEntityName") IN (
     'kaen properties sdn bhd',
     'kaen properties sdn. bhd.',
     'kaen properties management sdn bhd'
   );

UPDATE "OrganizationCardSettings"
SET "addressLine1" = 'KAEN PROPERTIES MANAGEMENT SDN BHD (1610050-V)'
WHERE LOWER("addressLine1") IN (
  'kaen properties sdn bhd (1466670-h)',
  'kaen properties sdn. bhd. (1466670-h)'
);
