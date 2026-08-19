export type AdminRole = "admin" | "manager" | "editor";

const RANK: Record<AdminRole, number> = { editor: 1, manager: 2, admin: 3 };

export function atLeast(role: AdminRole, min: AdminRole): boolean {
  return RANK[role] >= RANK[min];
}

export function canDelete(role: AdminRole): boolean {
  return role === "admin";
}

export function canApprove(role: AdminRole): boolean {
  return atLeast(role, "manager");
}

export function canSeeCommission(role: AdminRole): boolean {
  return atLeast(role, "manager");
}

export function canManageOrgConfig(role: AdminRole): boolean {
  return role === "admin";
}

// Role-aware Prisma select for CommissionClaim rows.
// Editors never see commission amounts (totalNettPayout, items).
// NOTE: schema uses `agentPartyId` (not `agentId`) and `totalNettPayout`
// (not `nettPayout`). There is no `totalCommission` column on
// CommissionClaim — commission amounts live on CommissionClaimItem.
export function claimSelectFor(role: AdminRole) {
  const base = {
    id: true,
    claimNumber: true,
    status: true,
    submittedAt: true,
    createdAt: true,
    agentPartyId: true,
  } as const;
  if (canSeeCommission(role)) {
    return { ...base, totalNettPayout: true, items: true };
  }
  return base;
}

// Role-aware Prisma select for SalesClaim rows. Editors see metadata only —
// `commissionValue`, `computedAmount`, `splits` are stripped and surfaced as
// `null` at the repository boundary. Mirrors `renovationClaimSelectFor`
// (see W2b for the canonical pattern); SalesClaim has no documents.
export function salesClaimSelectFor(role: AdminRole) {
  const base = {
    id: true,
    organizationId: true,
    salesUnitId: true,
    commissionType: true,
    paymentType: true,
    status: true,
    notes: true,
    submittedAt: true,
    submittedById: true,
    reviewedAt: true,
    reviewedById: true,
    reviewerNote: true,
  } as const;
  if (canSeeCommission(role)) {
    return {
      ...base,
      commissionValue: true,
      computedAmount: true,
      splits: {
        select: {
          id: true,
          organizationId: true,
          claimId: true,
          partyPartyId: true,
          partyDisplayName: true,
          roleLabel: true,
          splitType: true,
          splitValue: true,
          sortOrder: true,
        },
        orderBy: { sortOrder: "asc" as const },
      },
    };
  }
  return base;
}

// Role-aware Prisma select for RenovationClaim rows. Editors see metadata
// only — `packagePrice`, `monthlyOffsetAmount`, `splits`, `documents` are
// stripped and surfaced as `null` arrays at the repository boundary.
export function renovationClaimSelectFor(role: AdminRole) {
  const base = {
    id: true,
    organizationId: true,
    salesUnitId: true,
    packageId: true,
    paymentType: true,
    status: true,
    notes: true,
    submittedAt: true,
    submittedById: true,
    reviewedAt: true,
    reviewedById: true,
    reviewerNote: true,
  } as const;
  if (canSeeCommission(role)) {
    return {
      ...base,
      packagePrice: true,
      monthlyOffsetAmount: true,
      splits: {
        select: {
          id: true,
          organizationId: true,
          claimId: true,
          partyPartyId: true,
          partyDisplayName: true,
          roleLabel: true,
          splitType: true,
          splitValue: true,
          isHouseKeep: true,
          sortOrder: true,
        },
        orderBy: { sortOrder: "asc" as const },
      },
      documents: {
        select: {
          id: true,
          organizationId: true,
          claimId: true,
          kind: true,
          fileKey: true,
          filename: true,
          uploadedAt: true,
          uploadedById: true,
        },
        orderBy: { uploadedAt: "asc" as const },
      },
    };
  }
  return base;
}
