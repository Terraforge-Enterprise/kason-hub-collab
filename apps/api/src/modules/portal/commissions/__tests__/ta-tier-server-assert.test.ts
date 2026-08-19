import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/client";

/**
 * Unit tests for the server-side TaTier assertion that runs during submit
 * and createAndSubmit paths.
 *
 * Pattern follows portal.commissions.service.test.ts:
 *  - Mock `@kason/db` with a mutable `dbMock` shape.
 *  - Mock the repository so tests control the starting claim state.
 *  - Assert the assertion throws TA_TIER_MISMATCH (status 422) when
 *    chargesByKaen mismatches the tier companyMinimum.
 *  - Assert it passes when chargesByKaen matches.
 *  - Assert listing_portion claims bypass the assertion entirely.
 */

// ── DB mock ──────────────────────────────────────────────────────────────────
const dbMock: {
  commissionClaim: {
    count: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  commissionClaimItem: {
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  agentTierMapping: { findFirst: ReturnType<typeof vi.fn> };
  party: { findFirst: ReturnType<typeof vi.fn> };
  property: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  taTier: { findMany: ReturnType<typeof vi.fn> };
  activityLog: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
} = {
  commissionClaim: {
    count: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  commissionClaimItem: {
    update: vi.fn(),
    deleteMany: vi.fn(),
    aggregate: vi.fn(),
  },
  agentTierMapping: {
    findFirst: vi.fn(),
  },
  party: {
    findFirst: vi.fn(),
  },
  property: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  taTier: {
    findMany: vi.fn(),
  },
  activityLog: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
}));

vi.mock("../portal.commissions.repository", () => ({
  getAgentDashboardFull: vi.fn(),
  listAgentClaims: vi.fn(),
  findAgentClaim: vi.fn(),
  findTierMapping: vi.fn(),
  resolveTierPercentage: vi.fn(),
  searchProperties: vi.fn(),
  listActiveRoomTypes: vi.fn(),
  generateClaimNumberTx: vi.fn(
    async (
      tx: { commissionClaim: { count: (args: { where: Record<string, unknown> }) => Promise<number> } },
      orgId: string,
    ) => {
      const year = new Date().getFullYear();
      const count = await tx.commissionClaim.count({
        where: { organizationId: orgId, createdAt: { gte: new Date(`${year}-01-01T00:00:00Z`) } },
      });
      return `CLM-${year}-${String(count + 1).padStart(4, "0")}`;
    },
  ),
}));

import * as repo from "../portal.commissions.repository";
import { submitClaimService, createAndSubmitClaimService } from "../portal.commissions.service";

const mockedRepo = vi.mocked(repo);

const session = {
  userId: "u-11111111-1111-4111-8111-111111111111",
  orgId: "11111111-1111-4111-8111-111111111111",
  userType: "agent",
  partyId: "22222222-2222-4222-8222-222222222222",
};

// Tier 1: rentalMin=0, rentalMax=2000, companyMinimum=250
const tier1 = {
  tier: 1,
  rentalMin: "0.00",
  rentalMax: "2000.00",
  companyMinimum: "250.00",
};

// ── Common happy-path mocks ──────────────────────────────────────────────────

function setupHappyPathMocks() {
  dbMock.commissionClaim.findFirst.mockResolvedValue(null);
  dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
  dbMock.party.findFirst.mockResolvedValue({ agentLevel: "new_agent" });
  dbMock.agentTierMapping.findFirst.mockResolvedValue({ percentage: "40" });
  mockedRepo.resolveTierPercentage.mockResolvedValue({
    ok: true, percentage: new Decimal("40"), source: "direct",
  } as never);
  dbMock.property.findMany.mockResolvedValue([
    { id: "11111111-1111-4111-8111-111111111111", hasPaxDeduction: false, paxDeductionAmount: null },
  ]);
  dbMock.$transaction = vi.fn(async (cb: (tx: typeof dbMock) => unknown) => cb(dbMock));
  dbMock.commissionClaim.updateMany.mockResolvedValue({ count: 1 });
  dbMock.commissionClaimItem.update.mockResolvedValue({});
  // getTotalCommissionPctOnKey: no existing items for the key → existing sum = 0.
  dbMock.commissionClaimItem.aggregate.mockResolvedValue({ _sum: { commissionPercentage: null } });
  dbMock.commissionClaim.count.mockResolvedValue(0);
  dbMock.commissionClaim.create.mockResolvedValue({ id: "new-claim-id", claimNumber: "CLM-0001" });
  dbMock.activityLog.create.mockResolvedValue({});
}

// ── Case 1: submitClaimService — mismatch rejects with ta_tier_mismatch ──────

describe("submitClaimService — TaTier assertion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects submit when chargesByKaen mismatches TaTier companyMinimum (Tier1 min=250, given=216)", async () => {
    // Claim has monthlyRental=1500 → Tier1 (0..2000), companyMinimum=250
    // But chargesByKaen is 216 → mismatch
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [{
        id: "i1",
        propertyId: "11111111-1111-4111-8111-111111111111",
        condoName: "Test Condo",
        unitCode: "A-08-02",
        roomType: "Master",
        salesDate: new Date("2026-04-19"),
        moveInDate: new Date("2026-04-20"),
        monthlyRental: new Decimal("1500"),
        numberOfPax: null,
        commissionPercentage: new Decimal("70"),
        tenancyChargesByAgent: new Decimal("0"),
        tenancyChargesByKaen: new Decimal("216"),   // wrong — tier1 min is 250
      }],
    } as never);

    setupHappyPathMocks();
    // Seed Tier 1 with companyMinimum=250
    dbMock.taTier.findMany.mockResolvedValue([tier1]);

    const res = await submitClaimService(session, "c1");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(422);
      const errObj = res.error as { code: string; expected: string; given: string };
      expect(errObj.code).toBe("ta_tier_mismatch");
      expect(errObj.expected).toBe("250.00");
      expect(errObj.given).toBe("216.00");
    }
  });

  it("accepts submit when chargesByKaen matches TaTier companyMinimum", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c2",
      status: "draft",
      claimType: "tenant_portion",
      items: [{
        id: "i1",
        propertyId: "11111111-1111-4111-8111-111111111111",
        condoName: "Test Condo",
        unitCode: "A-08-02",
        roomType: "Master",
        salesDate: new Date("2026-04-19"),
        moveInDate: new Date("2026-04-20"),
        monthlyRental: new Decimal("1500"),
        numberOfPax: null,
        commissionPercentage: new Decimal("70"),
        tenancyChargesByAgent: new Decimal("0"),
        tenancyChargesByKaen: new Decimal("250"),   // matches tier1 companyMinimum
      }],
    } as never);

    setupHappyPathMocks();
    dbMock.taTier.findMany.mockResolvedValue([tier1]);

    const res = await submitClaimService(session, "c2");

    expect(res.ok).toBe(true);
  });

  it("bypasses TaTier assertion for listing_portion claims (TA = 0 accepted)", async () => {
    // Policy: listing_portion is "passive income" for the listing agent — the
    // tenant-side claim already pays the TA charges (charged-to-tenant + KAEN
    // fee). The listing agent earns only their 30% slice and should not be
    // forced to declare TA values on their own claim. Submitting with both
    // tenancyChargesByAgent=0 and tenancyChargesByKaen=0 must therefore pass,
    // even though the value diverges from the active tier companyMinimum.
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c3",
      status: "draft",
      claimType: "listing_portion",
      items: [{
        id: "i1",
        propertyId: "11111111-1111-4111-8111-111111111111",
        condoName: "Test Condo",
        unitCode: "A-08-02",
        roomType: "Master",
        salesDate: new Date("2026-04-19"),
        moveInDate: new Date("2026-04-20"),
        monthlyRental: new Decimal("1500"),
        numberOfPax: null,
        commissionPercentage: new Decimal("30"),
        tenancyChargesByAgent: new Decimal("0"),
        tenancyChargesByKaen: new Decimal("0"),  // intentionally 0 for listing_portion
      }],
    } as never);

    setupHappyPathMocks();
    dbMock.taTier.findMany.mockResolvedValue([tier1]);

    const res = await submitClaimService(session, "c3");

    expect(res.ok).toBe(true);
    expect(dbMock.taTier.findMany).not.toHaveBeenCalled();
  });
});

// ── Case 1b: createAndSubmitClaimService — mismatch rejects ──────────────────

describe("createAndSubmitClaimService — TaTier assertion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects when chargesByKaen mismatches TaTier (Tier1 min=250, given=216)", async () => {
    setupHappyPathMocks();
    dbMock.taTier.findMany.mockResolvedValue([tier1]);

    const res = await createAndSubmitClaimService(session, {
      claimType: "tenant_portion",
      items: [{
        propertyId: "11111111-1111-4111-8111-111111111111",
        condoName: "Test Condo",
        unitCode: "A-08-02",
        roomType: "Master",
        tenantName: "Tenant",
        salesDate: "2026-04-19",
        moveInDate: "2026-04-20",
        moveOutDate: "2027-04-19",
        monthlyRental: "1500.00",
        commissionPercentage: "70.00",
        tenancyChargesByAgent: "0",
        tenancyChargesByKaen: "216",   // wrong — tier1 min is 250
      }],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(422);
      const errObj = res.error as unknown as { code: string; expected: string; given: string };
      expect(errObj.code).toBe("ta_tier_mismatch");
      expect(errObj.expected).toBe("250.00");
      expect(errObj.given).toBe("216.00");
    }
  });

  it("accepts when chargesByKaen matches TaTier companyMinimum (250)", async () => {
    setupHappyPathMocks();
    dbMock.taTier.findMany.mockResolvedValue([tier1]);

    const res = await createAndSubmitClaimService(session, {
      claimType: "tenant_portion",
      items: [{
        propertyId: "11111111-1111-4111-8111-111111111111",
        condoName: "Test Condo",
        unitCode: "A-08-02",
        roomType: "Master",
        tenantName: "Tenant",
        salesDate: "2026-04-19",
        moveInDate: "2026-04-20",
        moveOutDate: "2027-04-19",
        monthlyRental: "1500.00",
        commissionPercentage: "70.00",
        tenancyChargesByAgent: "0",
        tenancyChargesByKaen: "250",   // matches tier1 companyMinimum
      }],
    });

    expect(res.ok).toBe(true);
  });
});
