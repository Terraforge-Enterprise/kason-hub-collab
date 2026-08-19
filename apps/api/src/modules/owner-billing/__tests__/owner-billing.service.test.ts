import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../owner-billing.repository", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
  createFeeConfig: vi.fn(),
  listFeeConfigs: vi.fn(async () => []),
  getFeeConfig: vi.fn(async () => null),
  updateFeeConfigGuarded: vi.fn(),
  setFeeConfigActive: vi.fn(),
  findOwnerInOrg: vi.fn(),
  findPropertyInOrg: vi.fn(),
}));

import { recordAudit } from "../../../lib/audit";
import { StaleUpdateError } from "../../../lib/concurrency-error";
import {
  createFeeConfig,
  findOwnerInOrg,
  findPropertyInOrg,
  getFeeConfig,
  listFeeConfigs,
  setFeeConfigActive,
  updateFeeConfigGuarded,
  type DbManagementFeeConfig,
} from "../owner-billing.repository";
import {
  createFeeConfigService,
  getFeeConfigService,
  listFeeConfigsService,
  restoreFeeConfigService,
  retireFeeConfigService,
  updateFeeConfigService,
} from "../owner-billing.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000002";
const OWNER = "00000000-0000-0000-0000-0000000000aa";
const PROPERTY = "00000000-0000-0000-0000-0000000000bb";
const CONFIG = "00000000-0000-0000-0000-0000000000cc";
const ISO = "2026-06-01T00:00:00.000Z";

const ctx = { orgId: ORG, actorUserId: ACTOR, actorRole: "admin" as const };

// Prisma returns Decimal columns as Decimal-likes; a string with a `.toString()`
// that yields itself is a faithful stand-in for the mapping under test.
const dec = (s: string) => ({ toString: () => s }) as unknown as DbManagementFeeConfig["feeValue"];

function dbConfig(overrides: Partial<DbManagementFeeConfig> = {}): DbManagementFeeConfig {
  return {
    id: CONFIG,
    organizationId: ORG,
    ownerPartyId: OWNER,
    propertyId: null,
    feeType: "percent",
    feeValue: dec("10"),
    capAmount: null,
    sstPercent: dec("8"),
    freePeriodStart: null,
    freePeriodEnd: null,
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    ...overrides,
  } as DbManagementFeeConfig;
}

const validPercentInput = {
  ownerPartyId: OWNER,
  feeType: "percent" as const,
  feeValue: "10",
  sstPercent: "8",
  isActive: true,
};

const ISO_LATER = "2026-06-02T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createFeeConfig).mockResolvedValue(dbConfig());
  vi.mocked(listFeeConfigs).mockResolvedValue([]);
  vi.mocked(getFeeConfig).mockResolvedValue(null);
  vi.mocked(updateFeeConfigGuarded).mockResolvedValue(dbConfig());
  vi.mocked(setFeeConfigActive).mockResolvedValue(dbConfig());
  // Default the in-org FK checks to "found" so the happy paths exercise the write.
  // Individual cross-org tests override these to null.
  vi.mocked(findOwnerInOrg).mockResolvedValue({ id: "tenancy-1" });
  vi.mocked(findPropertyInOrg).mockResolvedValue({ id: PROPERTY });
});

describe("createFeeConfigService", () => {
  it("creates a percent config, org-scopes the insert, and audits feeConfig.create in-tx", async () => {
    vi.mocked(createFeeConfig).mockResolvedValue(
      dbConfig({ feeType: "percent", feeValue: dec("10") }),
    );
    const result = await createFeeConfigService(ctx, validPercentInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    // The returned row echoes feeType/feeValue.
    expect(result.data.feeType).toBe("percent");
    expect(result.data.feeValue).toBe("10");

    // Insert carries the actor's org id (org-scoping on write).
    expect(createFeeConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        ownerPartyId: OWNER,
        feeType: "percent",
        feeValue: "10",
      }),
    );
    // Audit row written inside the same transaction.
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        action: "owner-billing.feeConfig.create",
        entityType: "ManagementFeeConfig",
        entityId: CONFIG,
      }),
    );
  });

  it("404s when the party is not an owner in the actor's org (findOwnerInOrg null)", async () => {
    vi.mocked(findOwnerInOrg).mockResolvedValue(null);
    const result = await createFeeConfigService(ctx, validPercentInput);
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "Owner not found in this organization",
    });
    // Validation runs BEFORE the insert tx — nothing is written or audited.
    expect(findOwnerInOrg).toHaveBeenCalledWith(ORG, OWNER);
    expect(createFeeConfig).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("404s when propertyId is given but not a Property in the actor's org", async () => {
    vi.mocked(findOwnerInOrg).mockResolvedValue({ id: "tenancy-1" });
    vi.mocked(findPropertyInOrg).mockResolvedValue(null);
    const result = await createFeeConfigService(ctx, {
      ...validPercentInput,
      propertyId: PROPERTY,
    });
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "Property not found in this organization",
    });
    expect(findPropertyInOrg).toHaveBeenCalledWith(ORG, PROPERTY);
    expect(createFeeConfig).not.toHaveBeenCalled();
  });

  it("does NOT check the property when propertyId is omitted (null = all owner properties)", async () => {
    await createFeeConfigService(ctx, validPercentInput);
    expect(findOwnerInOrg).toHaveBeenCalledWith(ORG, OWNER);
    expect(findPropertyInOrg).not.toHaveBeenCalled();
    expect(createFeeConfig).toHaveBeenCalled();
  });

  it("serialises Decimal columns to strings (never leaks Decimal)", async () => {
    vi.mocked(createFeeConfig).mockResolvedValue(
      dbConfig({
        feeType: "cap",
        feeValue: dec("12.5"),
        capAmount: dec("2500"),
        sstPercent: dec("8"),
        propertyId: PROPERTY,
      }),
    );
    const result = await createFeeConfigService(ctx, {
      ownerPartyId: OWNER,
      propertyId: PROPERTY,
      feeType: "cap",
      feeValue: "12.5",
      capAmount: "2500",
      sstPercent: "8",
      isActive: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.feeValue).toBe("12.5");
    expect(result.data.capAmount).toBe("2500");
    expect(result.data.sstPercent).toBe("8");
    expect(result.data.propertyId).toBe(PROPERTY);
    expect(typeof result.data.feeValue).toBe("string");
  });
});

describe("listFeeConfigsService", () => {
  it("forwards org id + filters + paging to the repository and wraps the envelope", async () => {
    vi.mocked(listFeeConfigs).mockResolvedValue([dbConfig({ ownerPartyId: OWNER })]);
    const result = await listFeeConfigsService(
      ctx,
      { ownerPartyId: OWNER },
      { limit: 25, offset: 10 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listFeeConfigs).toHaveBeenCalledWith(
      ORG,
      { ownerPartyId: OWNER },
      { limit: 25, offset: 10 },
    );
    expect(result.data.limit).toBe(25);
    expect(result.data.offset).toBe(10);
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]!.ownerPartyId).toBe(OWNER);
  });

  it("maps every row's Decimals to strings", async () => {
    vi.mocked(listFeeConfigs).mockResolvedValue([dbConfig({ feeValue: dec("7.5") })]);
    const result = await listFeeConfigsService(ctx, {}, { limit: 50, offset: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]!.feeValue).toBe("7.5");
  });
});

describe("getFeeConfigService", () => {
  it("returns 404 when the repository returns null (cross-org / missing)", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(null);
    const result = await getFeeConfigService(ctx, CONFIG);
    expect(result).toEqual({ ok: false, status: 404, error: "Fee config not found" });
    expect(getFeeConfig).toHaveBeenCalledWith(ORG, CONFIG);
  });

  it("returns 200 with the mapped row when found", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(dbConfig({ feeValue: dec("10") }));
    const result = await getFeeConfigService(ctx, CONFIG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.id).toBe(CONFIG);
    expect(result.data.feeValue).toBe("10");
  });
});

describe("updateFeeConfigService", () => {
  const patch = { feeValue: "12", expectedUpdatedAt: ISO };

  it("404s when the config does not exist (or belongs to another org)", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(null);
    const result = await updateFeeConfigService(ctx, CONFIG, patch);
    expect(result).toEqual({ ok: false, status: 404, error: "Fee config not found" });
    // org-scoped pre-read: id + org id.
    expect(getFeeConfig).toHaveBeenCalledWith(ORG, CONFIG);
    expect(updateFeeConfigGuarded).not.toHaveBeenCalled();
  });

  it("updates the row, org-scopes the guarded write, and audits feeConfig.update in-tx", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(dbConfig({ feeValue: dec("10") }));
    vi.mocked(updateFeeConfigGuarded).mockResolvedValue(
      dbConfig({ feeValue: dec("12"), updatedAt: new Date(ISO_LATER) }),
    );
    const result = await updateFeeConfigService(ctx, CONFIG, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.feeValue).toBe("12");
    // updatedAt is bumped past the caller's expectedUpdatedAt.
    expect(result.data.updatedAt).toBe(ISO_LATER);

    // Guarded write carries org id + id + the caller's expectedUpdatedAt + only the patched field.
    expect(updateFeeConfigGuarded).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      CONFIG,
      ISO,
      expect.objectContaining({ feeValue: "12" }),
    );
    // expectedUpdatedAt must NOT be written into the row data.
    const dataArg = vi.mocked(updateFeeConfigGuarded).mock.calls[0]![4] as Record<string, unknown>;
    expect("expectedUpdatedAt" in dataArg).toBe(false);

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        action: "owner-billing.feeConfig.update",
        entityType: "ManagementFeeConfig",
        entityId: CONFIG,
      }),
    );
  });

  it("maps a stale guarded write (StaleUpdateError) to 409 with the exact reload message", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(dbConfig());
    vi.mocked(updateFeeConfigGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await updateFeeConfigService(ctx, CONFIG, patch);
    expect(result).toEqual({ ok: false, status: 409, error: "Record changed — reloaded" });
    // No audit when the guarded write fails (the whole tx unwinds).
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("only writes the supplied patch fields (omits expectedUpdatedAt + untouched fields)", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(dbConfig());
    await updateFeeConfigService(ctx, CONFIG, { sstPercent: "10.8", expectedUpdatedAt: ISO });
    const dataArg = vi.mocked(updateFeeConfigGuarded).mock.calls[0]![4] as Record<string, unknown>;
    expect(dataArg).toEqual({ sstPercent: "10.8" });
  });

  it("400s a patch that nulls capAmount while omitting feeType on a stored cap row (cap invariant)", async () => {
    // Stored row is feeType:"cap" with a capAmount; the patch clears capAmount but
    // does NOT carry feeType, so the route refine (keyed on patch.feeType) passes.
    // The service must reject against the EFFECTIVE feeType:"cap" + capAmount:null.
    vi.mocked(getFeeConfig).mockResolvedValue(
      dbConfig({ feeType: "cap", capAmount: dec("2500") }),
    );
    const result = await updateFeeConfigService(ctx, CONFIG, {
      capAmount: null,
      expectedUpdatedAt: ISO,
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "capAmount is required when feeType is 'cap'",
    });
    // Guarded against BEFORE the write — no invalid row, no audit.
    expect(updateFeeConfigGuarded).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("allows nulling capAmount when the patch also switches feeType away from cap", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(
      dbConfig({ feeType: "cap", capAmount: dec("2500") }),
    );
    vi.mocked(updateFeeConfigGuarded).mockResolvedValue(
      dbConfig({ feeType: "percent", capAmount: null }),
    );
    const result = await updateFeeConfigService(ctx, CONFIG, {
      feeType: "percent",
      capAmount: null,
      expectedUpdatedAt: ISO,
    });
    expect(result.ok).toBe(true);
    expect(updateFeeConfigGuarded).toHaveBeenCalled();
  });

  it("404s a patch re-pointing ownerPartyId to a party not in the actor's org", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(dbConfig());
    vi.mocked(findOwnerInOrg).mockResolvedValue(null);
    const OTHER_OWNER = "00000000-0000-0000-0000-0000000000dd";
    const result = await updateFeeConfigService(ctx, CONFIG, {
      ownerPartyId: OTHER_OWNER,
      expectedUpdatedAt: ISO,
    });
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "Owner not found in this organization",
    });
    expect(findOwnerInOrg).toHaveBeenCalledWith(ORG, OTHER_OWNER);
    expect(updateFeeConfigGuarded).not.toHaveBeenCalled();
  });

  it("404s a patch re-pointing propertyId to a property not in the actor's org", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(dbConfig());
    vi.mocked(findPropertyInOrg).mockResolvedValue(null);
    const OTHER_PROPERTY = "00000000-0000-0000-0000-0000000000ee";
    const result = await updateFeeConfigService(ctx, CONFIG, {
      propertyId: OTHER_PROPERTY,
      expectedUpdatedAt: ISO,
    });
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "Property not found in this organization",
    });
    expect(findPropertyInOrg).toHaveBeenCalledWith(ORG, OTHER_PROPERTY);
    expect(updateFeeConfigGuarded).not.toHaveBeenCalled();
  });

  it("PATCHes freePeriodStart + freePeriodEnd: values persist (Dates written) + audit fires", async () => {
    const FREE_START = "2026-07-01T00:00:00.000Z";
    const FREE_END = "2026-09-30T00:00:00.000Z";
    vi.mocked(getFeeConfig).mockResolvedValue(dbConfig({ freePeriodStart: null, freePeriodEnd: null }));
    // The guarded write returns the row with the free period populated.
    vi.mocked(updateFeeConfigGuarded).mockResolvedValue(
      dbConfig({
        freePeriodStart: new Date(FREE_START),
        freePeriodEnd: new Date(FREE_END),
        updatedAt: new Date(ISO_LATER),
      }),
    );

    const result = await updateFeeConfigService(ctx, CONFIG, {
      freePeriodStart: FREE_START,
      freePeriodEnd: FREE_END,
      expectedUpdatedAt: ISO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The mapped row reflects the persisted free period (ISO strings, never Dates).
    expect(result.data.freePeriodStart).toBe(FREE_START);
    expect(result.data.freePeriodEnd).toBe(FREE_END);

    // The guarded write was issued org-scoped with the free-period columns coerced
    // to Date instances (the service maps the ISO body strings → Date for Prisma).
    const dataArg = vi.mocked(updateFeeConfigGuarded).mock.calls[0]![4] as Record<string, unknown>;
    expect(dataArg.freePeriodStart).toBeInstanceOf(Date);
    expect(dataArg.freePeriodEnd).toBeInstanceOf(Date);
    expect((dataArg.freePeriodStart as Date).toISOString()).toBe(FREE_START);
    expect((dataArg.freePeriodEnd as Date).toISOString()).toBe(FREE_END);
    // expectedUpdatedAt is never written into the row data.
    expect("expectedUpdatedAt" in dataArg).toBe(false);

    // Audit row written inside the same transaction.
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        action: "owner-billing.feeConfig.update",
        entityType: "ManagementFeeConfig",
        entityId: CONFIG,
      }),
    );
  });

});

describe("retireFeeConfigService / restoreFeeConfigService", () => {
  it("retire 404s when the config is missing / cross-org", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(null);
    const result = await retireFeeConfigService(ctx, CONFIG);
    expect(result).toEqual({ ok: false, status: 404, error: "Fee config not found" });
    expect(getFeeConfig).toHaveBeenCalledWith(ORG, CONFIG);
    expect(setFeeConfigActive).not.toHaveBeenCalled();
  });

  it("retire flips isActive false (org-scoped) and audits feeConfig.retire in-tx", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(dbConfig({ isActive: true }));
    vi.mocked(setFeeConfigActive).mockResolvedValue(dbConfig({ isActive: false }));
    const result = await retireFeeConfigService(ctx, CONFIG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.isActive).toBe(false);
    expect(setFeeConfigActive).toHaveBeenCalledWith(expect.anything(), ORG, CONFIG, false);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        action: "owner-billing.feeConfig.retire",
        entityType: "ManagementFeeConfig",
        entityId: CONFIG,
      }),
    );
  });

  it("restore flips isActive true (org-scoped) and audits feeConfig.restore in-tx", async () => {
    vi.mocked(getFeeConfig).mockResolvedValue(dbConfig({ isActive: false }));
    vi.mocked(setFeeConfigActive).mockResolvedValue(dbConfig({ isActive: true }));
    const result = await restoreFeeConfigService(ctx, CONFIG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isActive).toBe(true);
    expect(setFeeConfigActive).toHaveBeenCalledWith(expect.anything(), ORG, CONFIG, true);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "owner-billing.feeConfig.restore" }),
    );
  });
});
