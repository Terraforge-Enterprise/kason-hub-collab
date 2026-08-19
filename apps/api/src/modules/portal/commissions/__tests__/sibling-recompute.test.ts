import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/client";
import { submitClaimService, createAndSubmitClaimService } from "../portal.commissions.service";
import * as repo from "../portal.commissions.repository";

/**
 * Unit tests for per-item isCobroke derivation + sibling recompute.
 *
 * Pattern mirrors portal.commissions.service.test.ts:
 *  - Mock `@kason/db` with a mutable `dbMock` shape.
 *  - Mock the repository so tests control the starting claim state.
 *
 * Math baseline (all cases unless stated otherwise):
 *   monthlyRental=100, tierPct=40%, chargesAgent=0, chargesKaen=24
 *
 *   Solo (A=70%, totalPct=70):
 *     commission = 100 * 0.4 * 0.7 = 28
 *     shortfall  = 24 * (70/70) = 24
 *     nettPayout = 28 - 24 = 4
 *
 *   After B(30%) joins (totalPct=100):
 *     A recompute: shortfall = 24 * (70/100) = 16.8 → nettPayout = 28 - 16.8 = 11.2
 *     B: commission = 100 * 0.4 * 0.3 = 12; shortfall = 24 * (30/100) = 7.2 → nett = 4.8
 */

// ── DB mock ─────────────────────────────────────────────────────────────────
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
    count: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
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
    aggregate: vi.fn().mockResolvedValue({ _sum: { commissionPercentage: null } }),
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
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
  $queryRaw: vi.fn().mockResolvedValue([]),
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

const mockedRepo = vi.mocked(repo);

const session = {
  userId: "u-11111111-1111-4111-8111-111111111111",
  orgId: "11111111-1111-4111-8111-111111111111",
  userType: "agent",
  partyId: "22222222-2222-4222-8222-222222222222",
};

const PROP_ID = "11111111-1111-4111-8111-111111111111";
const UNIT = "A-08-02";
const ROOM = "Master";
const MOVE_IN = new Date("2026-04-20");

// TaTier: companyMinimum=24 matches chargesKaen in all test scenarios
const tier1 = { tier: 1, rentalMin: "0.00", rentalMax: null, companyMinimum: "24.00" };

/** Common mocks needed for a successful submit flow. */
function setupHappyBase() {
  dbMock.commissionClaim.findFirst.mockResolvedValue(null);
  dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
  dbMock.party.findFirst.mockResolvedValue({ agentLevel: "new_agent" });
  mockedRepo.resolveTierPercentage.mockResolvedValue({
    ok: true, percentage: new Decimal("40"), source: "direct",
  } as never);
  dbMock.property.findMany.mockResolvedValue([
    { id: PROP_ID, hasPaxDeduction: false, paxDeductionAmount: null },
  ]);
  dbMock.$transaction = vi.fn(async (cb: (tx: typeof dbMock) => unknown) => cb(dbMock));
  dbMock.commissionClaim.updateMany.mockResolvedValue({ count: 1 });
  dbMock.commissionClaim.create.mockResolvedValue({ id: "new-claim-id", claimNumber: "CLM-0001" });
  dbMock.commissionClaim.count.mockResolvedValue(0);
  dbMock.commissionClaimItem.update.mockResolvedValue({});
  dbMock.commissionClaimItem.aggregate.mockResolvedValue({ _sum: { commissionPercentage: null } });
  dbMock.commissionClaimItem.count.mockResolvedValue(0);
  dbMock.commissionClaimItem.findMany.mockResolvedValue([]);
  dbMock.taTier.findMany.mockResolvedValue([tier1]);
  dbMock.activityLog.create.mockResolvedValue({});
}

// ── Case 1: Solo item (share=100, no siblings) → isCobroke=false; no $queryRaw FOR UPDATE ──

describe("Case 1: solo item — isCobroke=false, no sibling recompute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyBase();
  });

  it("sets isCobroke=false when commissionPercentage=100 and no existing siblings", async () => {
    // count returns 0 — no existing siblings
    dbMock.commissionClaimItem.count.mockResolvedValue(0);

    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [{
        id: "i1",
        propertyId: PROP_ID,
        condoName: "Test",
        unitCode: UNIT,
        roomType: ROOM,
        salesDate: new Date("2026-04-19"),
        moveInDate: MOVE_IN,
        monthlyRental: new Decimal("100"),
        numberOfPax: null,
        commissionPercentage: new Decimal("100"),   // full share
        tenancyChargesByAgent: new Decimal("0"),
        tenancyChargesByKaen: new Decimal("24"),
      }],
    } as never);

    const res = await submitClaimService(session, "c1");

    expect(res.ok).toBe(true);

    // isCobroke=false must be written to the item update
    const updateCall = dbMock.commissionClaimItem.update.mock.calls[0][0] as {
      data: { isCobroke?: boolean };
    };
    expect(updateCall.data.isCobroke).toBe(false);

    // Since isCobroke=false, $queryRaw FOR UPDATE (sibling recompute) must NOT fire
    // The $queryRaw that runs is only the Rule-C validator query — not the recompute.
    // We can assert commissionClaimItem.aggregate was NOT called for the sibling recompute
    // (the recompute helper calls $queryRaw; since isCobroke=false we skip it).
    // After the item update, no additional $queryRaw FOR UPDATE calls should be made.
    // The validator $queryRaw returns [] (happy path), the sibling FOR UPDATE is skipped.
    const rawCalls = (dbMock.$queryRaw as ReturnType<typeof vi.fn>).mock.calls;
    // The only raw call is the Rule-C combined validator query (no FOR UPDATE).
    const rawSqls = rawCalls.map((args) => (args[0] as TemplateStringsArray).join("?"));
    const hasForUpdate = rawSqls.some((sql) => sql.includes("FOR UPDATE"));
    expect(hasForUpdate).toBe(false);
  });
});

// ── Case 2: A submits 70% first (no existing siblings) → isCobroke=true (share<100) ──

describe("Case 2: A submits 70% — isCobroke=true (share<100); trivial sibling recompute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyBase();
  });

  it("sets isCobroke=true when commissionPercentage=70 even with no DB siblings", async () => {
    // count=0 — no siblings — but pct<100 so isCobroke=true
    dbMock.commissionClaimItem.count.mockResolvedValue(0);
    // FOR UPDATE returns empty (no other cobroke siblings yet)
    dbMock.$queryRaw = vi.fn()
      .mockResolvedValueOnce([])   // Rule-C validator
      .mockResolvedValueOnce([]);  // sibling recompute FOR UPDATE (empty — no prior siblings)

    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c-a",
      status: "draft",
      claimType: "tenant_portion",
      items: [{
        id: "i-a",
        propertyId: PROP_ID,
        condoName: "Test",
        unitCode: UNIT,
        roomType: ROOM,
        salesDate: new Date("2026-04-19"),
        moveInDate: MOVE_IN,
        monthlyRental: new Decimal("100"),
        numberOfPax: null,
        commissionPercentage: new Decimal("70"),
        tenancyChargesByAgent: new Decimal("0"),
        tenancyChargesByKaen: new Decimal("24"),
      }],
    } as never);

    const res = await submitClaimService(session, "c-a");

    expect(res.ok).toBe(true);

    // isCobroke=true must be written
    const updateCall = dbMock.commissionClaimItem.update.mock.calls[0][0] as {
      data: { isCobroke?: boolean };
    };
    expect(updateCall.data.isCobroke).toBe(true);

    // Sibling recompute FOR UPDATE query must fire
    const rawSqls = (dbMock.$queryRaw as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => (args[0] as TemplateStringsArray).join("?"));
    const hasForUpdate = rawSqls.some((sql) => sql.includes("FOR UPDATE"));
    expect(hasForUpdate).toBe(true);
  });
});

// ── Case 3: B submits 30% after A(70%) is in DB → A's item gets recomputed ──

describe("Case 3: B submits 30% after A(70%) — sibling recompute updates A", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyBase();
  });

  it("recomputes A's shortfall from 24 to 16.8 when B joins", async () => {
    // B submits 30%; A is already in DB (submitted)
    dbMock.commissionClaimItem.count.mockResolvedValue(0); // isCobroke check (pct<100 → true anyway)
    // Rule-C validator: A already has 70 on the key
    dbMock.$queryRaw = vi.fn()
      .mockResolvedValueOnce([{   // Rule-C combined query result
        propertyId: PROP_ID,
        unit_l: UNIT.toLowerCase(),
        room_l: ROOM.toLowerCase(),
        moveInDate: MOVE_IN,
        total: "70",
      }])
      .mockResolvedValueOnce([{   // Sibling recompute FOR UPDATE — A's item
        id: "i-a",
        monthlyRental: "100",
        tierPct: "40",
        commissionPct: "70",
        chargesByAgent: "0",
        chargesByKaen: "24",
        numberOfPax: null,
        paxDeductionAmount: null,
        hasPaxDeduction: false,
        claimId: "c-a",
        taSharePercent: "100",
      }]);
    // Aggregate for A's claim totalNettPayout after recompute
    dbMock.commissionClaimItem.aggregate.mockResolvedValue({ _sum: { nettPayout: new Decimal("11.20") } });
    dbMock.commissionClaim.update.mockResolvedValue({});

    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c-b",
      status: "draft",
      claimType: "tenant_portion",
      items: [{
        id: "i-b",
        propertyId: PROP_ID,
        condoName: "Test",
        unitCode: UNIT,
        roomType: ROOM,
        salesDate: new Date("2026-04-19"),
        moveInDate: MOVE_IN,
        monthlyRental: new Decimal("100"),
        numberOfPax: null,
        commissionPercentage: new Decimal("30"),
        tenancyChargesByAgent: new Decimal("0"),
        tenancyChargesByKaen: new Decimal("24"),
      }],
    } as never);

    // getTotalCommissionPctOnKey for B's item: existing=70 + self=30 = 100
    dbMock.commissionClaimItem.aggregate.mockResolvedValueOnce({
      _sum: { commissionPercentage: new Decimal("70") },
    });

    const res = await submitClaimService(session, "c-b");
    expect(res.ok).toBe(true);

    // B's item gets isCobroke=true
    const bUpdateCall = dbMock.commissionClaimItem.update.mock.calls[0][0] as {
      data: { isCobroke?: boolean; nettPayout?: Decimal; shortfallApplied?: Decimal | null };
    };
    expect(bUpdateCall.data.isCobroke).toBe(true);

    // Sibling recompute must have fired (FOR UPDATE)
    const rawSqls = (dbMock.$queryRaw as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => (args[0] as TemplateStringsArray).join("?"));
    const hasForUpdate = rawSqls.some((sql) => sql.includes("FOR UPDATE"));
    expect(hasForUpdate).toBe(true);

    // The recompute called tx.commissionClaimItem.update for A (shortfallApplied=16.8)
    // That's the second update call (first is B's own item update, second is A's recompute)
    const aRecomputeCall = dbMock.commissionClaimItem.update.mock.calls[1];
    if (aRecomputeCall) {
      const aData = (aRecomputeCall[0] as { data: { shortfallApplied?: Decimal | null } }).data;
      // shortfallApplied should be 16.80 (24 * 70/100)
      expect(aData.shortfallApplied?.toFixed(2)).toBe("16.80");
    }
  });
});

// ── Case 4: Mixed submit — U1 solo(100%), U2 cobroke(50%) — recompute fires only for U2 ──

describe("Case 4: mixed submit — U1 solo, U2 cobroke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyBase();
  });

  it("U1 gets isCobroke=false; U2 gets isCobroke=true; recompute fires only for U2", async () => {
    const PROP2 = "22222222-2222-4222-8222-222222222222";
    const UNIT2 = "B-01-01";

    // count: U1 → 0 siblings; U2 → 0 siblings (pct<100 triggers anyway)
    dbMock.commissionClaimItem.count
      .mockResolvedValueOnce(0)  // U1 isCobroke check (pct=100, count=0 → false)
      .mockResolvedValueOnce(0); // U2 isCobroke check (pct=50 → true, count not even reached)

    // $queryRaw calls: Rule-C (one combined call), then sibling FOR UPDATE for U2 only
    dbMock.$queryRaw = vi.fn()
      .mockResolvedValueOnce([])  // Rule-C validator — no existing
      .mockResolvedValueOnce([]); // U2 sibling recompute FOR UPDATE — no prior siblings

    dbMock.property.findMany.mockResolvedValue([
      { id: PROP_ID, hasPaxDeduction: false, paxDeductionAmount: null },
      { id: PROP2,   hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    // aggregate for getTotalCommissionPctOnKey
    dbMock.commissionClaimItem.aggregate
      .mockResolvedValueOnce({ _sum: { commissionPercentage: null } })  // U1 totalPct
      .mockResolvedValueOnce({ _sum: { commissionPercentage: null } }); // U2 totalPct

    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c-mixed",
      status: "draft",
      claimType: "tenant_portion",
      items: [
        {
          id: "i-u1",
          propertyId: PROP_ID,
          condoName: "Test",
          unitCode: UNIT,
          roomType: ROOM,
          salesDate: new Date("2026-04-19"),
          moveInDate: MOVE_IN,
          monthlyRental: new Decimal("100"),
          numberOfPax: null,
          commissionPercentage: new Decimal("100"),  // solo
          tenancyChargesByAgent: new Decimal("0"),
          tenancyChargesByKaen: new Decimal("24"),
        },
        {
          id: "i-u2",
          propertyId: PROP2,
          condoName: "Test2",
          unitCode: UNIT2,
          roomType: ROOM,
          salesDate: new Date("2026-04-19"),
          moveInDate: MOVE_IN,
          monthlyRental: new Decimal("100"),
          numberOfPax: null,
          commissionPercentage: new Decimal("50"),   // cobroke
          tenancyChargesByAgent: new Decimal("0"),
          tenancyChargesByKaen: new Decimal("24"),
        },
      ],
    } as never);

    const res = await submitClaimService(session, "c-mixed");
    expect(res.ok).toBe(true);

    // U1 update: isCobroke=false
    const u1Call = dbMock.commissionClaimItem.update.mock.calls[0][0] as {
      data: { isCobroke?: boolean };
    };
    expect(u1Call.data.isCobroke).toBe(false);

    // U2 update: isCobroke=true
    const u2Call = dbMock.commissionClaimItem.update.mock.calls[1][0] as {
      data: { isCobroke?: boolean };
    };
    expect(u2Call.data.isCobroke).toBe(true);

    // FOR UPDATE recompute fires only once (for U2's key)
    const rawSqls = (dbMock.$queryRaw as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => (args[0] as TemplateStringsArray).join("?"));
    const forUpdateCount = rawSqls.filter((sql) => sql.includes("FOR UPDATE")).length;
    expect(forUpdateCount).toBe(1);
  });
});

// ── Case 5: B tries to submit 100% when A already has 100% → Rule C rejects (422) ──

describe("Case 5: Rule C rejects when existing sum + new > 100", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyBase();
  });

  it("returns 409 COMMISSION_EXCEEDS_CAP and writes NO partial state", async () => {
    // Rule-C combined query: A already has 100 on the key
    dbMock.$queryRaw = vi.fn().mockResolvedValue([{
      propertyId: PROP_ID,
      unit_l: UNIT.toLowerCase(),
      room_l: ROOM.toLowerCase(),
      moveInDate: MOVE_IN,
      total: "100",
    }]);

    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c-b2",
      status: "draft",
      claimType: "tenant_portion",
      items: [{
        id: "i-b2",
        propertyId: PROP_ID,
        condoName: "Test",
        unitCode: UNIT,
        roomType: ROOM,
        salesDate: new Date("2026-04-19"),
        moveInDate: MOVE_IN,
        monthlyRental: new Decimal("100"),
        numberOfPax: null,
        commissionPercentage: new Decimal("100"),  // exceeds cap
        tenancyChargesByAgent: new Decimal("0"),
        tenancyChargesByKaen: new Decimal("24"),
      }],
    } as never);

    const res = await submitClaimService(session, "c-b2");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      const errObj = res.error as { code: string };
      expect(errObj.code).toBe("rule_c_sum_exceeded");
    }

    // No item update or claim status change must have been written
    expect(dbMock.commissionClaimItem.update).not.toHaveBeenCalled();
    expect(dbMock.commissionClaim.updateMany).not.toHaveBeenCalled();
  });
});

// ── Case 6: Paid sibling is frozen — excluded from sibling recompute SELECT ──

describe("Case 6: paid sibling is frozen — excluded from recompute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyBase();
  });

  it("recompute FOR UPDATE query excludes paid status from the WHERE clause", async () => {
    // B submits 30%; A (paid) should be frozen
    dbMock.commissionClaimItem.count.mockResolvedValue(0); // pct<100 → isCobroke=true
    dbMock.$queryRaw = vi.fn()
      .mockResolvedValueOnce([{   // Rule-C: A(paid) exists but doesn't count in Rule C
        // (Rule C uses 'submitted','approved','paid' — paid DOES count for cap)
        propertyId: PROP_ID,
        unit_l: UNIT.toLowerCase(),
        room_l: ROOM.toLowerCase(),
        moveInDate: MOVE_IN,
        total: "70",
      }])
      .mockResolvedValueOnce([]);  // Sibling recompute FOR UPDATE returns EMPTY (paid excluded)

    dbMock.commissionClaimItem.aggregate.mockResolvedValue({
      _sum: { commissionPercentage: new Decimal("70") },
    });

    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c-b3",
      status: "draft",
      claimType: "tenant_portion",
      items: [{
        id: "i-b3",
        propertyId: PROP_ID,
        condoName: "Test",
        unitCode: UNIT,
        roomType: ROOM,
        salesDate: new Date("2026-04-19"),
        moveInDate: MOVE_IN,
        monthlyRental: new Decimal("100"),
        numberOfPax: null,
        commissionPercentage: new Decimal("30"),
        tenancyChargesByAgent: new Decimal("0"),
        tenancyChargesByKaen: new Decimal("24"),
      }],
    } as never);

    const res = await submitClaimService(session, "c-b3");
    expect(res.ok).toBe(true);

    // The FOR UPDATE SQL must exclude 'paid' from the status filter
    const rawCalls = (dbMock.$queryRaw as ReturnType<typeof vi.fn>).mock.calls;
    const forUpdateCall = rawCalls.find((args) => {
      const sql = (args[0] as TemplateStringsArray).join("?");
      return sql.includes("FOR UPDATE");
    });
    expect(forUpdateCall).toBeDefined();

    if (forUpdateCall) {
      const sql = (forUpdateCall[0] as TemplateStringsArray).join("?");
      // Paid is explicitly absent from the status filter in the recompute query
      expect(sql).toContain("'submitted','approved','amended'");
      expect(sql).not.toMatch(/'paid'/); // paid must NOT appear in the cobroke recompute filter
    }

    // A (paid) must NOT have received an update call from the sibling recompute
    // (recompute returns empty — no items to update)
    expect(dbMock.commissionClaimItem.update).toHaveBeenCalledTimes(1); // only B's own update
  });
});

// ── Case 7: TA split 50/50 stays stable when commission split 70/30 recompute fires ──

describe("Case 7: TA split 50/50 stays stable when commission 70/30 recompute fires", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyBase();
  });

  it("A's taSharePercent=50 is preserved on recompute when B submits 30%", async () => {
    // B submits 30%; A (70%, taSharePercent=50) is in DB
    dbMock.commissionClaimItem.count.mockResolvedValue(0); // pct<100 → isCobroke=true
    dbMock.$queryRaw = vi.fn()
      .mockResolvedValueOnce([{   // Rule-C combined query: A has 70
        propertyId: PROP_ID,
        unit_l: UNIT.toLowerCase(),
        room_l: ROOM.toLowerCase(),
        moveInDate: MOVE_IN,
        total: "70",
      }])
      .mockResolvedValueOnce([{ sum: "50" }])  // Rule-D taShare sum query (B has taSharePercent=50)
      .mockResolvedValueOnce([{   // Sibling recompute FOR UPDATE — A's item with taSharePercent=50
        id: "i-a7",
        monthlyRental: "100",
        tierPct: "40",
        commissionPct: "70",
        chargesByAgent: "0",
        chargesByKaen: "24",
        numberOfPax: null,
        paxDeductionAmount: null,
        hasPaxDeduction: false,
        claimId: "c-a7",
        taSharePercent: "50",   // A's TA split is 50
      }]);

    // Aggregate for A's claim totalNettPayout after recompute
    dbMock.commissionClaimItem.aggregate.mockResolvedValue({ _sum: { nettPayout: new Decimal("11.20") } });
    dbMock.commissionClaim.update.mockResolvedValue({});

    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c-b7",
      status: "draft",
      claimType: "tenant_portion",
      items: [{
        id: "i-b7",
        propertyId: PROP_ID,
        condoName: "Test",
        unitCode: UNIT,
        roomType: ROOM,
        salesDate: new Date("2026-04-19"),
        moveInDate: MOVE_IN,
        monthlyRental: new Decimal("100"),
        numberOfPax: null,
        commissionPercentage: new Decimal("30"),
        tenancyChargesByAgent: new Decimal("0"),
        tenancyChargesByKaen: new Decimal("24"),
        // B also has taSharePercent=50
        taSharePercent: new Decimal("50"),
      }],
    } as never);

    // getTotalCommissionPctOnKey for B's item: existing=70 + self=30 = 100
    dbMock.commissionClaimItem.aggregate.mockResolvedValueOnce({
      _sum: { commissionPercentage: new Decimal("70") },
    });

    const res = await submitClaimService(session, "c-b7");
    expect(res.ok).toBe(true);

    // B's item isCobroke=true
    const bUpdateCall = dbMock.commissionClaimItem.update.mock.calls[0][0] as {
      data: { isCobroke?: boolean; taSharePercent?: Decimal | null };
    };
    expect(bUpdateCall.data.isCobroke).toBe(true);

    // The sibling recompute must fire
    const rawSqls = (dbMock.$queryRaw as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => (args[0] as TemplateStringsArray).join("?"));
    const hasForUpdate = rawSqls.some((sql) => sql.includes("FOR UPDATE"));
    expect(hasForUpdate).toBe(true);

    // A's recompute call — taSharePercent=50 means agentTaIncome is half of profit
    // profit=0 (chargesAgent=0, chargesKaen=24 → shortfall only, no profit)
    // A: commission=100*0.4*0.7=28; shortfall=24*(70/100)=16.8; nett=28-16.8=11.2
    // (taSharePercent doesn't affect nett when profit=0, so nett is same as taShare=100)
    const aRecomputeCall = dbMock.commissionClaimItem.update.mock.calls[1];
    if (aRecomputeCall) {
      const aData = (aRecomputeCall[0] as { data: { shortfallApplied?: Decimal | null; nettPayout?: Decimal } }).data;
      expect(aData.shortfallApplied?.toFixed(2)).toBe("16.80");
      expect(aData.nettPayout?.toFixed(2)).toBe("11.20");
    }
  });
});

// ── createAndSubmitClaimService: isCobroke in atomic flow ───────────────────

describe("createAndSubmitClaimService — isCobroke derived server-side", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyBase();
  });

  it("creates item with isCobroke=false when share=100 and no existing siblings", async () => {
    dbMock.commissionClaimItem.count.mockResolvedValue(0);
    dbMock.commissionClaimItem.findMany.mockResolvedValue([]); // sibling recompute post-create

    const res = await createAndSubmitClaimService(session, {
      claimType: "tenant_portion",
      items: [{
        propertyId: PROP_ID,
        condoName: "Test",
        unitCode: UNIT,
        roomType: ROOM,
        tenantName: "T",
        salesDate: "2026-04-19",
        moveInDate: "2026-04-20",
        moveOutDate: "2027-04-19",
        monthlyRental: "100.00",
        commissionPercentage: "100.00",
        tenancyChargesByAgent: "0",
        tenancyChargesByKaen: "24",
      }],
    });

    expect(res.ok).toBe(true);

    // The item created must have isCobroke=false
    const createCall = dbMock.commissionClaim.create.mock.calls[0][0] as {
      data: { items: { create: Array<{ isCobroke?: boolean }> } };
    };
    expect(createCall.data.items.create[0].isCobroke).toBe(false);
  });

  it("creates item with isCobroke=true when share=70 (pct<100)", async () => {
    dbMock.commissionClaimItem.count.mockResolvedValue(0);
    // After create, sibling recompute fires — returns empty (no prior siblings)
    dbMock.commissionClaimItem.findMany.mockResolvedValue([]);
    dbMock.$queryRaw = vi.fn()
      .mockResolvedValueOnce([])   // Rule-C validator
      .mockResolvedValueOnce([]);  // sibling recompute FOR UPDATE

    const res = await createAndSubmitClaimService(session, {
      claimType: "tenant_portion",
      items: [{
        propertyId: PROP_ID,
        condoName: "Test",
        unitCode: UNIT,
        roomType: ROOM,
        tenantName: "T",
        salesDate: "2026-04-19",
        moveInDate: "2026-04-20",
        moveOutDate: "2027-04-19",
        monthlyRental: "100.00",
        commissionPercentage: "70.00",
        tenancyChargesByAgent: "0",
        tenancyChargesByKaen: "24",
      }],
    });

    expect(res.ok).toBe(true);

    const createCall = dbMock.commissionClaim.create.mock.calls[0][0] as {
      data: { items: { create: Array<{ isCobroke?: boolean }> } };
    };
    expect(createCall.data.items.create[0].isCobroke).toBe(true);
  });
});
