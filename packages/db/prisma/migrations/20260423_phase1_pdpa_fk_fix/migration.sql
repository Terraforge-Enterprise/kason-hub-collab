-- Preserve PDPA consent + request records when a Tenancy or Party is deleted.
-- Legal evidence (consent capture, erasure-request fulfilment) must outlive the
-- data subject per PDPA 2010 retention expectations.

ALTER TABLE "TenantConsent" DROP CONSTRAINT "TenantConsent_tenancyId_fkey";
ALTER TABLE "TenantConsent" ADD CONSTRAINT "TenantConsent_tenancyId_fkey"
    FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TenantConsent" DROP CONSTRAINT "TenantConsent_partyId_fkey";
ALTER TABLE "TenantConsent" ADD CONSTRAINT "TenantConsent_partyId_fkey"
    FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PdpaRequest" DROP CONSTRAINT "PdpaRequest_partyId_fkey";
ALTER TABLE "PdpaRequest" ADD CONSTRAINT "PdpaRequest_partyId_fkey"
    FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
