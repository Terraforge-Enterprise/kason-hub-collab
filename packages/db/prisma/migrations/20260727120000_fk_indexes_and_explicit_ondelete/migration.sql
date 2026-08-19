-- Data-integrity pass (2026-07-27): foreign-key indexes + explicit referential actions.
--
-- PURELY ADDITIVE. Two changes, neither of which alters behaviour:
--
--  1. 46 indexes on foreign-key columns that had none. Postgres enforces a FK on
--     DELETE of the parent with `WHERE <fkcol> = $1` and does NOT apply the app's
--     organizationId filter, so the existing org-scoped composite indexes do not
--     serve it. Without these, deleting a Party/Property/Tenancy sequential-scans
--     the child table.
--
--  2. 14 `onDelete` actions made EXPLICIT in schema.prisma, each set to the action
--     Prisma was already applying implicitly (Restrict for required relations,
--     SetNull for optional). This emits NO SQL — verified by `migrate diff`
--     producing zero ADD/DROP CONSTRAINT statements — and is a readability change
--     only. It is included in this migration's schema snapshot, not its SQL.
--
-- DELIBERATELY EXCLUDED: `ALTER TABLE "Party" ALTER COLUMN "idNumberNormalized"
-- DROP DEFAULT`. Pre-existing drift — the column is GENERATED ALWAYS AS (...) STORED
-- (20260706120000_party_id_number_normalized:26) while schema.prisma:588 declares a
-- plain String?, so Prisma re-proposes the drop on every diff. Verified present in a
-- baseline diff against an UNMODIFIED schema.
--
-- It does NOT silently remove the expression — Postgres rejects it outright:
--   ERROR: column ... is a generated column (SQLSTATE 42601)
--   HINT:  Use ALTER TABLE ... ALTER COLUMN ... DROP EXPRESSION instead.
-- So including it would ABORT this migration, leave a failed row in
-- _prisma_migrations, and BLOCK every subsequent `migrate deploy` until someone
-- runs `prisma migrate resolve --rolled-back`. A stuck deploy pipeline, not data loss.
--
-- This is the FIFTH migration that has had to hand-strip this statement (see
-- 20260710220119, 20260713160819, 20260713170535, 20260714022130, 20260714045401).
-- Every `prisma migrate dev` re-emits it. A CI grep rejecting that exact string in
-- any new migration file would close this permanently.
--
-- Plain CREATE INDEX (not CONCURRENTLY): Prisma wraps migrations in a transaction
-- and CONCURRENTLY cannot run inside one. Tables are small; the lock is brief.

CREATE INDEX "AgentCardVersion_reviewedById_idx" ON "AgentCardVersion"("reviewedById");
CREATE INDEX "AgentCardVersion_submittedById_idx" ON "AgentCardVersion"("submittedById");
CREATE INDEX "Bill_propertyId_idx" ON "Bill"("propertyId");
CREATE INDEX "CashMovement_partyId_idx" ON "CashMovement"("partyId");
CREATE INDEX "CashMovement_propertyId_idx" ON "CashMovement"("propertyId");
CREATE INDEX "Charge_unitId_idx" ON "Charge"("unitId");
CREATE INDEX "ChargeCategory_seriesId_idx" ON "ChargeCategory"("seriesId");
CREATE INDEX "Deposit_unitId_idx" ON "Deposit"("unitId");
CREATE INDEX "GridAttachment_entryId_idx" ON "GridAttachment"("entryId");
CREATE INDEX "Invoice_partyId_idx" ON "Invoice"("partyId");
CREATE INDEX "LandlordTenancy_landlordId_idx" ON "LandlordTenancy"("landlordId");
CREATE INDEX "LandlordTenancy_propertyId_idx" ON "LandlordTenancy"("propertyId");
CREATE INDEX "ListingVisibilityGrant_grantedById_idx" ON "ListingVisibilityGrant"("grantedById");
CREATE INDEX "MeterReading_meterId_idx" ON "MeterReading"("meterId");
CREATE INDEX "PendingUpload_consumedClaimItemId_idx" ON "PendingUpload"("consumedClaimItemId");
CREATE INDEX "Property_managerId_idx" ON "Property"("managerId");
CREATE INDEX "PropertySubmission_approvedById_idx" ON "PropertySubmission"("approvedById");
CREATE INDEX "RecurringCharge_tenancyId_idx" ON "RecurringCharge"("tenancyId");
CREATE INDEX "Refund_originalPaymentId_idx" ON "Refund"("originalPaymentId");
CREATE INDEX "RenovationClaim_packageId_idx" ON "RenovationClaim"("packageId");
CREATE INDEX "RenovationClaimDocument_organizationId_idx" ON "RenovationClaimDocument"("organizationId");
CREATE INDEX "RenovationClaimOffset_organizationId_idx" ON "RenovationClaimOffset"("organizationId");
CREATE INDEX "RenovationClaimOffset_paymentId_idx" ON "RenovationClaimOffset"("paymentId");
CREATE INDEX "RenovationClaimSplit_organizationId_idx" ON "RenovationClaimSplit"("organizationId");
CREATE INDEX "RenovationClaimSplit_partyPartyId_idx" ON "RenovationClaimSplit"("partyPartyId");
CREATE INDEX "RenovationClaimTransition_organizationId_idx" ON "RenovationClaimTransition"("organizationId");
CREATE INDEX "RenovationPackageSplit_organizationId_idx" ON "RenovationPackageSplit"("organizationId");
CREATE INDEX "RenovationTransition_organizationId_idx" ON "RenovationTransition"("organizationId");
CREATE INDEX "SalesClaimDefaultSplit_organizationId_idx" ON "SalesClaimDefaultSplit"("organizationId");
CREATE INDEX "SalesClaimSplit_organizationId_idx" ON "SalesClaimSplit"("organizationId");
CREATE INDEX "SalesClaimSplit_partyPartyId_idx" ON "SalesClaimSplit"("partyPartyId");
CREATE INDEX "SalesClaimTransition_organizationId_idx" ON "SalesClaimTransition"("organizationId");
CREATE INDEX "SalesUnit_inChargePartyId_idx" ON "SalesUnit"("inChargePartyId");
CREATE INDEX "SalesUnit_ownerPartyId_idx" ON "SalesUnit"("ownerPartyId");
CREATE INDEX "Tenancy_propertyId_idx" ON "Tenancy"("propertyId");
CREATE INDEX "Tenancy_renovationClaimId_idx" ON "Tenancy"("renovationClaimId");
CREATE INDEX "TicketHistory_ticketId_idx" ON "TicketHistory"("ticketId");
CREATE INDEX "Unit_inChargePartyId_idx" ON "Unit"("inChargePartyId");
CREATE INDEX "UnitReservation_propertyId_idx" ON "UnitReservation"("propertyId");
CREATE INDEX "UnitReservation_unitId_idx" ON "UnitReservation"("unitId");
CREATE INDEX "UnitReservationDocument_organizationId_idx" ON "UnitReservationDocument"("organizationId");
CREATE INDEX "UnitReservationTransition_organizationId_idx" ON "UnitReservationTransition"("organizationId");
CREATE INDEX "UnitSubmission_approvedById_idx" ON "UnitSubmission"("approvedById");
CREATE INDEX "UnitSubmission_propertyId_idx" ON "UnitSubmission"("propertyId");
CREATE INDEX "UnitSubmission_propertySubmissionId_idx" ON "UnitSubmission"("propertySubmissionId");
CREATE INDEX "UtilityAllocation_tenancyId_idx" ON "UtilityAllocation"("tenancyId");
