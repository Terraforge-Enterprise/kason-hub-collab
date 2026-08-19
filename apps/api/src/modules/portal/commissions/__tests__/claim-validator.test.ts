import { describe, it, expect, vi } from "vitest";
import { validateRuleA, validateRuleB, validateRuleC, validateAll } from "../claim-validator";
import { isClaimError } from "../claim-errors";

const baseItem = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  condoName: "Seri Kembangan Heights",
  unitCode: "A-08-02",
  roomType: "Master",
  tenantName: "T",
  salesDate: "2026-04-19",
  moveInDate: "2026-04-20",
  monthlyRental: "1000.00",
  commissionPercentage: "50.00",
  tenancyChargesByAgent: "0",
  tenancyChargesByKaen: "216",
};

describe("validateRuleA (intra-payload dedupe)", () => {
  it("passes with distinct keys", () => {
    const result = validateRuleA({
      claimType: "tenant_portion",
      items: [baseItem, { ...baseItem, moveInDate: "2026-05-01" }],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate (propertyId, unitCode, roomType, moveInDate)", () => {
    const result = validateRuleA({
      claimType: "tenant_portion",
      items: [baseItem, { ...baseItem, commissionPercentage: "30.00" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("rule_a_duplicate");
      expect((result.error.data as { keyIndex: number }).keyIndex).toBe(1);
      expect(isClaimError(result.error)).toBe(true);
    }
  });

  it("is case-insensitive on unitCode and roomType (matches stored LOWER index)", () => {
    const result = validateRuleA({
      claimType: "tenant_portion",
      items: [
        { ...baseItem, unitCode: "A-08-02", roomType: "Master" },
        { ...baseItem, unitCode: "a-08-02", roomType: "master" },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts same unit/room with different moveInDate", () => {
    const result = validateRuleA({
      claimType: "tenant_portion",
      items: [baseItem, { ...baseItem, moveInDate: "2026-05-20" }],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateRuleB (same-agent exact-duplicate block)", () => {
  const session = { orgId: "o1", partyId: "p-priya" };
  const payload = {
    claimType: "tenant_portion",
    items: [baseItem],
  };

  it("passes when no prior same-agent active claim exists", async () => {
    const findFirstMock = vi.fn().mockResolvedValue(null);
    const tx = {
      commissionClaim: { findFirst: findFirstMock },
    } as never;

    const result = await validateRuleB(tx, payload, session);
    expect(result.ok).toBe(true);
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "o1",
          agentPartyId: "p-priya",
          claimType: "tenant_portion",
          status: { in: ["submitted", "approved", "paid"] },
        }),
      }),
    );
  });

  it("scopes the dupe check to claimType + tenantName + salesDate (different sides / tenants / sales dates pass)", async () => {
    const findFirstMock = vi.fn().mockResolvedValue(null);
    const tx = {
      commissionClaim: { findFirst: findFirstMock },
    } as never;

    await validateRuleB(tx, payload, session);

    const call = findFirstMock.mock.calls[0][0];
    // Parent claim filter must include claimType so a tenant_portion never collides with a listing_portion.
    expect(call.where.claimType).toBe("tenant_portion");
    // Item filter must include tenantName (case-insensitive) and salesDate so two different deals
    // on the same unit/room/move-in-date don't collide.
    expect(call.where.items.some.tenantName).toEqual({ equals: "T", mode: "insensitive" });
    expect(call.where.items.some.salesDate).toEqual(new Date("2026-04-19"));
  });

  it("fails with rule_b_same_agent_active when an exact-duplicate claim exists", async () => {
    const tx = {
      commissionClaim: {
        findFirst: vi.fn().mockResolvedValue({ id: "c-prior", claimNumber: "CLM-0042" }),
      },
    } as never;

    const result = await validateRuleB(tx, payload, session);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("rule_b_same_agent_active");
      expect((result.error.data as { priorClaimNumber: string }).priorClaimNumber).toBe("CLM-0042");
      expect(result.error.message).toMatch(/CLM-0042/);
    }
  });

  it("supports excludeClaimId to avoid self-match on re-submission", async () => {
    const findFirstMock = vi.fn().mockResolvedValue(null);
    const tx = {
      commissionClaim: { findFirst: findFirstMock },
    } as never;

    await validateRuleB(tx, payload, session, "claim-being-submitted");
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "claim-being-submitted" },
        }),
      }),
    );
  });
});

describe("validateRuleC (sum cap, grouped query)", () => {
  const session = { orgId: "o1", partyId: "p-priya" };

  it("passes when existing_sum + new_sum <= 100", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        // One row per distinct key with existing active total.
        {
          propertyId: "11111111-1111-4111-8111-111111111111",
          unit_l: "a-08-02",
          room_l: "master",
          moveInDate: new Date("2026-04-20"),
          total: "70",
        },
      ]),
    } as never;

    const result = await validateRuleC(
      tx,
      {
        claimType: "tenant_portion",
        items: [{ ...baseItem, commissionPercentage: "30.00" }],
      },
      session,
    );
    expect(result.ok).toBe(true);
  });

  it("fails with rule_c_sum_exceeded when total > 100, reports available max, does NOT leak others' total", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          propertyId: "11111111-1111-4111-8111-111111111111",
          unit_l: "a-08-02",
          room_l: "master",
          moveInDate: new Date("2026-04-20"),
          total: "70",
        },
      ]),
    } as never;

    const result = await validateRuleC(
      tx,
      {
        claimType: "tenant_portion",
        items: [{ ...baseItem, commissionPercentage: "31.00" }],
      },
      session,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("rule_c_sum_exceeded");
      expect((result.error.data as { availableMax: string }).availableMax).toBe("30.00");
      // Message must contain the availableMax but must NOT leak "other agents" or the 70% total.
      expect(result.error.message).toMatch(/30\.00/);
      expect(result.error.message.toLowerCase()).not.toMatch(/other/);
      expect(result.error.message).not.toMatch(/70/);
    }
  });

  it("groups multiple distinct keys in a single $queryRaw call (not N calls)", async () => {
    const queryMock = vi.fn().mockResolvedValue([]);
    const tx = { $queryRaw: queryMock } as never;

    await validateRuleC(
      tx,
      {
        claimType: "tenant_portion",
        items: [
          { ...baseItem, unitCode: "A-1", commissionPercentage: "50" },
          { ...baseItem, unitCode: "A-2", commissionPercentage: "50" },
          { ...baseItem, unitCode: "A-3", commissionPercentage: "50" },
        ],
      },
      session,
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("accumulates multiple items sharing a key in the submission (intra-payload sum)", async () => {
    // No existing active claims (empty DB result); payload has two items for the same key at 60+50 = 110.
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) } as never;

    const dup = { ...baseItem };
    const result = await validateRuleC(
      tx,
      {
        claimType: "tenant_portion",
        items: [
          { ...dup, commissionPercentage: "60" },
          { ...dup, commissionPercentage: "50" },
        ],
      },
      session,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("rule_c_sum_exceeded");
  });

  it("excludeClaimId is bound into the SQL so the current claim is excluded from existing_sum", async () => {
    const queryMock = vi.fn().mockResolvedValue([]);
    const tx = { $queryRaw: queryMock } as never;

    await validateRuleC(
      tx,
      { claimType: "tenant_portion", items: [baseItem] },
      session,
      "claim-42",
    );

    // $queryRaw is called with a Prisma.sql template (TemplateStringsArray as arg 0, bound values from arg 1 onwards).
    const call = queryMock.mock.calls[0];
    const values = call.slice(1);
    expect(values).toContain("claim-42");
  });

  it("counts 'amended' status as an active allocation", async () => {
    // Seed an amended claim with 80%; proposing 30% should push total to 110% → reject.
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          propertyId: "11111111-1111-4111-8111-111111111111",
          unit_l: "a-08-02",
          room_l: "master",
          moveInDate: new Date("2026-04-20"),
          total: "80",
        },
      ]),
    } as never;

    const result = await validateRuleC(
      tx,
      {
        claimType: "tenant_portion",
        items: [{ ...baseItem, commissionPercentage: "30.00" }],
      },
      session,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("rule_c_sum_exceeded");
      expect((result.error.data as { availableMax: string }).availableMax).toBe("20.00");
    }
  });

  it("error includes existing + proposed share numbers in detail payload", async () => {
    // existing = 80%, proposed = 30% → total = 110%.
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          propertyId: "11111111-1111-4111-8111-111111111111",
          unit_l: "a-08-02",
          room_l: "master",
          moveInDate: new Date("2026-04-20"),
          total: "80",
        },
      ]),
    } as never;

    const result = await validateRuleC(
      tx,
      {
        claimType: "tenant_portion",
        items: [{ ...baseItem, commissionPercentage: "30.00" }],
      },
      session,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      type RuleCData = {
        availableMax: string;
        existingPct: string;
        proposedPct: string;
        totalPct: string;
        key: { propertyId: string; unitCodeLower: string; roomTypeLower: string; moveInDate: string };
      };
      const data = result.error.data as RuleCData;
      expect(data.existingPct).toBe("80.00");
      expect(data.proposedPct).toBe("30.00");
      expect(data.totalPct).toBe("110.00");
      expect(data.key.propertyId).toBe("11111111-1111-4111-8111-111111111111");
      expect(data.key.unitCodeLower).toBe("a-08-02");
      expect(data.key.roomTypeLower).toBe("master");
      expect(data.key.moveInDate).toBe("2026-04-20");
    }
  });
});

describe("validateAll (A → B → C, short-circuit on first failure)", () => {
  const session = { orgId: "o1", partyId: "p-priya" };

  it("returns Rule A failure before querying the DB", async () => {
    const findFirstMock = vi.fn();
    const queryRawMock = vi.fn();
    const tx = {
      commissionClaim: { findFirst: findFirstMock },
      $queryRaw: queryRawMock,
    } as never;

    const result = await validateAll(
      tx,
      {
        claimType: "tenant_portion",
        items: [baseItem, { ...baseItem }], // duplicate intra-payload → Rule A
      },
      session,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("rule_a_duplicate");
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("returns Rule B failure before running Rule C", async () => {
    const queryRawMock = vi.fn();
    const tx = {
      commissionClaim: {
        findFirst: vi.fn().mockResolvedValue({ id: "c-prior", claimNumber: "CLM-0001" }),
      },
      $queryRaw: queryRawMock,
    } as never;

    const result = await validateAll(
      tx,
      { claimType: "tenant_portion", items: [baseItem] },
      session,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("rule_b_same_agent_active");
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("runs Rule C when A and B pass; returns ok:true if C passes", async () => {
    const tx = {
      commissionClaim: { findFirst: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as never;

    const result = await validateAll(
      tx,
      { claimType: "tenant_portion", items: [baseItem] },
      session,
    );

    expect(result.ok).toBe(true);
  });
});
