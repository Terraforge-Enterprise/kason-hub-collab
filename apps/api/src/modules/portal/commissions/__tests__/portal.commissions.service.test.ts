import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/client";
import { submitClaimService, createAndSubmitClaimService, updateDraftService, saveDraftService, getClaimService } from "../portal.commissions.service";
import * as repo from "../portal.commissions.repository";

// ── DB mock ─────────────────────────────────────────────────────────────────
// Fully mutable shape so each test can set up exactly what the service needs.
const dbMock: {
  commissionClaim: {
    count: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
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
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  commissionClaimItem: {
    update: vi.fn(),
    deleteMany: vi.fn(),
    // Default: no existing items on the key → existing sum = 0.
    aggregate: vi.fn().mockResolvedValue({ _sum: { commissionPercentage: null } }),
    // Default: 0 active siblings → deriveIsCobroke falls through to pct<100 check.
    count: vi.fn().mockResolvedValue(0),
    // Default: no newly created items → amend cobroke re-derivation no-ops.
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
  // Delegates to tx.commissionClaim.count so the service's tx-scoped call hits dbMock.
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

// ── submitClaimService — Rule B (same-agent active-claim block) ─────────────

describe("submitClaimService — Rule B (same-agent active-claim block)", () => {
  beforeEach(() => vi.clearAllMocks());

  const claimItem = {
    id: "i1",
    propertyId: "11111111-1111-4111-8111-111111111111",
    condoName: "Seri Kembangan Heights",
    unitCode: "A-08-02",
    roomType: "Master",
    salesDate: new Date("2026-04-19"),
    moveInDate: new Date("2026-04-20"),
    monthlyRental: new Decimal(1000),
    numberOfPax: null,
    commissionPercentage: new Decimal(70),
    tenancyChargesByAgent: new Decimal(0),
    tenancyChargesByKaen: new Decimal(0),
  };

  it("returns 409 when the SAME agent has an existing active claim for this key", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [claimItem],
    } as never);

    // Rule B/C now run INSIDE the Serializable tx via the shared validator.
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.commissionClaim.findFirst.mockResolvedValue({
      id: "c-prior",
      claimNumber: "CLM-0042",
    });

    const res = await submitClaimService(session, "c1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      // Post-refactor: structured error object from ClaimError.
      const errObj = res.error as { code: string; message: string; priorClaimNumber?: string };
      expect(errObj.code).toBe("rule_b_same_agent_active");
      expect(errObj.message).toMatch(/CLM-0042/);
      expect(errObj.message).toMatch(/already have an active claim/i);
    }
    expect(dbMock.commissionClaim.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentPartyId: session.partyId,
          status: { in: ["submitted", "approved", "paid"] },
        }),
      }),
    );
  });

  it("allows submission when the same agent's only matching claim is REJECTED", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [claimItem],
    } as never);

    dbMock.commissionClaim.findFirst.mockResolvedValue(null);
    // Validator's Rule C combined query returns empty = no existing active claims.
    dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
    dbMock.party.findFirst.mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst.mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.commissionClaim.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    dbMock.commissionClaimItem.update = vi.fn().mockResolvedValue({});
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    dbMock.property.findUnique = vi.fn().mockResolvedValue({ hasPaxDeduction: false, paxDeductionAmount: null });
    // TaTier: claimItem uses tenancyChargesByKaen=0; return matching tier.
    dbMock.taTier.findMany = vi.fn().mockResolvedValue([
      { tier: 1, rentalMin: "0.00", rentalMax: null, companyMinimum: "0.00" },
    ]);

    const res = await submitClaimService(session, "c1");
    expect(res.ok).toBe(true);
  });

  it("passes Rule B when a DIFFERENT agent has an active claim (proceeds to Rule C)", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [{ ...claimItem, commissionPercentage: new Decimal(30) }],
    } as never);

    dbMock.commissionClaim.findFirst.mockResolvedValue(null);
    // Validator's Rule C returns a row per key; here existing sum 70 for the key.
    // Second call is the sibling recompute FOR UPDATE — returns empty (no prior cobroke items).
    dbMock.$queryRaw = vi.fn()
      .mockResolvedValueOnce([{
        propertyId: "11111111-1111-4111-8111-111111111111",
        unit_l: "a-08-02",
        room_l: "master",
        moveInDate: new Date("2026-04-20"),
        total: "70",
      }])
      .mockResolvedValueOnce([]); // sibling recompute FOR UPDATE — empty
    dbMock.party.findFirst.mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst.mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.commissionClaim.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    dbMock.commissionClaimItem.update = vi.fn().mockResolvedValue({});
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    dbMock.property.findUnique = vi.fn().mockResolvedValue({ hasPaxDeduction: false, paxDeductionAmount: null });
    // TaTier: claimItem uses tenancyChargesByKaen=0; return matching tier.
    dbMock.taTier.findMany = vi.fn().mockResolvedValue([
      { tier: 1, rentalMin: "0.00", rentalMax: null, companyMinimum: "0.00" },
    ]);

    const res = await submitClaimService(session, "c1");
    expect(res.ok).toBe(true);
  });
});

// ── submitClaimService — Rule C (sum cap ≤ 100%) ────────────────────────────

describe("submitClaimService — Rule C (sum cap ≤ 100%)", () => {
  beforeEach(() => vi.clearAllMocks());

  const item70 = {
    id: "i1",
    propertyId: "11111111-1111-4111-8111-111111111111",
    condoName: "Seri Kembangan Heights",
    unitCode: "A-08-02",
    roomType: "Master",
    salesDate: new Date("2026-04-19"),
    moveInDate: new Date("2026-04-20"),
    monthlyRental: new Decimal(1000),
    numberOfPax: null,
    commissionPercentage: new Decimal(70),
    tenancyChargesByAgent: new Decimal(0),
    tenancyChargesByKaen: new Decimal(0),
  };

  const happyPathMocks = () => {
    dbMock.commissionClaim.findFirst.mockResolvedValue(null);
    dbMock.party.findFirst.mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst.mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.commissionClaim.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    dbMock.commissionClaimItem.update = vi.fn().mockResolvedValue({});
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    dbMock.property.findUnique = vi.fn().mockResolvedValue({ hasPaxDeduction: false, paxDeductionAmount: null });
    // TaTier: items in this suite use tenancyChargesByKaen=0; return a tier where companyMinimum matches.
    dbMock.taTier.findMany = vi.fn().mockResolvedValue([
      { tier: 1, rentalMin: "0.00", rentalMax: null, companyMinimum: "0.00" },
    ]);
  };

  // Shared Rule-C-existing-row shape (validator's combined query returns rows
  // keyed by (propertyId, unit_l, room_l, moveInDate), not {sum} scalars).
  const existingRow70 = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    unit_l: "a-08-02",
    room_l: "master",
    moveInDate: new Date("2026-04-20"),
    total: "70",
  };

  it("accepts when existing_sum + new_sum = 100 exactly", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [{ ...item70, commissionPercentage: new Decimal(30) }],
    } as never);
    // First call: Rule-C combined query. Second call: sibling recompute FOR UPDATE (empty).
    dbMock.$queryRaw = vi.fn()
      .mockResolvedValueOnce([existingRow70])
      .mockResolvedValueOnce([]);
    happyPathMocks();

    const res = await submitClaimService(session, "c1");
    expect(res.ok).toBe(true);
  });

  it("rejects with 409 when existing_sum + new_sum > 100 and reports the available max", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [{ ...item70, commissionPercentage: new Decimal(31) }],
    } as never);
    dbMock.$queryRaw = vi.fn().mockResolvedValue([existingRow70]);
    dbMock.commissionClaim.findFirst.mockResolvedValue(null);
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));

    const res = await submitClaimService(session, "c1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      const errObj = res.error as { code: string; message: string; availableMax?: string };
      expect(errObj.code).toBe("rule_c_sum_exceeded");
      expect(errObj.message).toMatch(/exceed 100/i);
      // Post-refactor: validator scrubs "other agents' totals"; surfaces availableMax instead.
      expect(errObj.availableMax).toBe("30.00");
    }
  });

  it("excludes rejected and draft from existing_sum ($queryRaw must filter on active status and exclude current claim)", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [{ ...item70, commissionPercentage: new Decimal(100) }],
    } as never);
    dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
    dbMock.commissionClaim.findFirst.mockResolvedValue(null);
    happyPathMocks();

    const res = await submitClaimService(session, "c1");
    expect(res.ok).toBe(true);
    // $queryRaw tagged-template call: first arg is TemplateStringsArray of the
    // SQL fragments. Assert the static SQL includes the active-status filter
    // and the current-claim exclusion.
    const sqlTemplate = dbMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray;
    const sql = sqlTemplate.join("?");
    expect(sql).toContain("status IN ('submitted', 'approved', 'paid', 'amended')");
    expect(sql).toContain("c.id <>");
    // And the current claimId was bound as one of the template params.
    const params = dbMock.$queryRaw.mock.calls[0].slice(1);
    expect(params).toContain("c1");
  });

  it("groups intra-payload items by key case-insensitively when computing per-key sums", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [
        { ...item70, id: "i1", unitCode: "A-08-02", commissionPercentage: new Decimal(50) },
        {
          ...item70,
          id: "i2",
          unitCode: "A-08-02",
          moveInDate: new Date("2026-05-01"),
          commissionPercentage: new Decimal(50),
        },
      ],
    } as never);
    dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
    dbMock.commissionClaim.findFirst.mockResolvedValue(null);
    happyPathMocks();

    const res = await submitClaimService(session, "c1");
    expect(res.ok).toBe(true);
    // Post-refactor: the validator issues ONE combined query for all distinct
    // keys (via jsonb_array_elements), not one per key.
    // The two items both have pct=50 (isCobroke=true) so each item's sibling
    // recompute issues one additional FOR UPDATE query (2 more calls).
    const calls = (dbMock.$queryRaw as ReturnType<typeof vi.fn>).mock.calls;
    const validatorCalls = calls.filter((args) => {
      const sql = (args[0] as TemplateStringsArray).join("?");
      return !sql.includes("FOR UPDATE");
    });
    expect(validatorCalls).toHaveLength(1);
  });

  it("rejects duplicate-key items via Rule A (post-refactor: intra-payload dedupe runs before Rule C)", async () => {
    // Pre-refactor this test exercised Rule C's intra-payload sum defense.
    // Post-refactor: validateAll runs Rule A first, and duplicate keys short-circuit
    // as rule_a_duplicate before Rule C ever sees them. The 409 still surfaces —
    // just with a different error code — which is the correct, more specific answer.
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [
        { ...item70, id: "i1", commissionPercentage: new Decimal(60) },
        { ...item70, id: "i2", commissionPercentage: new Decimal(50) }, // same key, duplicate
      ],
    } as never);
    dbMock.commissionClaim.findFirst.mockResolvedValue(null);
    dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));

    const res = await submitClaimService(session, "c1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      const errObj = res.error as { code: string };
      expect(errObj.code).toBe("rule_a_duplicate");
    }
  });
});

// ── createAndSubmitClaimService (atomic Serializable) ───────────────────────

describe("createAndSubmitClaimService (atomic Serializable)", () => {
  beforeEach(() => vi.clearAllMocks());

  const baseInput = {
    claimType: "tenant_portion",
    items: [{
      propertyId: "11111111-1111-4111-8111-111111111111",
      condoName: "Seri Kembangan Heights",
      unitCode: "A-08-02",
      roomType: "Master",
      tenantName: "T",
      salesDate: "2026-04-19",
      moveInDate: "2026-04-20",
      moveOutDate: "2027-04-19",
      monthlyRental: "1000.00",
      commissionPercentage: "70.00",
      tenancyChargesByAgent: "0",
      tenancyChargesByKaen: "216",
    }],
  };

  it("on validation failure, throws ClaimError and does NOT call create", async () => {
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    // Rule B returns a prior active claim → validator fails
    dbMock.commissionClaim.findFirst = vi.fn().mockResolvedValue({ id: "c-prior", claimNumber: "CLM-0042" });
    dbMock.commissionClaim.create = vi.fn();

    const res = await createAndSubmitClaimService(session, baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.error.code).toBe("rule_b_same_agent_active");
    }
    expect(dbMock.commissionClaim.create).not.toHaveBeenCalled();
  });

  it("on validation success, creates claim with status=submitted and writes audit log", async () => {
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.commissionClaim.findFirst = vi.fn().mockResolvedValue(null);
    dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    // TaTier: baseInput uses tenancyChargesByKaen="216"; return matching tier.
    dbMock.taTier.findMany = vi.fn().mockResolvedValue([
      { tier: 1, rentalMin: "0.00", rentalMax: null, companyMinimum: "216.00" },
    ]);
    dbMock.commissionClaim.create = vi.fn().mockResolvedValue({ id: "new-claim-id", claimNumber: "CLM-0099" });
    dbMock.commissionClaim.count = vi.fn().mockResolvedValue(42); // for generateClaimNumber
    dbMock.activityLog = { create: vi.fn().mockResolvedValue({}) };

    const res = await createAndSubmitClaimService(session, baseInput);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(201);
      expect(res.data.id).toBe("new-claim-id");
    }
    expect(dbMock.commissionClaim.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "submitted" }),
      }),
    );
    expect(dbMock.activityLog.create).toHaveBeenCalled();
  });

  it("uses Serializable isolation level for the transaction", async () => {
    const txSpy = vi.fn(async (cb, _opts) => cb(dbMock));
    dbMock.$transaction = txSpy;
    dbMock.commissionClaim.findFirst = vi.fn().mockResolvedValue(null);
    dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    // TaTier: baseInput uses tenancyChargesByKaen="216"; return matching tier.
    dbMock.taTier.findMany = vi.fn().mockResolvedValue([
      { tier: 1, rentalMin: "0.00", rentalMax: null, companyMinimum: "216.00" },
    ]);
    dbMock.commissionClaim.create = vi.fn().mockResolvedValue({ id: "x", claimNumber: "CLM-x" });
    dbMock.commissionClaim.count = vi.fn().mockResolvedValue(0);
    dbMock.activityLog = { create: vi.fn().mockResolvedValue({}) };

    await createAndSubmitClaimService(session, baseInput);

    const opts = txSpy.mock.calls[0][1];
    expect(opts?.isolationLevel).toBe("Serializable");
  });

  it("retries once on Prisma P2034 (serialization failure) then surfaces", async () => {
    let attempt = 0;
    const p2034 = Object.assign(new Error("serialization failure"), { code: "P2034" });
    dbMock.$transaction = vi.fn(async (cb) => {
      attempt++;
      if (attempt === 1) throw p2034;
      return cb(dbMock);
    });
    dbMock.commissionClaim.findFirst = vi.fn().mockResolvedValue(null);
    dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    // TaTier: baseInput uses tenancyChargesByKaen="216"; return matching tier.
    dbMock.taTier.findMany = vi.fn().mockResolvedValue([
      { tier: 1, rentalMin: "0.00", rentalMax: null, companyMinimum: "216.00" },
    ]);
    dbMock.commissionClaim.create = vi.fn().mockResolvedValue({ id: "y", claimNumber: "CLM-y" });
    dbMock.commissionClaim.count = vi.fn().mockResolvedValue(0);
    dbMock.activityLog = { create: vi.fn().mockResolvedValue({}) };

    const res = await createAndSubmitClaimService(session, baseInput);
    expect(attempt).toBe(2);
    expect(res.ok).toBe(true);
  });

  it("does NOT retry on non-P2034 / non-claimNumber-P2002 errors; surfaces on first attempt", async () => {
    let attempt = 0;
    // Generic Error with no `code` property — guaranteed non-retryable.
    dbMock.$transaction = vi.fn(async (_cb) => {
      attempt++;
      throw new Error("boom");
    });

    const res = await createAndSubmitClaimService(session, baseInput);
    expect(attempt).toBe(1);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(500);
      expect(res.error.code).toBe("internal");
    }
  });

  it("retries once on Prisma P2002 targeting claimNumber (concurrent tx race on COUNT+1)", async () => {
    let attempt = 0;
    const p2002 = Object.assign(new Error("unique violation"), {
      code: "P2002",
      meta: { target: ["organizationId", "claimNumber"] },
    });
    dbMock.$transaction = vi.fn(async (cb) => {
      attempt++;
      if (attempt === 1) throw p2002;
      return cb(dbMock);
    });
    dbMock.commissionClaim.findFirst = vi.fn().mockResolvedValue(null);
    dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    // TaTier: baseInput uses tenancyChargesByKaen="216"; return matching tier.
    dbMock.taTier.findMany = vi.fn().mockResolvedValue([
      { tier: 1, rentalMin: "0.00", rentalMax: null, companyMinimum: "216.00" },
    ]);
    dbMock.commissionClaim.create = vi.fn().mockResolvedValue({ id: "z", claimNumber: "CLM-z" });
    dbMock.commissionClaim.count = vi.fn().mockResolvedValue(0);
    dbMock.activityLog = { create: vi.fn().mockResolvedValue({}) };

    const res = await createAndSubmitClaimService(session, baseInput);
    expect(attempt).toBe(2);
    expect(res.ok).toBe(true);
  });

  it("does NOT retry on P2002 targeting a different unique constraint", async () => {
    let attempt = 0;
    const p2002Other = Object.assign(new Error("unique violation"), {
      code: "P2002",
      meta: { target: ["someOtherUnique"] },
    });
    dbMock.$transaction = vi.fn(async (_cb) => {
      attempt++;
      throw p2002Other;
    });

    const res = await createAndSubmitClaimService(session, baseInput);
    expect(attempt).toBe(1);
    expect(res.ok).toBe(false);
  });

  // Regression: tenant_listing_portion has no row in AgentTierMapping by
  // design — its percentage is the sum of tenant_portion + listing_portion.
  // Earlier, the submit paths did a single findFirst and threw "Tier mapping
  // not configured" for this composite type. resolveTierPercentage now handles
  // the derivation in both the preview and submit paths.
  describe("tenant_listing_portion derivation (regression)", () => {
    const combinedInput = { ...baseInput, claimType: "tenant_listing_portion" as const };

    it("submits successfully using the derived (tenant + listing) percentage", async () => {
      dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
      dbMock.commissionClaim.findFirst = vi.fn().mockResolvedValue(null);
      dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
      dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
      mockedRepo.resolveTierPercentage.mockResolvedValue({
        ok: true, percentage: new Decimal("70"), source: "derived",
      } as never);
      dbMock.property.findMany = vi.fn().mockResolvedValue([
        { id: "11111111-1111-4111-8111-111111111111", hasPaxDeduction: false, paxDeductionAmount: null },
      ]);
      // TaTier: combinedInput (tenant_listing_portion) has tenancyChargesByKaen="216"; return matching tier.
      dbMock.taTier.findMany = vi.fn().mockResolvedValue([
        { tier: 1, rentalMin: "0.00", rentalMax: null, companyMinimum: "216.00" },
      ]);
      dbMock.commissionClaim.create = vi.fn().mockResolvedValue({ id: "new", claimNumber: "CLM-0100" });
      dbMock.commissionClaim.count = vi.fn().mockResolvedValue(0);
      dbMock.activityLog = { create: vi.fn().mockResolvedValue({}) };

      const res = await createAndSubmitClaimService(session, combinedInput);

      expect(res.ok).toBe(true);
      // Items were computed with the summed 70% tier (not 0, not a single 40%).
      const createArgs = dbMock.commissionClaim.create.mock.calls[0][0] as {
        data: { items: { create: Array<{ agentTierPercentage: Decimal }> } };
      };
      expect(createArgs.data.items.create[0].agentTierPercentage.toString()).toBe("70");
    });

    it("surfaces the resolver error when listing_portion mapping is missing", async () => {
      dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
      dbMock.commissionClaim.findFirst = vi.fn().mockResolvedValue(null);
      dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
      dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
      mockedRepo.resolveTierPercentage.mockResolvedValue({
        ok: false, error: "Listing Portion tier mapping is missing or inactive for new_agent.",
      } as never);
      dbMock.commissionClaim.create = vi.fn();

      const res = await createAndSubmitClaimService(session, combinedInput);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toMatch(/Listing Portion/);
      expect(dbMock.commissionClaim.create).not.toHaveBeenCalled();
    });
  });
});

// ── updateDraftService (PATCH /claims/:id) ──────────────────────────────────

describe("updateDraftService (PATCH /claims/:id)", () => {
  beforeEach(() => vi.clearAllMocks());

  const baseItem = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    condoName: "c",
    unitCode: "A",
    roomType: "M",
    tenantName: "T",
    salesDate: "2026-04-19",
    moveInDate: "2026-04-20",
      moveOutDate: "2027-04-19",
    monthlyRental: "1000",
    commissionPercentage: "50",
    tenancyChargesByAgent: "0",
    tenancyChargesByKaen: "216",
  };

  it("returns 403 forbidden_transition when claim is in approved state (post-approval edits must use amend flow)", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "approved",
      claimType: "tenant_portion",
      items: [],
    } as never);

    const res = await updateDraftService(session, "c1", {
      claimType: "tenant_portion",
      items: [],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.error.code).toBe("forbidden_transition");
    }
  });

  it("allows edit when claim is in submitted state (pre-approval edit, status preserved)", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "submitted",
      claimType: "tenant_portion",
      items: [],
    } as never);
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.commissionClaimItem.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", name: "Test Condo", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    dbMock.commissionClaim.update = vi.fn().mockResolvedValue({ id: "c1" });
    dbMock.activityLog = { create: vi.fn().mockResolvedValue({}) };

    const res = await updateDraftService(session, "c1", {
      claimType: "tenant_portion",
      items: [baseItem],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe(200);
    // Status is preserved: update call must NOT set status field
    expect(dbMock.commissionClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "c1" },
        data: expect.not.objectContaining({ status: expect.anything() }),
      }),
    );
  });

  it("returns 404 when claim is not found (or belongs to a different agent)", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue(null as never);

    const res = await updateDraftService(session, "c-missing", {
      claimType: "tenant_portion",
      items: [baseItem],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(404);
      expect(res.error.code).toBe("not_found");
    }
  });

  it("runs Rule A on the updated payload before writing (duplicate intra-payload blocks the update)", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [],
    } as never);
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));

    const res = await updateDraftService(session, "c1", {
      claimType: "tenant_portion",
      items: [baseItem, { ...baseItem }], // duplicate intra-payload
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("rule_a_duplicate");
    }
  });

  it("on success, replaces items (deleteMany + create) and returns 200", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [],
    } as never);
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.commissionClaimItem.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", name: "Test Condo", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    dbMock.commissionClaim.update = vi.fn().mockResolvedValue({ id: "c1" });
    dbMock.activityLog = { create: vi.fn().mockResolvedValue({}) };

    const res = await updateDraftService(session, "c1", {
      claimType: "tenant_portion",
      items: [baseItem],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe(200);
    expect(dbMock.commissionClaimItem.deleteMany).toHaveBeenCalledWith({ where: { claimId: "c1" } });
    expect(dbMock.commissionClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "c1" },
        data: expect.objectContaining({ claimType: "tenant_portion" }),
      }),
    );
  });

  it("org-scope enforced: rejects propertyId not in agent's org", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [],
    } as never);
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.commissionClaimItem.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    // Property lookup returns EMPTY — propertyId doesn't belong to agent's org.
    dbMock.property.findMany = vi.fn().mockResolvedValue([]);

    const res = await updateDraftService(session, "c1", {
      claimType: "tenant_portion",
      items: [{ propertyId: "99999999-9999-4999-8999-999999999999" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.error.code).toBe("validation");
    }
  });

  it("accepts a partial payload (draft edit leaves other fields empty)", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items: [],
    } as never);
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.commissionClaimItem.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", name: "Test Condo", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    dbMock.commissionClaim.update = vi.fn().mockResolvedValue({ id: "c1" });
    dbMock.activityLog = { create: vi.fn().mockResolvedValue({}) };

    const res = await updateDraftService(session, "c1", {
      claimType: "tenant_portion",
      items: [{ propertyId: "11111111-1111-4111-8111-111111111111" }], // ONLY propertyId
    });
    expect(res.ok).toBe(true);
  });
});

// ── saveDraftService (POST /claims) ─────────────────────────────────────────

describe("saveDraftService (permissive POST /claims)", () => {
  beforeEach(() => vi.clearAllMocks());

  const validPropertyId = "11111111-1111-4111-8111-111111111111";

  it("saves a claim with only propertyId filled; other fields get safe defaults", async () => {
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: validPropertyId, name: "Test Condo", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    dbMock.commissionClaim.create = vi.fn().mockResolvedValue({ id: "draft-id", claimNumber: "CLM-2026-0050" });
    dbMock.commissionClaim.count = vi.fn().mockResolvedValue(49);
    dbMock.activityLog.create = vi.fn().mockResolvedValue({});

    const res = await saveDraftService(session, {
      claimType: "tenant_portion",
      items: [{ propertyId: validPropertyId }],
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(201);
      expect(res.data.id).toBe("draft-id");
    }
    expect(dbMock.commissionClaim.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "draft" }),
      }),
    );
  });

  it("does NOT run Rule B or Rule C (sum cap is submit-only)", async () => {
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: validPropertyId, name: "T", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    dbMock.commissionClaim.findFirst = vi.fn(); // must NOT be called
    dbMock.$queryRaw = vi.fn();                  // must NOT be called
    dbMock.commissionClaim.create = vi.fn().mockResolvedValue({ id: "d", claimNumber: "CLM-d" });
    dbMock.commissionClaim.count = vi.fn().mockResolvedValue(0);
    dbMock.activityLog.create = vi.fn().mockResolvedValue({});

    await saveDraftService(session, {
      claimType: "tenant_portion",
      items: [{
        propertyId: validPropertyId,
        unitCode: "A-08-02",
        roomType: "Master",
        moveInDate: "2026-04-20",
      moveOutDate: "2027-04-19",
        commissionPercentage: "999", // absurd; sum cap would reject at submit
      }],
    });

    expect(dbMock.commissionClaim.findFirst).not.toHaveBeenCalled();
    expect(dbMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("still enforces intra-payload Rule A (duplicate keys within one submission)", async () => {
    const dup = {
      propertyId: validPropertyId,
      unitCode: "A",
      roomType: "M",
      moveInDate: "2026-04-20",
      moveOutDate: "2027-04-19",
    };
    const res = await saveDraftService(session, {
      claimType: "tenant_portion",
      items: [dup, { ...dup }],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.error.code).toBe("rule_a_duplicate");
    }
  });

  it("org-scope enforced: rejects propertyId not in agent's org", async () => {
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([]); // foreign propertyId → empty result

    const res = await saveDraftService(session, {
      claimType: "tenant_portion",
      items: [{ propertyId: "99999999-9999-4999-8999-999999999999" }],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.error.code).toBe("validation");
    }
  });
});

// ── createClaimService — persists remark ────────────────────────────────────

describe("createClaimService — persists remark", () => {
  beforeEach(() => vi.clearAllMocks());

  const validPropertyId = "11111111-1111-4111-8111-111111111111";

  it("writes the remark to each claim item", async () => {
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: validPropertyId, name: "Test Condo", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    dbMock.commissionClaim.create = vi.fn().mockResolvedValue({ id: "draft-remark", claimNumber: "CLM-2026-0099" });
    dbMock.commissionClaim.count = vi.fn().mockResolvedValue(10);
    dbMock.activityLog.create = vi.fn().mockResolvedValue({});

    const res = await saveDraftService(session, {
      claimType: "tenant_portion",
      items: [{
        propertyId: validPropertyId,
        unitCode: "B-01-01",
        roomType: "Master",
        tenantName: "Jane Doe",
        salesDate: "2026-04-19",
        moveInDate: "2026-05-01",
        moveOutDate: "2027-04-30",
        monthlyRental: "1200",
        commissionPercentage: "50",
        tenancyChargesByAgent: "0",
        tenancyChargesByKaen: "0",
        remark: "tenant moved in early",
      }],
    });

    expect(res.ok).toBe(true);

    // The remark must appear in the items.create array passed to commissionClaim.create
    expect(dbMock.commissionClaim.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: expect.objectContaining({
            create: expect.arrayContaining([
              expect.objectContaining({ remark: "tenant moved in early" }),
            ]),
          }),
        }),
      }),
    );
  });
});

describe("searchPropertiesService — no longer embeds roomTypes", () => {
  it("property payload omits roomTypes", async () => {
    mockedRepo.searchProperties.mockResolvedValueOnce([
      { id: "p1", name: "X", hasPaxDeduction: false, paxDeductionAmount: null, units: [] },
    ] as never);

    const { searchPropertiesService } = await import("../portal.commissions.service");
    const data = await searchPropertiesService({ orgId: "o1", partyId: "a1", userId: "u1", userType: "agent" } as never);
    expect(data[0]).not.toHaveProperty("roomTypes");
  });
});

describe("listRoomTypesService (new)", () => {
  it("returns active room types ordered by sortOrder", async () => {
    mockedRepo.listActiveRoomTypes.mockResolvedValueOnce([
      { id: "r1", name: "Whole Unit", sortOrder: 1 },
      { id: "r2", name: "Master",     sortOrder: 2 },
    ] as never);

    const { listRoomTypesService } = await import("../portal.commissions.service");
    const data = await listRoomTypesService({ orgId: "o1", partyId: "a1", userId: "u1", userType: "agent" } as never);
    expect(data).toEqual([
      { id: "r1", name: "Whole Unit", sortOrder: 1 },
      { id: "r2", name: "Master",     sortOrder: 2 },
    ]);
    expect(mockedRepo.listActiveRoomTypes).toHaveBeenCalledWith("o1");
  });
});

// ── submitClaimService — N+1 regression ────────────────────────────────────
// Property lookups must be batched via a single findMany, not N per-item
// findUnique calls. Batching reduces Serializable read-lock footprint and
// lowers P2034 retries under concurrent submits.
describe("submitClaimService — property lookup batching (no N+1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls property.findMany once for N items, never property.findUnique", async () => {
    const baseItem = {
      propertyId: "11111111-1111-4111-8111-111111111111",
      condoName: "Seri Kembangan Heights",
      unitCode: "A-08-02",
      roomType: "Master",
      salesDate: new Date("2026-04-19"),
      moveInDate: new Date("2026-04-20"),
      monthlyRental: new Decimal(1000),
      numberOfPax: null,
      commissionPercentage: new Decimal(10),
      tenancyChargesByAgent: new Decimal(0),
      tenancyChargesByKaen: new Decimal(0),
    };
    const items = [
      { ...baseItem, id: "i1", propertyId: "p-aaaa" },
      { ...baseItem, id: "i2", propertyId: "p-bbbb", unitCode: "B-01-01" },
      { ...baseItem, id: "i3", propertyId: "p-cccc", unitCode: "C-03-03" },
      // Duplicate propertyId — dedupe should mean 3 distinct IDs, not 4.
      { ...baseItem, id: "i4", propertyId: "p-aaaa", unitCode: "A-09-09" },
    ];

    mockedRepo.findAgentClaim.mockResolvedValue({
      id: "c1",
      status: "draft",
      claimType: "tenant_portion",
      items,
    } as never);
    dbMock.commissionClaim.findFirst.mockResolvedValue(null);
    dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
    dbMock.party.findFirst.mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst.mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.commissionClaim.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    dbMock.commissionClaimItem.update = vi.fn().mockResolvedValue({});
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "p-aaaa", hasPaxDeduction: false, paxDeductionAmount: null },
      { id: "p-bbbb", hasPaxDeduction: false, paxDeductionAmount: null },
      { id: "p-cccc", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    dbMock.property.findUnique = vi.fn();
    // TaTier: items use tenancyChargesByKaen=0; return matching tier.
    dbMock.taTier.findMany = vi.fn().mockResolvedValue([
      { tier: 1, rentalMin: "0.00", rentalMax: null, companyMinimum: "0.00" },
    ]);

    const res = await submitClaimService(session, "c1");
    expect(res.ok).toBe(true);

    // The fix: exactly one batched findMany call, zero findUnique calls.
    expect(dbMock.property.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.property.findUnique).not.toHaveBeenCalled();

    // And dedupe: 3 distinct propertyIds, not 4.
    const findManyArgs = dbMock.property.findMany.mock.calls[0][0];
    expect(findManyArgs.where.id.in).toHaveLength(3);
    expect(new Set(findManyArgs.where.id.in)).toEqual(
      new Set(["p-aaaa", "p-bbbb", "p-cccc"]),
    );
  });
});

// ── tenant profile fields — write-through + read-through ────────────────────

describe("tenant profile fields — round-trip via createAndSubmitClaimService + getClaimService", () => {
  beforeEach(() => vi.clearAllMocks());

  const profileInput = {
    claimType: "tenant_portion" as const,
    items: [{
      propertyId: "11111111-1111-4111-8111-111111111111",
      condoName: "Seri Kembangan Heights",
      unitCode: "A-08-02",
      roomType: "Master",
      tenantName: "Ahmad Abdullah",
      tenantEmail: "ahmad@example.com",
      tenantPhone: "+60123456789",
      tenantLinkedinUrl: "https://www.linkedin.com/in/ahmad/",
      tenantInstagramHandle: "ahmad_a",
      tenantJobPosition: "Engineer",
      salesDate: "2026-04-19",
      moveInDate: "2026-04-20",
      moveOutDate: "2027-04-19",
      monthlyRental: "1000.00",
      commissionPercentage: "70.00",
      tenancyChargesByAgent: "0",
      tenancyChargesByKaen: "216",
    }],
  };

  it("persists tenant profile fields on submit and round-trips on read", async () => {
    // Set up mocks for createAndSubmitClaimService (same pattern as existing tests above).
    dbMock.$transaction = vi.fn(async (cb) => cb(dbMock));
    dbMock.commissionClaim.findFirst = vi.fn().mockResolvedValue(null);
    dbMock.$queryRaw = vi.fn().mockResolvedValue([]);
    dbMock.party.findFirst = vi.fn().mockResolvedValue({ agentLevel: "new_agent" });
    dbMock.agentTierMapping.findFirst = vi.fn().mockResolvedValue({ percentage: "40" });
    mockedRepo.resolveTierPercentage.mockResolvedValue({
      ok: true, percentage: new Decimal("40"), source: "direct",
    } as never);
    dbMock.property.findMany = vi.fn().mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", hasPaxDeduction: false, paxDeductionAmount: null },
    ]);
    dbMock.taTier.findMany = vi.fn().mockResolvedValue([
      { tier: 1, rentalMin: "0.00", rentalMax: null, companyMinimum: "216.00" },
    ]);
    dbMock.commissionClaim.create = vi.fn().mockResolvedValue({ id: "profile-claim-id", claimNumber: "CLM-0123" });
    dbMock.commissionClaim.count = vi.fn().mockResolvedValue(122);
    dbMock.activityLog = { create: vi.fn().mockResolvedValue({}) };

    const created = await createAndSubmitClaimService(session, profileInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Capture the itemsData written to Prisma and confirm the 5 fields are present.
    const createCall = dbMock.commissionClaim.create.mock.calls[0][0] as {
      data: { items: { create: Array<Record<string, unknown>> } };
    };
    const writtenItem = createCall.data.items.create[0];
    expect(writtenItem.tenantEmail).toBe("ahmad@example.com");
    expect(writtenItem.tenantPhone).toBe("+60123456789");
    expect(writtenItem.tenantLinkedinUrl).toBe("https://www.linkedin.com/in/ahmad/");
    expect(writtenItem.tenantInstagramHandle).toBe("ahmad_a");
    expect(writtenItem.tenantJobPosition).toBe("Engineer");

    // Set up mock for getClaimService — commissionClaim.findUnique returns the
    // persisted claim with the 5 profile fields populated (simulating Prisma).
    dbMock.commissionClaim.findUnique = vi.fn().mockResolvedValue({
      id: "profile-claim-id",
      agentPartyId: session.partyId, // filer == viewer → owner path
      organizationId: session.orgId,
      claimNumber: "CLM-0123",
      status: "submitted",
      claimType: "tenant_portion",
      totalNettPayout: new Decimal("280"),
      rejectionReason: null,
      submittedAt: new Date("2026-04-25T00:00:00Z"),
      createdAt: new Date("2026-04-25T00:00:00Z"),
      items: [{
        id: "item-1",
        propertyId: "11111111-1111-4111-8111-111111111111",
        condoName: "Seri Kembangan Heights",
        unitCode: "A-08-02",
        roomType: "Master",
        tenantName: "Ahmad Abdullah",
        tenantEmail: "ahmad@example.com",
        tenantPhone: "+60123456789",
        tenantLinkedinUrl: "https://www.linkedin.com/in/ahmad/",
        tenantInstagramHandle: "ahmad_a",
        tenantJobPosition: "Engineer",
        salesDate: new Date("2026-04-19"),
        moveInDate: new Date("2026-04-20"),
        monthlyRental: new Decimal("1000"),
        agentTierPercentage: new Decimal("40"),
        commissionPercentage: new Decimal("70"),
        tenancyChargesByAgent: new Decimal("0"),
        tenancyChargesByKaen: new Decimal("216"),
        numberOfPax: null,
        nettPayout: new Decimal("280"),
        property: { hasPaxDeduction: false, paxDeductionAmount: null },
      }],
    });

    const reloaded = await getClaimService(session, "profile-claim-id");
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;

    expect(reloaded.data.items[0]).toMatchObject({
      tenantEmail: "ahmad@example.com",
      // The read DTO canonicalizes tenantPhone (the seeded DB value here was
      // "+60123456789", which `readPhoneAnyFormat` normalizes to canonical)
      // and adds a `formattedTenantPhone` for display. Pre-formatting at the
      // API keeps libphonenumber-js out of the client bundle.
      tenantPhone: "60123456789",
      formattedTenantPhone: "+60 12-345 6789",
      tenantLinkedinUrl: "https://www.linkedin.com/in/ahmad/",
      tenantInstagramHandle: "ahmad_a",
      tenantJobPosition: "Engineer",
    });
  });
});

// ── getClaimService — access rule (Plan A) ────────────────────────────────────

describe("getClaimService — access rule (Plan A)", () => {
  function mkSession(over: { partyId: string; role?: "admin" | "manager" }) {
    return { partyId: over.partyId, role: over.role, orgId: "org-1" } as any;
  }

  function mkPrisma(opts: {
    claim: { agentPartyId: string };
    partyChain?: Record<string, string | null>;
  }) {
    return {
      commissionClaim: {
        findUnique: vi.fn(async () => ({
          id: "claim-1",
          agentPartyId: opts.claim.agentPartyId,
          organizationId: "org-1",
          claimNumber: "NX-1",
          status: "submitted",
          claimType: "tenant_portion",
          rejectionReason: null,
          totalNettPayout: 0,
          submittedAt: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          items: [],
        })),
      },
      party: {
        findUnique: vi.fn(async ({ where }: any) => {
          const chain = opts.partyChain ?? {};
          return chain[where.id] !== undefined ? { uplineId: chain[where.id] } : null;
        }),
      },
    } as any;
  }

  it("filer can view their own claim", async () => {
    const session = mkSession({ partyId: "filer" });
    const prisma = mkPrisma({ claim: { agentPartyId: "filer" } });
    await expect(getClaimService(session, "claim-1", prisma)).resolves.toBeTruthy();
  });

  it("upline can view a downline's claim (walks uplineId chain)", async () => {
    const session = mkSession({ partyId: "u2" });
    const prisma = mkPrisma({
      claim: { agentPartyId: "filer" },
      partyChain: { filer: "u1", u1: "u2", u2: null },
    });
    await expect(getClaimService(session, "claim-1", prisma)).resolves.toBeTruthy();
  });

  it("admin (role='admin') can view any claim", async () => {
    const session = mkSession({ partyId: "stranger", role: "admin" });
    const prisma = mkPrisma({ claim: { agentPartyId: "filer" }, partyChain: { filer: null } });
    await expect(getClaimService(session, "claim-1", prisma)).resolves.toBeTruthy();
  });

  it("manager (role='manager') can view any claim", async () => {
    const session = mkSession({ partyId: "stranger", role: "manager" });
    const prisma = mkPrisma({ claim: { agentPartyId: "filer" }, partyChain: { filer: null } });
    await expect(getClaimService(session, "claim-1", prisma)).resolves.toBeTruthy();
  });

  it("non-upline non-admin gets not-found", async () => {
    const session = mkSession({ partyId: "stranger" });
    const prisma = mkPrisma({ claim: { agentPartyId: "filer" }, partyChain: { filer: null } });
    const res = await getClaimService(session, "claim-1", prisma);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not.?found/i);
  });
});
