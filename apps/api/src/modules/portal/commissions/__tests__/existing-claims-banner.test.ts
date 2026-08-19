import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/client";

/**
 * Unit tests for `getExistingClaimsOnKey` and the GET /claims/existing-on-key
 * route. Pattern mirrors the existing portal.commissions.service.test.ts:
 *  - Mock `@kason/db` with a mutable `dbMock` shape.
 *  - Assert the 6-field anonymous aggregate response.
 *  - Assert no agent identifiers leak into the response.
 *  - Assert cross-org isolation.
 */

// ── DB mock ─────────────────────────────────────────────────────────────────
const dbMock: {
  commissionClaimItem: {
    aggregate: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
} = {
  commissionClaimItem: {
    aggregate: vi.fn(),
    count: vi.fn(),
  },
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
}));

import { getExistingClaimsOnKey } from "../existing-claims-on-key.service";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const KEY = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  unitCode: "A-08-02",
  roomType: "Master",
  moveInDate: new Date("2026-04-20"),
};

// ── Case 1: Response has no agent names / ids / claimIds ────────────────────
describe("response anonymity — no agent identifiers leak", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOT contain agentName, agentPartyId, or claimId in the response", async () => {
    // Seed: aggregate returns 70% from one claim (as if an agent named "Alice" submitted it)
    dbMock.commissionClaimItem.aggregate.mockResolvedValue({
      _sum: { commissionPercentage: new Decimal("70") },
      _count: { id: 1 },
    });
    dbMock.commissionClaimItem.count.mockResolvedValue(0);

    const result = await getExistingClaimsOnKey(dbMock, ORG_A, KEY);

    // Assert only the 6 allowed fields exist
    const keys = Object.keys(result);
    expect(keys).toEqual([
      "count",
      "totalAllocatedPct",
      "remainingPct",
      "hasCobrokePartner",
      "totalTaAllocatedPct",
      "remainingTaPct",
    ]);

    // Serialize to JSON and assert no agent-identifying strings appear
    const json = JSON.stringify(result);
    expect(json).not.toContain("agentName");
    expect(json).not.toContain("agentPartyId");
    expect(json).not.toContain("claimId");
    expect(json).not.toContain("Alice");
  });
});

// ── Case 2: Cross-org isolation ──────────────────────────────────────────────
describe("cross-org isolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("org-B session sees count=0 even when org-A has claims on the same key", async () => {
    // When called for org-B, the Prisma query includes organizationId: orgId filter.
    // We simulate this by having the mock return 0 for org-B's query.
    dbMock.commissionClaimItem.aggregate.mockImplementation(({ where }) => {
      if (where.organizationId === ORG_B) {
        return Promise.resolve({ _sum: { commissionPercentage: null }, _count: { id: 0 } });
      }
      // org-A would return 70%
      return Promise.resolve({
        _sum: { commissionPercentage: new Decimal("70") },
        _count: { id: 1 },
      });
    });
    dbMock.commissionClaimItem.count.mockImplementation(({ where }) => {
      if (where.organizationId === ORG_B) return Promise.resolve(0);
      return Promise.resolve(0);
    });

    const result = await getExistingClaimsOnKey(dbMock, ORG_B, KEY);

    expect(result.count).toBe(0);
    expect(result.totalAllocatedPct).toBe("0.00");
    expect(result.remainingPct).toBe("100.00");
    expect(result.hasCobrokePartner).toBe(false);

    // Verify the DB call was scoped to org-B's organizationId
    expect(dbMock.commissionClaimItem.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_B }),
      }),
    );
  });
});

// ── Case 3: Aggregates math ──────────────────────────────────────────────────
describe("aggregates math", () => {
  beforeEach(() => vi.clearAllMocks());

  it("2 claims totaling 70%+20% → count=2, totalAllocatedPct=90.00, remainingPct=10.00", async () => {
    dbMock.commissionClaimItem.aggregate.mockResolvedValue({
      _sum: { commissionPercentage: new Decimal("90") },
      _count: { id: 2 },
    });
    dbMock.commissionClaimItem.count.mockResolvedValue(0);

    const result = await getExistingClaimsOnKey(dbMock, ORG_A, KEY);

    expect(result.count).toBe(2);
    expect(result.totalAllocatedPct).toBe("90.00");
    expect(result.remainingPct).toBe("10.00");
    expect(result.hasCobrokePartner).toBe(false);
  });

  it("remainingPct floors at 0.00 when total > 100 (no negative remaining)", async () => {
    // Edge case: two claims already totaling 110% (data anomaly shouldn't produce negative)
    dbMock.commissionClaimItem.aggregate.mockResolvedValue({
      _sum: { commissionPercentage: new Decimal("110") },
      _count: { id: 2 },
    });
    dbMock.commissionClaimItem.count.mockResolvedValue(0);

    const result = await getExistingClaimsOnKey(dbMock, ORG_A, KEY);

    expect(result.totalAllocatedPct).toBe("110.00");
    expect(result.remainingPct).toBe("0.00");
  });

  it("returns count=0, total=0.00, remaining=100.00 when no claims exist", async () => {
    dbMock.commissionClaimItem.aggregate.mockResolvedValue({
      _sum: { commissionPercentage: null },
      _count: { id: 0 },
    });
    dbMock.commissionClaimItem.count.mockResolvedValue(0);

    const result = await getExistingClaimsOnKey(dbMock, ORG_A, KEY);

    expect(result.count).toBe(0);
    expect(result.totalAllocatedPct).toBe("0.00");
    expect(result.remainingPct).toBe("100.00");
  });
});

// ── Case 4: hasCobrokePartner ─────────────────────────────────────────────────
describe("hasCobrokePartner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hasCobrokePartner=true when at least one cobroke item exists on the key", async () => {
    dbMock.commissionClaimItem.aggregate.mockResolvedValue({
      _sum: { commissionPercentage: new Decimal("70") },
      _count: { id: 1 },
    });
    dbMock.commissionClaimItem.count.mockResolvedValue(1); // one cobroke item

    const result = await getExistingClaimsOnKey(dbMock, ORG_A, KEY);

    expect(result.hasCobrokePartner).toBe(true);
  });

  it("hasCobrokePartner=false when no cobroke items exist on the key", async () => {
    dbMock.commissionClaimItem.aggregate.mockResolvedValue({
      _sum: { commissionPercentage: new Decimal("100") },
      _count: { id: 1 },
    });
    dbMock.commissionClaimItem.count.mockResolvedValue(0); // no cobroke items

    const result = await getExistingClaimsOnKey(dbMock, ORG_A, KEY);

    expect(result.hasCobrokePartner).toBe(false);
  });

  it("cobroke count query is scoped to isCobroke=true and active statuses", async () => {
    dbMock.commissionClaimItem.aggregate.mockResolvedValue({
      _sum: { commissionPercentage: new Decimal("70") },
      _count: { id: 1 },
    });
    dbMock.commissionClaimItem.count.mockResolvedValue(0);

    await getExistingClaimsOnKey(dbMock, ORG_A, KEY);

    expect(dbMock.commissionClaimItem.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isCobroke: true,
          claim: { status: { in: ["submitted", "approved", "paid", "amended"] } },
        }),
      }),
    );
  });
});

// ── Case 5: TA share aggregation ─────────────────────────────────────────────
describe("TA share aggregation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("surfaces TA share aggregation separately from commission", async () => {
    // Two tenant_portion claims on same key:
    //   A: commissionPercentage=70, taSharePercent=50 (isCobroke=true)
    //   B: commissionPercentage=30, taSharePercent=50 (isCobroke=true)
    // First aggregate call → commission sum (70+30=100)
    // Second aggregate call → TA sum (50+50=100)
    dbMock.commissionClaimItem.aggregate
      .mockResolvedValueOnce({
        _sum: { commissionPercentage: new Decimal("100") },
        _count: { id: 2 },
      })
      .mockResolvedValueOnce({
        _sum: { taSharePercent: new Decimal("100") },
        _count: { id: 2 },
      });
    dbMock.commissionClaimItem.count.mockResolvedValue(2); // both are cobroke

    const result = await getExistingClaimsOnKey(dbMock, ORG_A, KEY);

    expect(result.totalAllocatedPct).toBe("100.00");
    expect(result.totalTaAllocatedPct).toBe("100.00");
    expect(result.remainingTaPct).toBe("0.00");
  });

  it("remainingTaPct floors at 0.00 when taTotal > 100", async () => {
    dbMock.commissionClaimItem.aggregate
      .mockResolvedValueOnce({
        _sum: { commissionPercentage: new Decimal("100") },
        _count: { id: 2 },
      })
      .mockResolvedValueOnce({
        _sum: { taSharePercent: new Decimal("110") },
        _count: { id: 2 },
      });
    dbMock.commissionClaimItem.count.mockResolvedValue(0);

    const result = await getExistingClaimsOnKey(dbMock, ORG_A, KEY);

    expect(result.totalTaAllocatedPct).toBe("110.00");
    expect(result.remainingTaPct).toBe("0.00");
  });

  it("returns totalTaAllocatedPct=0.00 and remainingTaPct=100.00 when no TA claims exist", async () => {
    dbMock.commissionClaimItem.aggregate
      .mockResolvedValueOnce({
        _sum: { commissionPercentage: null },
        _count: { id: 0 },
      })
      .mockResolvedValueOnce({
        _sum: { taSharePercent: null },
        _count: { id: 0 },
      });
    dbMock.commissionClaimItem.count.mockResolvedValue(0);

    const result = await getExistingClaimsOnKey(dbMock, ORG_A, KEY);

    expect(result.totalTaAllocatedPct).toBe("0.00");
    expect(result.remainingTaPct).toBe("100.00");
  });
});
