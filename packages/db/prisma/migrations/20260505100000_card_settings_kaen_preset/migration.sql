-- Seed Kaen Properties brand + cert + address into OrganizationCardSettings
-- for any org row that is currently un-configured. This applies the same
-- values the operator would otherwise have to type in by hand at
-- /organization/agents/card-settings.
--
-- Idempotent: only updates rows where isConfigured = false. Re-running this
-- migration after an operator has manually edited their settings will NOT
-- overwrite their values.
--
-- Source of truth for the values: the printed sample namecard supplied by
-- the client on 2026-05-02 (WhatsApp image).
--
-- Note: brandName + brandTagline are NOT set here — those columns were
-- dropped in `20260505052809_drop_card_brand_columns`. The card visual
-- shows the logo image only; the brand wordmark is part of the logo.

UPDATE "OrganizationCardSettings"
SET
  "agencyName"       = 'EUM REALTY SDN BHD',
  "agencyLicense"    = 'E(1) 1708',
  "agencyPhone"      = '+603-92742668 / 2669',
  "agencyFax"        = '+603-92742663',
  "addressLine1"     = 'KAEN PROPERTIES SDN BHD (1466670-H)',
  "addressLine2"     = 'NO 27-4, JALAN PERDANA 10/12,',
  "addressLine3"     = 'PANDAN PERDANA,',
  "addressLine4"     = '55300 WP KUALA LUMPUR',
  "cardExpiryMonths" = 3,
  "isConfigured"     = true,
  "updatedAt"        = NOW()
WHERE "isConfigured" = false;
