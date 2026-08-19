-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "defaultCurrency" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "subscriptionPlan" TEXT NOT NULL,
    "billingCycleMode" TEXT NOT NULL DEFAULT 'calendar',
    "billLeadDays" INTEGER NOT NULL DEFAULT 30,
    "tenancyExpiryReminderDays" INTEGER NOT NULL DEFAULT 30,
    "currencyDisplay" TEXT NOT NULL DEFAULT 'code',
    "managementFeePercent" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "status" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "userType" TEXT NOT NULL DEFAULT 'operator',
    "partyId" UUID,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "verificationToken" TEXT,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "propertyCode" TEXT NOT NULL,
    "propertyType" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "publishStatus" TEXT NOT NULL,
    "managerId" UUID,
    "insuranceProvider" TEXT,
    "insurancePolicyNo" TEXT,
    "insuranceExpiryDate" TIMESTAMP(3),
    "insuranceCoverage" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hasPaxDeduction" BOOLEAN NOT NULL DEFAULT false,
    "paxDeductionAmount" DECIMAL(8,2),

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Building" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Building_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "buildingId" UUID,
    "unitCode" TEXT NOT NULL,
    "unitType" TEXT NOT NULL,
    "bedrooms" INTEGER,
    "bathrooms" DECIMAL(4,1),
    "floorArea" DECIMAL(12,2),
    "occupancyStatus" TEXT NOT NULL,
    "listingStatus" TEXT NOT NULL,
    "baseRentAmount" DECIMAL(12,2),
    "currency" TEXT NOT NULL,
    "publishedTitle" TEXT,
    "publishedDescription" TEXT,
    "floor" INTEGER,
    "facing" TEXT,
    "furnishingLevel" TEXT,
    "sizeSqft" DECIMAL(8,2),
    "rentalRate" DECIMAL(12,2),
    "depositMonths" INTEGER DEFAULT 2,
    "amenities" TEXT[],
    "photoKeys" TEXT[],
    "vacantSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitAttribute" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "attributeKey" TEXT NOT NULL,
    "attributeValue" TEXT NOT NULL,

    CONSTRAINT "UnitAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Party" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "partyType" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "legalName" TEXT,
    "primaryEmail" TEXT,
    "primaryPhone" TEXT,
    "status" TEXT NOT NULL,
    "idType" TEXT,
    "idNumber" TEXT,
    "nationality" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "emergencyContactRelation" TEXT,
    "employerName" TEXT,
    "employerAddress" TEXT,
    "monthlyIncome" DECIMAL(12,2),
    "race" TEXT,
    "gender" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "occupation" TEXT,
    "bankName" TEXT,
    "bankAccountHolder" TEXT,
    "bankAccountNumber" TEXT,
    "isBlacklisted" BOOLEAN NOT NULL DEFAULT false,
    "blacklistReason" TEXT,
    "agentLevel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyRole" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "roleType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartyRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenancy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "tenantPartyId" UUID NOT NULL,
    "tenancyCode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "billingStatus" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "monthlyRentAmount" DECIMAL(12,2) NOT NULL,
    "depositAmount" DECIMAL(12,2),
    "termMonths" INTEGER,
    "nextActionDate" TIMESTAMP(3),
    "balanceDueAmount" DECIMAL(12,2),
    "moveInChecklist" JSONB,
    "moveOutChecklist" JSONB,
    "depositDeductions" JSONB,
    "depositRefundAmount" DECIMAL(12,2),
    "depositRefundDate" TIMESTAMP(3),
    "depositRefundNote" TEXT,
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "autoRenewTermMonths" INTEGER,
    "moveInNotes" TEXT,
    "moveOutNotes" TEXT,
    "statementSentAt" TIMESTAMP(3),
    "previousTenancyId" UUID,
    "noticePeriodDays" INTEGER DEFAULT 30,
    "noticeGivenDate" TIMESTAMP(3),
    "noticeGivenBy" TEXT,
    "overdueCount" INTEGER NOT NULL DEFAULT 0,
    "lastOverdueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandlordTenancy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "landlordId" UUID NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "monthlyRent" DECIMAL(12,2) NOT NULL,
    "depositAmount" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LandlordTenancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refundDate" TIMESTAMP(3),
    "refundNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Charge" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "chargeNumber" TEXT NOT NULL,
    "tenancyId" UUID,
    "unitId" UUID,
    "partyId" UUID NOT NULL,
    "chargeType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT,
    "dueDate" DATE NOT NULL,
    "postedAt" TIMESTAMP(3),
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "outstandingAmount" DECIMAL(12,2) NOT NULL,
    "waivedReason" TEXT,
    "cancelledReason" TEXT,
    "isDisputed" BOOLEAN NOT NULL DEFAULT false,
    "disputeReason" TEXT,
    "disputeStatus" TEXT,
    "disputeResolution" TEXT,
    "disputeResolvedAt" TIMESTAMP(3),
    "chargeableFrom" TIMESTAMP(3),
    "chargeableTo" TIMESTAMP(3),
    "lateFeeApplied" BOOLEAN NOT NULL DEFAULT false,
    "lateFeeAmount" DECIMAL(12,2),
    "parentChargeId" UUID,
    "attachmentKeys" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargeEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "chargeId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "actorUserId" UUID,
    "payloadJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ChargeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargeTemplate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "chargeType" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "frequency" TEXT NOT NULL,
    "description" TEXT,
    "propertyType" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChargeTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringCharge" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "chargeType" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "frequency" TEXT NOT NULL DEFAULT 'monthly',
    "dayOfMonth" INTEGER NOT NULL DEFAULT 1,
    "nextChargeDate" TIMESTAMP(3) NOT NULL,
    "lastGeneratedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LateFeeRule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "daysAfterDue" INTEGER NOT NULL DEFAULT 5,
    "feeType" TEXT NOT NULL DEFAULT 'flat',
    "feeAmount" DECIMAL(10,2) NOT NULL,
    "maxAmount" DECIMAL(10,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "appliesTo" TEXT NOT NULL DEFAULT 'all',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LateFeeRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentNumber" TEXT NOT NULL,
    "partyId" UUID NOT NULL,
    "paymentType" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "referenceNote" TEXT,
    "externalReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "chargeId" UUID NOT NULL,
    "allocatedAmount" DECIMAL(12,2) NOT NULL,
    "allocatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bill" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "billNumber" TEXT NOT NULL,
    "partyId" UUID NOT NULL,
    "propertyId" UUID,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dueDate" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "movementNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "propertyId" UUID,
    "partyId" UUID,
    "movementDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentTender" TEXT,
    "allocatedAmount" DECIMAL(12,2) DEFAULT 0,
    "allocationStatus" TEXT NOT NULL DEFAULT 'registered',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID,
    "domain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "actionUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationQueue" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'general',
    "recipientEmail" TEXT NOT NULL,
    "recipientName" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sentAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "sesMessageId" TEXT,
    "updatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID,
    "userName" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "performedBy" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRequest" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "photoKeys" TEXT[],
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentLink" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "linkedEntityType" TEXT NOT NULL,
    "linkedEntityId" UUID NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'info',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTierMapping" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimType" TEXT NOT NULL,
    "agentLevel" TEXT NOT NULL,
    "percentage" DECIMAL(5,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTierMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionClaim" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimNumber" TEXT NOT NULL,
    "agentPartyId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedBy" UUID,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" UUID,
    "rejectionReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidBy" UUID,
    "totalNettPayout" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "claimType" TEXT NOT NULL,
    "billId" UUID,
    "cashMovementId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionClaimItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "propertyId" UUID,
    "condoName" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL,
    "roomType" TEXT NOT NULL,
    "tenantName" TEXT NOT NULL,
    "salesDate" DATE NOT NULL,
    "moveInDate" DATE NOT NULL,
    "monthlyRental" DECIMAL(12,2) NOT NULL,
    "agentTierPercentage" DECIMAL(5,2) NOT NULL,
    "commissionPercentage" DECIMAL(5,2) NOT NULL,
    "tenancyChargesByAgent" DECIMAL(12,2) NOT NULL,
    "tenancyChargesByKaen" DECIMAL(12,2) NOT NULL,
    "numberOfPax" INTEGER,
    "nettPayout" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionClaimItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomType" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_status_idx" ON "Organization"("status");

-- CreateIndex
CREATE UNIQUE INDEX "User_partyId_key" ON "User"("partyId");

-- CreateIndex
CREATE INDEX "User_organizationId_status_idx" ON "User"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_email_key" ON "User"("organizationId", "email");

-- CreateIndex
CREATE INDEX "RoleAssignment_organizationId_userId_idx" ON "RoleAssignment"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "RoleAssignment_organizationId_role_idx" ON "RoleAssignment"("organizationId", "role");

-- CreateIndex
CREATE INDEX "Property_organizationId_status_idx" ON "Property"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Property_organizationId_propertyCode_key" ON "Property"("organizationId", "propertyCode");

-- CreateIndex
CREATE INDEX "Building_organizationId_propertyId_idx" ON "Building"("organizationId", "propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "Building_organizationId_propertyId_code_key" ON "Building"("organizationId", "propertyId", "code");

-- CreateIndex
CREATE INDEX "Unit_organizationId_propertyId_occupancyStatus_idx" ON "Unit"("organizationId", "propertyId", "occupancyStatus");

-- CreateIndex
CREATE INDEX "Unit_organizationId_listingStatus_idx" ON "Unit"("organizationId", "listingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_organizationId_propertyId_unitCode_key" ON "Unit"("organizationId", "propertyId", "unitCode");

-- CreateIndex
CREATE UNIQUE INDEX "UnitAttribute_organizationId_unitId_attributeKey_key" ON "UnitAttribute"("organizationId", "unitId", "attributeKey");

-- CreateIndex
CREATE INDEX "Party_organizationId_status_idx" ON "Party"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Party_organizationId_partyType_idx" ON "Party"("organizationId", "partyType");

-- CreateIndex
CREATE INDEX "Party_organizationId_displayName_idx" ON "Party"("organizationId", "displayName");

-- CreateIndex
CREATE INDEX "Party_organizationId_agentLevel_idx" ON "Party"("organizationId", "agentLevel");

-- CreateIndex
CREATE INDEX "PartyRole_organizationId_partyId_idx" ON "PartyRole"("organizationId", "partyId");

-- CreateIndex
CREATE INDEX "PartyRole_organizationId_roleType_status_idx" ON "PartyRole"("organizationId", "roleType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Tenancy_previousTenancyId_key" ON "Tenancy"("previousTenancyId");

-- CreateIndex
CREATE INDEX "Tenancy_organizationId_status_idx" ON "Tenancy"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Tenancy_organizationId_billingStatus_idx" ON "Tenancy"("organizationId", "billingStatus");

-- CreateIndex
CREATE INDEX "Tenancy_organizationId_unitId_idx" ON "Tenancy"("organizationId", "unitId");

-- CreateIndex
CREATE INDEX "Tenancy_organizationId_endDate_idx" ON "Tenancy"("organizationId", "endDate");

-- CreateIndex
CREATE INDEX "Tenancy_organizationId_tenantPartyId_status_idx" ON "Tenancy"("organizationId", "tenantPartyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Tenancy_organizationId_tenancyCode_key" ON "Tenancy"("organizationId", "tenancyCode");

-- CreateIndex
CREATE INDEX "LandlordTenancy_organizationId_status_idx" ON "LandlordTenancy"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Deposit_organizationId_status_idx" ON "Deposit"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Deposit_organizationId_tenancyId_idx" ON "Deposit"("organizationId", "tenancyId");

-- CreateIndex
CREATE INDEX "Deposit_organizationId_partyId_idx" ON "Deposit"("organizationId", "partyId");

-- CreateIndex
CREATE INDEX "Charge_organizationId_partyId_status_idx" ON "Charge"("organizationId", "partyId", "status");

-- CreateIndex
CREATE INDEX "Charge_organizationId_tenancyId_status_idx" ON "Charge"("organizationId", "tenancyId", "status");

-- CreateIndex
CREATE INDEX "Charge_organizationId_dueDate_status_idx" ON "Charge"("organizationId", "dueDate", "status");

-- CreateIndex
CREATE INDEX "Charge_organizationId_status_postedAt_idx" ON "Charge"("organizationId", "status", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Charge_organizationId_chargeNumber_key" ON "Charge"("organizationId", "chargeNumber");

-- CreateIndex
CREATE INDEX "ChargeEvent_organizationId_chargeId_eventAt_idx" ON "ChargeEvent"("organizationId", "chargeId", "eventAt" DESC);

-- CreateIndex
CREATE INDEX "ChargeTemplate_organizationId_isActive_idx" ON "ChargeTemplate"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "ChargeTemplate_organizationId_propertyType_idx" ON "ChargeTemplate"("organizationId", "propertyType");

-- CreateIndex
CREATE INDEX "RecurringCharge_organizationId_isActive_idx" ON "RecurringCharge"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "RecurringCharge_organizationId_nextChargeDate_idx" ON "RecurringCharge"("organizationId", "nextChargeDate");

-- CreateIndex
CREATE INDEX "LateFeeRule_organizationId_isActive_idx" ON "LateFeeRule"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "Payment_organizationId_partyId_receivedAt_idx" ON "Payment"("organizationId", "partyId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "Payment_organizationId_status_idx" ON "Payment"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Payment_organizationId_createdAt_idx" ON "Payment"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_organizationId_paymentNumber_key" ON "Payment"("organizationId", "paymentNumber");

-- CreateIndex
CREATE INDEX "PaymentAllocation_organizationId_paymentId_idx" ON "PaymentAllocation"("organizationId", "paymentId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_organizationId_chargeId_idx" ON "PaymentAllocation"("organizationId", "chargeId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_organizationId_paymentId_chargeId_allocat_key" ON "PaymentAllocation"("organizationId", "paymentId", "chargeId", "allocatedAt");

-- CreateIndex
CREATE INDEX "Bill_organizationId_status_idx" ON "Bill"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Bill_organizationId_partyId_idx" ON "Bill"("organizationId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_organizationId_billNumber_key" ON "Bill"("organizationId", "billNumber");

-- CreateIndex
CREATE INDEX "CashMovement_organizationId_type_idx" ON "CashMovement"("organizationId", "type");

-- CreateIndex
CREATE INDEX "CashMovement_organizationId_movementDate_idx" ON "CashMovement"("organizationId", "movementDate");

-- CreateIndex
CREATE UNIQUE INDEX "CashMovement_organizationId_movementNumber_key" ON "CashMovement"("organizationId", "movementNumber");

-- CreateIndex
CREATE INDEX "Notification_organizationId_read_idx" ON "Notification"("organizationId", "read");

-- CreateIndex
CREATE INDEX "Notification_organizationId_domain_idx" ON "Notification"("organizationId", "domain");

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "NotificationQueue_organizationId_status_idx" ON "NotificationQueue"("organizationId", "status");

-- CreateIndex
CREATE INDEX "EmailTemplate_organizationId_isActive_idx" ON "EmailTemplate"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_organizationId_name_key" ON "EmailTemplate"("organizationId", "name");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_entityType_entityId_idx" ON "AuditLog"("organizationId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_action_idx" ON "AuditLog"("organizationId", "action");

-- CreateIndex
CREATE INDEX "ActivityLog_organizationId_entityType_entityId_idx" ON "ActivityLog"("organizationId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "ActivityLog_organizationId_createdAt_idx" ON "ActivityLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "MaintenanceRequest_organizationId_tenancyId_status_idx" ON "MaintenanceRequest"("organizationId", "tenancyId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceRequest_organizationId_status_createdAt_idx" ON "MaintenanceRequest"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceRequest_organizationId_requestNumber_key" ON "MaintenanceRequest"("organizationId", "requestNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Document_storageKey_key" ON "Document"("storageKey");

-- CreateIndex
CREATE INDEX "Document_organizationId_idx" ON "Document"("organizationId");

-- CreateIndex
CREATE INDEX "DocumentLink_organizationId_linkedEntityType_linkedEntityId_idx" ON "DocumentLink"("organizationId", "linkedEntityType", "linkedEntityId");

-- CreateIndex
CREATE INDEX "DocumentLink_organizationId_documentId_idx" ON "DocumentLink"("organizationId", "documentId");

-- CreateIndex
CREATE INDEX "Announcement_organizationId_active_startDate_endDate_idx" ON "Announcement"("organizationId", "active", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "AgentTierMapping_organizationId_isActive_idx" ON "AgentTierMapping"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTierMapping_organizationId_claimType_agentLevel_key" ON "AgentTierMapping"("organizationId", "claimType", "agentLevel");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionClaim_billId_key" ON "CommissionClaim"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionClaim_cashMovementId_key" ON "CommissionClaim"("cashMovementId");

-- CreateIndex
CREATE INDEX "CommissionClaim_organizationId_agentPartyId_status_idx" ON "CommissionClaim"("organizationId", "agentPartyId", "status");

-- CreateIndex
CREATE INDEX "CommissionClaim_organizationId_status_createdAt_idx" ON "CommissionClaim"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CommissionClaim_organizationId_createdAt_idx" ON "CommissionClaim"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "CommissionClaim_organizationId_claimType_status_createdAt_idx" ON "CommissionClaim"("organizationId", "claimType", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionClaim_organizationId_claimNumber_key" ON "CommissionClaim"("organizationId", "claimNumber");

-- CreateIndex
CREATE INDEX "CommissionClaimItem_organizationId_claimId_idx" ON "CommissionClaimItem"("organizationId", "claimId");

-- CreateIndex
CREATE INDEX "CommissionClaimItem_organizationId_unitCode_tenantName_sale_idx" ON "CommissionClaimItem"("organizationId", "unitCode", "tenantName", "salesDate");

-- CreateIndex
CREATE INDEX "RoomType_organizationId_propertyId_isActive_idx" ON "RoomType"("organizationId", "propertyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RoomType_organizationId_propertyId_name_key" ON "RoomType"("organizationId", "propertyId", "name");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Building" ADD CONSTRAINT "Building_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Building" ADD CONSTRAINT "Building_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitAttribute" ADD CONSTRAINT "UnitAttribute_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitAttribute" ADD CONSTRAINT "UnitAttribute_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartyRole" ADD CONSTRAINT "PartyRole_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartyRole" ADD CONSTRAINT "PartyRole_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_tenantPartyId_fkey" FOREIGN KEY ("tenantPartyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_previousTenancyId_fkey" FOREIGN KEY ("previousTenancyId") REFERENCES "Tenancy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandlordTenancy" ADD CONSTRAINT "LandlordTenancy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandlordTenancy" ADD CONSTRAINT "LandlordTenancy_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandlordTenancy" ADD CONSTRAINT "LandlordTenancy_landlordId_fkey" FOREIGN KEY ("landlordId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeEvent" ADD CONSTRAINT "ChargeEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeEvent" ADD CONSTRAINT "ChargeEvent_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeTemplate" ADD CONSTRAINT "ChargeTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringCharge" ADD CONSTRAINT "RecurringCharge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringCharge" ADD CONSTRAINT "RecurringCharge_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LateFeeRule" ADD CONSTRAINT "LateFeeRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationQueue" ADD CONSTRAINT "NotificationQueue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTierMapping" ADD CONSTRAINT "AgentTierMapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionClaim" ADD CONSTRAINT "CommissionClaim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionClaim" ADD CONSTRAINT "CommissionClaim_agentPartyId_fkey" FOREIGN KEY ("agentPartyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionClaim" ADD CONSTRAINT "CommissionClaim_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionClaim" ADD CONSTRAINT "CommissionClaim_cashMovementId_fkey" FOREIGN KEY ("cashMovementId") REFERENCES "CashMovement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionClaimItem" ADD CONSTRAINT "CommissionClaimItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionClaimItem" ADD CONSTRAINT "CommissionClaimItem_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "CommissionClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionClaimItem" ADD CONSTRAINT "CommissionClaimItem_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomType" ADD CONSTRAINT "RoomType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomType" ADD CONSTRAINT "RoomType_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

