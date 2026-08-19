-- audit-column-vocabularies.sql
--
-- ============================ READ-ONLY ============================
-- This file contains 225 SELECT statements and NOTHING ELSE.
-- No INSERT, no UPDATE, no DELETE, no DROP, no TRUNCATE, no ALTER.
-- It CANNOT modify or delete data. It is safe to run on production
-- during business hours.
--
-- Verify that yourself before running it:
--   grep -oiE '\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b' scripts/audit-column-vocabularies.sql
--   (expect: no output)
-- ===================================================================
--
-- WHAT IT DOES
-- For every text column whose name suggests a fixed vocabulary (status, type,
-- bearer, nature, direction, ...), it reports:  column | distinct value | row count.
-- That is the evidence needed before adding a CHECK constraint to that column —
-- a constraint written from the code alone can reject values that live in the data.
--
-- WHY IT EXISTS
-- On 2026-07-27 a vocabulary list derived by reading code was WRONG on three
-- columns; only running this against real data caught it. Run this first, always.
--
-- HOW TO RUN
--   psql "$DSN" -tAF'|' -f scripts/audit-column-vocabularies.sql > values.txt
--
-- It is NOT wired into CI or any deploy workflow, and nothing runs it for you.
-- It is a deliberate, manual, read-only audit.


SELECT 'Organization.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Organization" GROUP BY 2
UNION ALL
SELECT 'Organization.billingCycleMode' AS col, COALESCE("billingCycleMode",'<NULL>') AS val, count(*)::int AS n FROM "Organization" GROUP BY 2
UNION ALL
SELECT 'User.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "User" GROUP BY 2
UNION ALL
SELECT 'User.userType' AS col, COALESCE("userType",'<NULL>') AS val, count(*)::int AS n FROM "User" GROUP BY 2
UNION ALL
SELECT 'RoleAssignment.scopeType' AS col, COALESCE("scopeType",'<NULL>') AS val, count(*)::int AS n FROM "RoleAssignment" GROUP BY 2
UNION ALL
SELECT 'Property.propertyType' AS col, COALESCE("propertyType",'<NULL>') AS val, count(*)::int AS n FROM "Property" GROUP BY 2
UNION ALL
SELECT 'Property.state' AS col, COALESCE("state",'<NULL>') AS val, count(*)::int AS n FROM "Property" GROUP BY 2
UNION ALL
SELECT 'Property.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Property" GROUP BY 2
UNION ALL
SELECT 'Property.publishStatus' AS col, COALESCE("publishStatus",'<NULL>') AS val, count(*)::int AS n FROM "Property" GROUP BY 2
UNION ALL
SELECT 'Building.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Building" GROUP BY 2
UNION ALL
SELECT 'Apartment.furnishingLevel' AS col, COALESCE("furnishingLevel",'<NULL>') AS val, count(*)::int AS n FROM "Apartment" GROUP BY 2
UNION ALL
SELECT 'UnitSubmission.listingType' AS col, COALESCE("listingType",'<NULL>') AS val, count(*)::int AS n FROM "UnitSubmission" GROUP BY 2
UNION ALL
SELECT 'PropertySubmission.propertyType' AS col, COALESCE("propertyType",'<NULL>') AS val, count(*)::int AS n FROM "PropertySubmission" GROUP BY 2
UNION ALL
SELECT 'PropertySubmission.state' AS col, COALESCE("state",'<NULL>') AS val, count(*)::int AS n FROM "PropertySubmission" GROUP BY 2
UNION ALL
SELECT 'Carpark.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Carpark" GROUP BY 2
UNION ALL
SELECT 'CarparkAssignment.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "CarparkAssignment" GROUP BY 2
UNION ALL
SELECT 'Party.partyType' AS col, COALESCE("partyType",'<NULL>') AS val, count(*)::int AS n FROM "Party" GROUP BY 2
UNION ALL
SELECT 'Party.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Party" GROUP BY 2
UNION ALL
SELECT 'Party.idType' AS col, COALESCE("idType",'<NULL>') AS val, count(*)::int AS n FROM "Party" GROUP BY 2
UNION ALL
SELECT 'Party.blacklistReason' AS col, COALESCE("blacklistReason",'<NULL>') AS val, count(*)::int AS n FROM "Party" GROUP BY 2
UNION ALL
SELECT 'Party.agentLevel' AS col, COALESCE("agentLevel",'<NULL>') AS val, count(*)::int AS n FROM "Party" GROUP BY 2
UNION ALL
SELECT 'PartyRole.roleType' AS col, COALESCE("roleType",'<NULL>') AS val, count(*)::int AS n FROM "PartyRole" GROUP BY 2
UNION ALL
SELECT 'PartyRole.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "PartyRole" GROUP BY 2
UNION ALL
SELECT 'Tenancy.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Tenancy" GROUP BY 2
UNION ALL
SELECT 'Tenancy.billingStatus' AS col, COALESCE("billingStatus",'<NULL>') AS val, count(*)::int AS n FROM "Tenancy" GROUP BY 2
UNION ALL
SELECT 'Tenancy.commissionSstBearer' AS col, COALESCE("commissionSstBearer",'<NULL>') AS val, count(*)::int AS n FROM "Tenancy" GROUP BY 2
UNION ALL
SELECT 'LandlordTenancy.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "LandlordTenancy" GROUP BY 2
UNION ALL
SELECT 'Deposit.type' AS col, COALESCE("type",'<NULL>') AS val, count(*)::int AS n FROM "Deposit" GROUP BY 2
UNION ALL
SELECT 'Deposit.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Deposit" GROUP BY 2
UNION ALL
SELECT 'ChargeCategory.family' AS col, COALESCE("family",'<NULL>') AS val, count(*)::int AS n FROM "ChargeCategory" GROUP BY 2
UNION ALL
SELECT 'ChargeCategory.docType' AS col, COALESCE("docType",'<NULL>') AS val, count(*)::int AS n FROM "ChargeCategory" GROUP BY 2
UNION ALL
SELECT 'ChargeCategory.ledgerCategory' AS col, COALESCE("ledgerCategory",'<NULL>') AS val, count(*)::int AS n FROM "ChargeCategory" GROUP BY 2
UNION ALL
SELECT 'ChargeCategory.profitExpense' AS col, COALESCE("profitExpense",'<NULL>') AS val, count(*)::int AS n FROM "ChargeCategory" GROUP BY 2
UNION ALL
SELECT 'Charge.chargeType' AS col, COALESCE("chargeType",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.waivedReason' AS col, COALESCE("waivedReason",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.cancelledReason' AS col, COALESCE("cancelledReason",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.disputeReason' AS col, COALESCE("disputeReason",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.disputeStatus' AS col, COALESCE("disputeStatus",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.fundedBy' AS col, COALESCE("fundedBy",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.revenueRecognition' AS col, COALESCE("revenueRecognition",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.settlementRecipient' AS col, COALESCE("settlementRecipient",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.nature' AS col, COALESCE("nature",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.sourceInvoiceIssuedTo' AS col, COALESCE("sourceInvoiceIssuedTo",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.taxTreatment' AS col, COALESCE("taxTreatment",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.taxReason' AS col, COALESCE("taxReason",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.commercialPurpose' AS col, COALESCE("commercialPurpose",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.provenanceType' AS col, COALESCE("provenanceType",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.economicClassificationStatus' AS col, COALESCE("economicClassificationStatus",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'Charge.economicClassificationReason' AS col, COALESCE("economicClassificationReason",'<NULL>') AS val, count(*)::int AS n FROM "Charge" GROUP BY 2
UNION ALL
SELECT 'ChargeEvent.eventType' AS col, COALESCE("eventType",'<NULL>') AS val, count(*)::int AS n FROM "ChargeEvent" GROUP BY 2
UNION ALL
SELECT 'ChargeTemplate.chargeType' AS col, COALESCE("chargeType",'<NULL>') AS val, count(*)::int AS n FROM "ChargeTemplate" GROUP BY 2
UNION ALL
SELECT 'ChargeTemplate.propertyType' AS col, COALESCE("propertyType",'<NULL>') AS val, count(*)::int AS n FROM "ChargeTemplate" GROUP BY 2
UNION ALL
SELECT 'RecurringCharge.chargeType' AS col, COALESCE("chargeType",'<NULL>') AS val, count(*)::int AS n FROM "RecurringCharge" GROUP BY 2
UNION ALL
SELECT 'LateFeeRule.feeType' AS col, COALESCE("feeType",'<NULL>') AS val, count(*)::int AS n FROM "LateFeeRule" GROUP BY 2
UNION ALL
SELECT 'Payment.paymentType' AS col, COALESCE("paymentType",'<NULL>') AS val, count(*)::int AS n FROM "Payment" GROUP BY 2
UNION ALL
SELECT 'Payment.paymentMethod' AS col, COALESCE("paymentMethod",'<NULL>') AS val, count(*)::int AS n FROM "Payment" GROUP BY 2
UNION ALL
SELECT 'Payment.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Payment" GROUP BY 2
UNION ALL
SELECT 'Payment.gatewayStatus' AS col, COALESCE("gatewayStatus",'<NULL>') AS val, count(*)::int AS n FROM "Payment" GROUP BY 2
UNION ALL
SELECT 'PaymentAllocationReversal.reason' AS col, COALESCE("reason",'<NULL>') AS val, count(*)::int AS n FROM "PaymentAllocationReversal" GROUP BY 2
UNION ALL
SELECT 'CashMovement.type' AS col, COALESCE("type",'<NULL>') AS val, count(*)::int AS n FROM "CashMovement" GROUP BY 2
UNION ALL
SELECT 'CashMovement.category' AS col, COALESCE("category",'<NULL>') AS val, count(*)::int AS n FROM "CashMovement" GROUP BY 2
UNION ALL
SELECT 'CashMovement.allocationStatus' AS col, COALESCE("allocationStatus",'<NULL>') AS val, count(*)::int AS n FROM "CashMovement" GROUP BY 2
UNION ALL
SELECT 'NotificationQueue.type' AS col, COALESCE("type",'<NULL>') AS val, count(*)::int AS n FROM "NotificationQueue" GROUP BY 2
UNION ALL
SELECT 'NotificationQueue.recipientEmail' AS col, COALESCE("recipientEmail",'<NULL>') AS val, count(*)::int AS n FROM "NotificationQueue" GROUP BY 2
UNION ALL
SELECT 'NotificationQueue.recipientName' AS col, COALESCE("recipientName",'<NULL>') AS val, count(*)::int AS n FROM "NotificationQueue" GROUP BY 2
UNION ALL
SELECT 'NotificationQueue.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "NotificationQueue" GROUP BY 2
UNION ALL
SELECT 'AuditLog.entityType' AS col, COALESCE("entityType",'<NULL>') AS val, count(*)::int AS n FROM "AuditLog" GROUP BY 2
UNION ALL
SELECT 'ActivityLog.entityType' AS col, COALESCE("entityType",'<NULL>') AS val, count(*)::int AS n FROM "ActivityLog" GROUP BY 2
UNION ALL
SELECT 'MaintenanceRequest.category' AS col, COALESCE("category",'<NULL>') AS val, count(*)::int AS n FROM "MaintenanceRequest" GROUP BY 2
UNION ALL
SELECT 'MaintenanceRequest.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "MaintenanceRequest" GROUP BY 2
UNION ALL
SELECT 'Document.fileType' AS col, COALESCE("fileType",'<NULL>') AS val, count(*)::int AS n FROM "Document" GROUP BY 2
UNION ALL
SELECT 'DocumentLink.linkedEntityType' AS col, COALESCE("linkedEntityType",'<NULL>') AS val, count(*)::int AS n FROM "DocumentLink" GROUP BY 2
UNION ALL
SELECT 'Announcement.type' AS col, COALESCE("type",'<NULL>') AS val, count(*)::int AS n FROM "Announcement" GROUP BY 2
UNION ALL
SELECT 'AgentTierMapping.claimType' AS col, COALESCE("claimType",'<NULL>') AS val, count(*)::int AS n FROM "AgentTierMapping" GROUP BY 2
UNION ALL
SELECT 'AgentTierMapping.agentLevel' AS col, COALESCE("agentLevel",'<NULL>') AS val, count(*)::int AS n FROM "AgentTierMapping" GROUP BY 2
UNION ALL
SELECT 'CommissionClaim.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "CommissionClaim" GROUP BY 2
UNION ALL
SELECT 'CommissionClaim.rejectionReason' AS col, COALESCE("rejectionReason",'<NULL>') AS val, count(*)::int AS n FROM "CommissionClaim" GROUP BY 2
UNION ALL
SELECT 'CommissionClaim.claimType' AS col, COALESCE("claimType",'<NULL>') AS val, count(*)::int AS n FROM "CommissionClaim" GROUP BY 2
UNION ALL
SELECT 'CommissionClaimItem.roomType' AS col, COALESCE("roomType",'<NULL>') AS val, count(*)::int AS n FROM "CommissionClaimItem" GROUP BY 2
UNION ALL
SELECT 'RoomType.kind' AS col, COALESCE("kind",'<NULL>') AS val, count(*)::int AS n FROM "RoomType" GROUP BY 2
UNION ALL
SELECT 'AgentLevelThreshold.agentLevel' AS col, COALESCE("agentLevel",'<NULL>') AS val, count(*)::int AS n FROM "AgentLevelThreshold" GROUP BY 2
UNION ALL
SELECT 'NotificationLog.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "NotificationLog" GROUP BY 2
UNION ALL
SELECT 'NotificationLog.errorReason' AS col, COALESCE("errorReason",'<NULL>') AS val, count(*)::int AS n FROM "NotificationLog" GROUP BY 2
UNION ALL
SELECT 'IcAccessLog.viewerScope' AS col, COALESCE("viewerScope",'<NULL>') AS val, count(*)::int AS n FROM "IcAccessLog" GROUP BY 2
UNION ALL
SELECT 'PendingUpload.uploadType' AS col, COALESCE("uploadType",'<NULL>') AS val, count(*)::int AS n FROM "PendingUpload" GROUP BY 2
UNION ALL
SELECT 'PendingUpload.contentType' AS col, COALESCE("contentType",'<NULL>') AS val, count(*)::int AS n FROM "PendingUpload" GROUP BY 2
UNION ALL
SELECT 'PendingUpload.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "PendingUpload" GROUP BY 2
UNION ALL
SELECT 'Project.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Project" GROUP BY 2
UNION ALL
SELECT 'SalesUnit.purpose' AS col, COALESCE("purpose",'<NULL>') AS val, count(*)::int AS n FROM "SalesUnit" GROUP BY 2
UNION ALL
SELECT 'SalesUnit.sourceFlag' AS col, COALESCE("sourceFlag",'<NULL>') AS val, count(*)::int AS n FROM "SalesUnit" GROUP BY 2
UNION ALL
SELECT 'RenovationProgress.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "RenovationProgress" GROUP BY 2
UNION ALL
SELECT 'RenovationTransition.fromStatus' AS col, COALESCE("fromStatus",'<NULL>') AS val, count(*)::int AS n FROM "RenovationTransition" GROUP BY 2
UNION ALL
SELECT 'RenovationTransition.toStatus' AS col, COALESCE("toStatus",'<NULL>') AS val, count(*)::int AS n FROM "RenovationTransition" GROUP BY 2
UNION ALL
SELECT 'RenovationPackage.key' AS col, COALESCE("key",'<NULL>') AS val, count(*)::int AS n FROM "RenovationPackage" GROUP BY 2
UNION ALL
SELECT 'RenovationStageProgress.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "RenovationStageProgress" GROUP BY 2
UNION ALL
SELECT 'SalesClaimDefault.appliesTo' AS col, COALESCE("appliesTo",'<NULL>') AS val, count(*)::int AS n FROM "SalesClaimDefault" GROUP BY 2
UNION ALL
SELECT 'SalesClaimDefault.commissionType' AS col, COALESCE("commissionType",'<NULL>') AS val, count(*)::int AS n FROM "SalesClaimDefault" GROUP BY 2
UNION ALL
SELECT 'SalesClaimDefault.paymentType' AS col, COALESCE("paymentType",'<NULL>') AS val, count(*)::int AS n FROM "SalesClaimDefault" GROUP BY 2
UNION ALL
SELECT 'SalesClaimDefaultSplit.splitType' AS col, COALESCE("splitType",'<NULL>') AS val, count(*)::int AS n FROM "SalesClaimDefaultSplit" GROUP BY 2
UNION ALL
SELECT 'ProjectVerificationTransition.fromStatus' AS col, COALESCE("fromStatus",'<NULL>') AS val, count(*)::int AS n FROM "ProjectVerificationTransition" GROUP BY 2
UNION ALL
SELECT 'ProjectVerificationTransition.toStatus' AS col, COALESCE("toStatus",'<NULL>') AS val, count(*)::int AS n FROM "ProjectVerificationTransition" GROUP BY 2
UNION ALL
SELECT 'RenovationPackageSplit.roleLabel' AS col, COALESCE("roleLabel",'<NULL>') AS val, count(*)::int AS n FROM "RenovationPackageSplit" GROUP BY 2
UNION ALL
SELECT 'RenovationPackageSplit.splitType' AS col, COALESCE("splitType",'<NULL>') AS val, count(*)::int AS n FROM "RenovationPackageSplit" GROUP BY 2
UNION ALL
SELECT 'RenovationClaim.paymentType' AS col, COALESCE("paymentType",'<NULL>') AS val, count(*)::int AS n FROM "RenovationClaim" GROUP BY 2
UNION ALL
SELECT 'RenovationClaim.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "RenovationClaim" GROUP BY 2
UNION ALL
SELECT 'RenovationClaimSplit.splitType' AS col, COALESCE("splitType",'<NULL>') AS val, count(*)::int AS n FROM "RenovationClaimSplit" GROUP BY 2
UNION ALL
SELECT 'RenovationClaimDocument.kind' AS col, COALESCE("kind",'<NULL>') AS val, count(*)::int AS n FROM "RenovationClaimDocument" GROUP BY 2
UNION ALL
SELECT 'UnitReservationDocument.kind' AS col, COALESCE("kind",'<NULL>') AS val, count(*)::int AS n FROM "UnitReservationDocument" GROUP BY 2
UNION ALL
SELECT 'RenovationClaimTransition.fromStatus' AS col, COALESCE("fromStatus",'<NULL>') AS val, count(*)::int AS n FROM "RenovationClaimTransition" GROUP BY 2
UNION ALL
SELECT 'RenovationClaimTransition.toStatus' AS col, COALESCE("toStatus",'<NULL>') AS val, count(*)::int AS n FROM "RenovationClaimTransition" GROUP BY 2
UNION ALL
SELECT 'SalesClaim.commissionType' AS col, COALESCE("commissionType",'<NULL>') AS val, count(*)::int AS n FROM "SalesClaim" GROUP BY 2
UNION ALL
SELECT 'SalesClaim.paymentType' AS col, COALESCE("paymentType",'<NULL>') AS val, count(*)::int AS n FROM "SalesClaim" GROUP BY 2
UNION ALL
SELECT 'SalesClaim.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "SalesClaim" GROUP BY 2
UNION ALL
SELECT 'SalesClaimSplit.roleLabel' AS col, COALESCE("roleLabel",'<NULL>') AS val, count(*)::int AS n FROM "SalesClaimSplit" GROUP BY 2
UNION ALL
SELECT 'SalesClaimSplit.splitType' AS col, COALESCE("splitType",'<NULL>') AS val, count(*)::int AS n FROM "SalesClaimSplit" GROUP BY 2
UNION ALL
SELECT 'SalesClaimTransition.fromStatus' AS col, COALESCE("fromStatus",'<NULL>') AS val, count(*)::int AS n FROM "SalesClaimTransition" GROUP BY 2
UNION ALL
SELECT 'SalesClaimTransition.toStatus' AS col, COALESCE("toStatus",'<NULL>') AS val, count(*)::int AS n FROM "SalesClaimTransition" GROUP BY 2
UNION ALL
SELECT 'SettingsLabel.category' AS col, COALESCE("category",'<NULL>') AS val, count(*)::int AS n FROM "SettingsLabel" GROUP BY 2
UNION ALL
SELECT 'SettingsLabel.key' AS col, COALESCE("key",'<NULL>') AS val, count(*)::int AS n FROM "SettingsLabel" GROUP BY 2
UNION ALL
SELECT 'DocumentTemplate.docType' AS col, COALESCE("docType",'<NULL>') AS val, count(*)::int AS n FROM "DocumentTemplate" GROUP BY 2
UNION ALL
SELECT 'ReferenceSequence.docType' AS col, COALESCE("docType",'<NULL>') AS val, count(*)::int AS n FROM "ReferenceSequence" GROUP BY 2
UNION ALL
SELECT 'BillingDocument.docType' AS col, COALESCE("docType",'<NULL>') AS val, count(*)::int AS n FROM "BillingDocument" GROUP BY 2
UNION ALL
SELECT 'BillingDocument.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "BillingDocument" GROUP BY 2
UNION ALL
SELECT 'BillingDocument.counterpartyType' AS col, COALESCE("counterpartyType",'<NULL>') AS val, count(*)::int AS n FROM "BillingDocument" GROUP BY 2
UNION ALL
SELECT 'BillingDocument.reason' AS col, COALESCE("reason",'<NULL>') AS val, count(*)::int AS n FROM "BillingDocument" GROUP BY 2
UNION ALL
SELECT 'BillingDocument.documentStatus' AS col, COALESCE("documentStatus",'<NULL>') AS val, count(*)::int AS n FROM "BillingDocument" GROUP BY 2
UNION ALL
SELECT 'BillingDocument.settlementStatus' AS col, COALESCE("settlementStatus",'<NULL>') AS val, count(*)::int AS n FROM "BillingDocument" GROUP BY 2
UNION ALL
SELECT 'BillingDocument.taxStatus' AS col, COALESCE("taxStatus",'<NULL>') AS val, count(*)::int AS n FROM "BillingDocument" GROUP BY 2
UNION ALL
SELECT 'BillingDocument.commercialDocumentType' AS col, COALESCE("commercialDocumentType",'<NULL>') AS val, count(*)::int AS n FROM "BillingDocument" GROUP BY 2
UNION ALL
SELECT 'BillingDocument.ledgerTreatment' AS col, COALESCE("ledgerTreatment",'<NULL>') AS val, count(*)::int AS n FROM "BillingDocument" GROUP BY 2
UNION ALL
SELECT 'BillingDocument.ownerRefDiffersReason' AS col, COALESCE("ownerRefDiffersReason",'<NULL>') AS val, count(*)::int AS n FROM "BillingDocument" GROUP BY 2
UNION ALL
SELECT 'Refund.method' AS col, COALESCE("method",'<NULL>') AS val, count(*)::int AS n FROM "Refund" GROUP BY 2
UNION ALL
SELECT 'SupplierExpense.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "SupplierExpense" GROUP BY 2
UNION ALL
SELECT 'SupplierExpenseAllocation.borneBy' AS col, COALESCE("borneBy",'<NULL>') AS val, count(*)::int AS n FROM "SupplierExpenseAllocation" GROUP BY 2
UNION ALL
SELECT 'SupplierExpenseAllocation.recoveryStatus' AS col, COALESCE("recoveryStatus",'<NULL>') AS val, count(*)::int AS n FROM "SupplierExpenseAllocation" GROUP BY 2
UNION ALL
SELECT 'KaenOperatingExpense.category' AS col, COALESCE("category",'<NULL>') AS val, count(*)::int AS n FROM "KaenOperatingExpense" GROUP BY 2
UNION ALL
SELECT 'KaenOperatingExpense.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "KaenOperatingExpense" GROUP BY 2
UNION ALL
SELECT 'OwnerFundingRequest.reason' AS col, COALESCE("reason",'<NULL>') AS val, count(*)::int AS n FROM "OwnerFundingRequest" GROUP BY 2
UNION ALL
SELECT 'OwnerFundingRequest.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "OwnerFundingRequest" GROUP BY 2
UNION ALL
SELECT 'AgentCardVersion.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "AgentCardVersion" GROUP BY 2
UNION ALL
SELECT 'AgentCardVersion.submittedByType' AS col, COALESCE("submittedByType",'<NULL>') AS val, count(*)::int AS n FROM "AgentCardVersion" GROUP BY 2
UNION ALL
SELECT 'AgentCardVersion.rejectionReason' AS col, COALESCE("rejectionReason",'<NULL>') AS val, count(*)::int AS n FROM "AgentCardVersion" GROUP BY 2
UNION ALL
SELECT 'UnitReservation.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "UnitReservation" GROUP BY 2
UNION ALL
SELECT 'UnitReservation.applicantState' AS col, COALESCE("applicantState",'<NULL>') AS val, count(*)::int AS n FROM "UnitReservation" GROUP BY 2
UNION ALL
SELECT 'UnitReservation.signatureDrawingKey' AS col, COALESCE("signatureDrawingKey",'<NULL>') AS val, count(*)::int AS n FROM "UnitReservation" GROUP BY 2
UNION ALL
SELECT 'UnitReservation.signatureTypedName' AS col, COALESCE("signatureTypedName",'<NULL>') AS val, count(*)::int AS n FROM "UnitReservation" GROUP BY 2
UNION ALL
SELECT 'UnitReservation.cancelReason' AS col, COALESCE("cancelReason",'<NULL>') AS val, count(*)::int AS n FROM "UnitReservation" GROUP BY 2
UNION ALL
SELECT 'UnitReservationTransition.fromStatus' AS col, COALESCE("fromStatus",'<NULL>') AS val, count(*)::int AS n FROM "UnitReservationTransition" GROUP BY 2
UNION ALL
SELECT 'UnitReservationTransition.toStatus' AS col, COALESCE("toStatus",'<NULL>') AS val, count(*)::int AS n FROM "UnitReservationTransition" GROUP BY 2
UNION ALL
SELECT 'Invoice.invoiceType' AS col, COALESCE("invoiceType",'<NULL>') AS val, count(*)::int AS n FROM "Invoice" GROUP BY 2
UNION ALL
SELECT 'Invoice.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Invoice" GROUP BY 2
UNION ALL
SELECT 'Invoice.statementNumber' AS col, COALESCE("statementNumber",'<NULL>') AS val, count(*)::int AS n FROM "Invoice" GROUP BY 2
UNION ALL
SELECT 'MeterReading.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "MeterReading" GROUP BY 2
UNION ALL
SELECT 'ManagementFeeConfig.feeType' AS col, COALESCE("feeType",'<NULL>') AS val, count(*)::int AS n FROM "ManagementFeeConfig" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerEntry.direction' AS col, COALESCE("direction",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerEntry" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerEntry.category' AS col, COALESCE("category",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerEntry" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerEntry.paidBy' AS col, COALESCE("paidBy",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerEntry" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerEntry.paymentStatus' AS col, COALESCE("paymentStatus",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerEntry" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerEntry.taxCategory' AS col, COALESCE("taxCategory",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerEntry" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerEntry.sourceType' AS col, COALESCE("sourceType",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerEntry" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerEntry.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerEntry" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerEntry.settlementKind' AS col, COALESCE("settlementKind",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerEntry" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerEntry.paymentMethod' AS col, COALESCE("paymentMethod",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerEntry" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerEntry.proofStatus' AS col, COALESCE("proofStatus",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerEntry" GROUP BY 2
UNION ALL
SELECT 'OwnerStatementPeriod.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "OwnerStatementPeriod" GROUP BY 2
UNION ALL
SELECT 'OwnerStatementFreezeManifestRow.direction' AS col, COALESCE("direction",'<NULL>') AS val, count(*)::int AS n FROM "OwnerStatementFreezeManifestRow" GROUP BY 2
UNION ALL
SELECT 'OwnerStatementFreezeManifestRow.category' AS col, COALESCE("category",'<NULL>') AS val, count(*)::int AS n FROM "OwnerStatementFreezeManifestRow" GROUP BY 2
UNION ALL
SELECT 'OwnerStatementFreezeManifestRow.paidBy' AS col, COALESCE("paidBy",'<NULL>') AS val, count(*)::int AS n FROM "OwnerStatementFreezeManifestRow" GROUP BY 2
UNION ALL
SELECT 'OwnerStatementFreezeManifestRow.paymentStatus' AS col, COALESCE("paymentStatus",'<NULL>') AS val, count(*)::int AS n FROM "OwnerStatementFreezeManifestRow" GROUP BY 2
UNION ALL
SELECT 'OwnerStatementFreezeManifestRow.sourceType' AS col, COALESCE("sourceType",'<NULL>') AS val, count(*)::int AS n FROM "OwnerStatementFreezeManifestRow" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerReconciliationFinding.checkKind' AS col, COALESCE("checkKind",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerReconciliationFinding" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerReconciliationFinding.findingType' AS col, COALESCE("findingType",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerReconciliationFinding" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerReconciliationFinding.sourceType' AS col, COALESCE("sourceType",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerReconciliationFinding" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerReconciliationFinding.expectedDirection' AS col, COALESCE("expectedDirection",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerReconciliationFinding" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerReconciliationFinding.severity' AS col, COALESCE("severity",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerReconciliationFinding" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerReconciliationFinding.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerReconciliationFinding" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerReconciliationFinding.reason' AS col, COALESCE("reason",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerReconciliationFinding" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerReconciliationRun.reconciliationType' AS col, COALESCE("reconciliationType",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerReconciliationRun" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerReconciliationRun.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerReconciliationRun" GROUP BY 2
UNION ALL
SELECT 'OwnerLedgerReconciliationRun.triggerType' AS col, COALESCE("triggerType",'<NULL>') AS val, count(*)::int AS n FROM "OwnerLedgerReconciliationRun" GROUP BY 2
UNION ALL
SELECT 'OwnerExpenseProof.category' AS col, COALESCE("category",'<NULL>') AS val, count(*)::int AS n FROM "OwnerExpenseProof" GROUP BY 2
UNION ALL
SELECT 'Task.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Task" GROUP BY 2
UNION ALL
SELECT 'Task.category' AS col, COALESCE("category",'<NULL>') AS val, count(*)::int AS n FROM "Task" GROUP BY 2
UNION ALL
SELECT 'Sprint.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Sprint" GROUP BY 2
UNION ALL
SELECT 'Ticket.category' AS col, COALESCE("category",'<NULL>') AS val, count(*)::int AS n FROM "Ticket" GROUP BY 2
UNION ALL
SELECT 'Ticket.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "Ticket" GROUP BY 2
UNION ALL
SELECT 'DeviceToken.platform' AS col, COALESCE("platform",'<NULL>') AS val, count(*)::int AS n FROM "DeviceToken" GROUP BY 2
UNION ALL
SELECT 'InvoiceDraftRun.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "InvoiceDraftRun" GROUP BY 2
UNION ALL
SELECT 'InvoiceDraftRun.triggeredBy' AS col, COALESCE("triggeredBy",'<NULL>') AS val, count(*)::int AS n FROM "InvoiceDraftRun" GROUP BY 2
UNION ALL
SELECT 'ImportRun.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "ImportRun" GROUP BY 2
UNION ALL
SELECT 'UnitUtilityBill.billingMode' AS col, COALESCE("billingMode",'<NULL>') AS val, count(*)::int AS n FROM "UnitUtilityBill" GROUP BY 2
UNION ALL
SELECT 'UnitUtilityBill.indahWaterBearer' AS col, COALESCE("indahWaterBearer",'<NULL>') AS val, count(*)::int AS n FROM "UnitUtilityBill" GROUP BY 2
UNION ALL
SELECT 'UnitUtilityBill.cleaningBearer' AS col, COALESCE("cleaningBearer",'<NULL>') AS val, count(*)::int AS n FROM "UnitUtilityBill" GROUP BY 2
UNION ALL
SELECT 'UnitUtilityBill.wifiBearer' AS col, COALESCE("wifiBearer",'<NULL>') AS val, count(*)::int AS n FROM "UnitUtilityBill" GROUP BY 2
UNION ALL
SELECT 'UnitUtilityBill.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "UnitUtilityBill" GROUP BY 2
UNION ALL
SELECT 'UtilityAllocation.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "UtilityAllocation" GROUP BY 2
UNION ALL
SELECT 'UnitBillsGridEntry.cleaningBearer' AS col, COALESCE("cleaningBearer",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsGridEntry" GROUP BY 2
UNION ALL
SELECT 'UnitBillsGridEntry.cleaningNature' AS col, COALESCE("cleaningNature",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsGridEntry" GROUP BY 2
UNION ALL
SELECT 'UnitBillsGridEntry.tnbPattern' AS col, COALESCE("tnbPattern",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsGridEntry" GROUP BY 2
UNION ALL
SELECT 'UnitBillsGridEntry.airPattern' AS col, COALESCE("airPattern",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsGridEntry" GROUP BY 2
UNION ALL
SELECT 'UnitBillsGridEntry.wifiBearer' AS col, COALESCE("wifiBearer",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsGridEntry" GROUP BY 2
UNION ALL
SELECT 'UnitBillsGridEntry.wifiNature' AS col, COALESCE("wifiNature",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsGridEntry" GROUP BY 2
UNION ALL
SELECT 'UnitBillsGridEntry.maintenanceFeeBearer' AS col, COALESCE("maintenanceFeeBearer",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsGridEntry" GROUP BY 2
UNION ALL
SELECT 'UnitBillsGridEntry.paymentStatus' AS col, COALESCE("paymentStatus",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsGridEntry" GROUP BY 2
UNION ALL
SELECT 'GridExpense.bearer' AS col, COALESCE("bearer",'<NULL>') AS val, count(*)::int AS n FROM "GridExpense" GROUP BY 2
UNION ALL
SELECT 'GridExpense.nature' AS col, COALESCE("nature",'<NULL>') AS val, count(*)::int AS n FROM "GridExpense" GROUP BY 2
UNION ALL
SELECT 'GridExpense.status' AS col, COALESCE("status",'<NULL>') AS val, count(*)::int AS n FROM "GridExpense" GROUP BY 2
UNION ALL
SELECT 'UnitBillsBearerConfig.tnbPattern' AS col, COALESCE("tnbPattern",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsBearerConfig" GROUP BY 2
UNION ALL
SELECT 'UnitBillsBearerConfig.airPattern' AS col, COALESCE("airPattern",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsBearerConfig" GROUP BY 2
UNION ALL
SELECT 'UnitBillsBearerConfig.cleaningBearer' AS col, COALESCE("cleaningBearer",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsBearerConfig" GROUP BY 2
UNION ALL
SELECT 'UnitBillsBearerConfig.wifiBearer' AS col, COALESCE("wifiBearer",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsBearerConfig" GROUP BY 2
UNION ALL
SELECT 'UnitBillsBearerConfig.maintenanceFeeBearer' AS col, COALESCE("maintenanceFeeBearer",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsBearerConfig" GROUP BY 2
UNION ALL
SELECT 'UnitBillsBearerConfig.cleaningNature' AS col, COALESCE("cleaningNature",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsBearerConfig" GROUP BY 2
UNION ALL
SELECT 'UnitBillsBearerConfig.wifiNature' AS col, COALESCE("wifiNature",'<NULL>') AS val, count(*)::int AS n FROM "UnitBillsBearerConfig" GROUP BY 2
UNION ALL
SELECT 'RecurringChargeDefinition.kind' AS col, COALESCE("kind",'<NULL>') AS val, count(*)::int AS n FROM "RecurringChargeDefinition" GROUP BY 2
UNION ALL
SELECT 'RecurringChargeRevision.bearer' AS col, COALESCE("bearer",'<NULL>') AS val, count(*)::int AS n FROM "RecurringChargeRevision" GROUP BY 2
UNION ALL
SELECT 'RecurringChargeRevision.nature' AS col, COALESCE("nature",'<NULL>') AS val, count(*)::int AS n FROM "RecurringChargeRevision" GROUP BY 2
UNION ALL
SELECT 'GridEntryRecurringLine.bearer' AS col, COALESCE("bearer",'<NULL>') AS val, count(*)::int AS n FROM "GridEntryRecurringLine" GROUP BY 2
UNION ALL
SELECT 'GridEntryRecurringLine.nature' AS col, COALESCE("nature",'<NULL>') AS val, count(*)::int AS n FROM "GridEntryRecurringLine" GROUP BY 2
UNION ALL
SELECT 'GridEntryRecurringLine.categoryCode' AS col, COALESCE("categoryCode",'<NULL>') AS val, count(*)::int AS n FROM "GridEntryRecurringLine" GROUP BY 2
UNION ALL
SELECT 'GridEntryRecurringLine.categoryName' AS col, COALESCE("categoryName",'<NULL>') AS val, count(*)::int AS n FROM "GridEntryRecurringLine" GROUP BY 2
UNION ALL
SELECT 'GridEntryRecurringLine.categoryFamily' AS col, COALESCE("categoryFamily",'<NULL>') AS val, count(*)::int AS n FROM "GridEntryRecurringLine" GROUP BY 2
UNION ALL
SELECT 'GridEntryRecurringLine.kind' AS col, COALESCE("kind",'<NULL>') AS val, count(*)::int AS n FROM "GridEntryRecurringLine" GROUP BY 2
UNION ALL
SELECT 'GridAttachment.contentType' AS col, COALESCE("contentType",'<NULL>') AS val, count(*)::int AS n FROM "GridAttachment" GROUP BY 2
ORDER BY 1,3 DESC;
