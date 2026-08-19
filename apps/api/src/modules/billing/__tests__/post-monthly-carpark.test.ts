import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB mock ────────────────────────────────────────────────────────────────
// Mirrors the auto-draft.service.test.ts template: getDb() is not used
// directly (the helper receives a tx), so we only need a tx stub.
const mockTenancyFindFirst = vi.fn();
const mockAssignmentFindMany = vi.fn();
const mockChargeFindFirst = vi.fn();
const mockChargeCreate = vi.fn();
const mockChargeUpdateMany = vi.fn();
const mockChargeEventCreate = vi.fn();

const fakeTx = {
  tenancy: { findFirst: mockTenancyFindFirst },
  carparkAssignment: { findMany: mockAssignmentFindMany },
  charge: { findFirst: mockChargeFindFirst, create: mockChargeCreate, updateMany: mockChargeUpdateMany },
  chargeEvent: { create: mockChargeEventCreate },
};

vi.mock("@kason/db", () => ({
  getDb: () => ({ $transaction: vi.fn() }),
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;
      constructor(message: string, opts: { code: string }) {
        super(message);
        this.name = "PrismaClientKnownRequestError";
        this.code = opts.code;
      }
    },
  },
}));

// Import AFTER mocks are set up.
import { postMonthlyCarparkForTenancy, carparkChargeNumber } from "../post-monthly-carpark";

// ─────────────────────────────────────────────────────────────────────────────

const ORG = "00000000-0000-4000-8000-000000000001";
const TENANCY = "00000000-0000-4000-8000-000000000002";
const PARTY = "00000000-0000-4000-8000-000000000003";
const CARPARK = "00000000-0000-4000-8000-000000000004";
const USER = "00000000-0000-4000-8000-000000000005";
const CHARGE_ID = "00000000-0000-4000-8000-000000000006";

const JUNE = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01
const COMPACT_JUNE = "202606";

// ── carparkChargeNumber ─────────────────────────────────────────────────────

describe("carparkChargeNumber", () => {
  it("produces CARPARK-{YYYYMM}-{carparkId}", () => {
    expect(carparkChargeNumber("202606", CARPARK)).toBe(`CARPARK-202606-${CARPARK}`);
  });
});

// ── postMonthlyCarparkForTenancy ────────────────────────────────────────────

describe("postMonthlyCarparkForTenancy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenancyFindFirst.mockResolvedValue({ tenantPartyId: PARTY });
    mockChargeEventCreate.mockResolvedValue({ id: "evt-1" });
  });

  it("posts exactly one carpark Charge with carparkId + the assignment monthlyCharge", async () => {
    const charge100 = { toFixed: (n: number) => (100).toFixed(n) } as never;
    mockAssignmentFindMany.mockResolvedValue([{ carparkId: CARPARK, monthlyCharge: charge100 }]);
    mockChargeFindFirst.mockResolvedValue(null); // no existing charge
    mockChargeCreate.mockResolvedValue({ id: CHARGE_ID });

    const result = await postMonthlyCarparkForTenancy(fakeTx as never, ORG, TENANCY, JUNE, USER);

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.chargeIds).toEqual([CHARGE_ID]);

    // Charge was created with the correct fields
    expect(mockChargeCreate).toHaveBeenCalledOnce();
    const createArg = mockChargeCreate.mock.calls[0][0].data;
    expect(createArg.chargeNumber).toBe(`CARPARK-${COMPACT_JUNE}-${CARPARK}`);
    expect(createArg.carparkId).toBe(CARPARK);
    expect(createArg.unitId).toBeNull();
    expect(createArg.partyId).toBe(PARTY);
    expect(createArg.chargeType).toBe("carpark");
    expect(createArg.status).toBe("posted");
    expect(createArg.amount).toBe("100.00");
    expect(createArg.outstandingAmount).toBe("100.00");
    expect(createArg.currency).toBe("MYR");
    expect(createArg.dueDate).toEqual(JUNE);
    expect(createArg.billingMonth).toEqual(JUNE);

    // Two ChargeEvents emitted per charge (charge_created + charge_posted)
    expect(mockChargeEventCreate).toHaveBeenCalledTimes(2);
    const eventTypes = mockChargeEventCreate.mock.calls.map((c: unknown[]) => (c[0] as { data: { eventType: string } }).data.eventType);
    expect(eventTypes).toEqual(["charge_created", "charge_posted"]);
  });

  it("is idempotent: re-run with an existing posted chargeNumber skips and does not double-create", async () => {
    const charge100 = { toFixed: (n: number) => (100).toFixed(n) } as never;
    mockAssignmentFindMany.mockResolvedValue([{ carparkId: CARPARK, monthlyCharge: charge100 }]);
    // Existing posted charge found (second run)
    mockChargeFindFirst.mockResolvedValue({ id: CHARGE_ID, status: "posted" });

    const result = await postMonthlyCarparkForTenancy(fakeTx as never, ORG, TENANCY, JUNE, USER);

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.chargeIds).toEqual([CHARGE_ID]);

    // No new charge or events created
    expect(mockChargeCreate).not.toHaveBeenCalled();
    expect(mockChargeEventCreate).not.toHaveBeenCalled();
  });

  it("promotes an existing draft carpark charge to posted without double-creating", async () => {
    const charge100 = { toFixed: (n: number) => (100).toFixed(n) } as never;
    mockAssignmentFindMany.mockResolvedValue([{ carparkId: CARPARK, monthlyCharge: charge100 }]);
    // Auto-draft created it first; operator now clicks "Post charges"
    mockChargeFindFirst.mockResolvedValue({ id: CHARGE_ID, status: "draft" });
    mockChargeUpdateMany.mockResolvedValue({ count: 1 });

    const result = await postMonthlyCarparkForTenancy(fakeTx as never, ORG, TENANCY, JUNE, USER);

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.chargeIds).toEqual([CHARGE_ID]);

    // No duplicate charge created
    expect(mockChargeCreate).not.toHaveBeenCalled();

    // updateMany flipped draft → posted (guarded WHERE includes status:"draft")
    expect(mockChargeUpdateMany).toHaveBeenCalledOnce();
    const updateArg = mockChargeUpdateMany.mock.calls[0][0];
    expect(updateArg.where).toMatchObject({ id: CHARGE_ID, status: "draft" });
    expect(updateArg.data).toMatchObject({ status: "posted" });
    expect(updateArg.data.postedAt).toBeInstanceOf(Date);

    // charge_posted ChargeEvent emitted
    expect(mockChargeEventCreate).toHaveBeenCalledOnce();
    const eventArg = mockChargeEventCreate.mock.calls[0][0].data;
    expect(eventArg.eventType).toBe("charge_posted");
    expect(eventArg.chargeId).toBe(CHARGE_ID);
    expect(eventArg.actorUserId).toBe(USER);
  });

  it("creates no charges and returns empty result when there are no active assignments", async () => {
    mockAssignmentFindMany.mockResolvedValue([]);

    const result = await postMonthlyCarparkForTenancy(fakeTx as never, ORG, TENANCY, JUNE, USER);

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.chargeIds).toHaveLength(0);
    expect(mockChargeCreate).not.toHaveBeenCalled();
  });

  it("throws when the tenancy is not found", async () => {
    mockTenancyFindFirst.mockResolvedValue(null);
    mockAssignmentFindMany.mockResolvedValue([]);

    await expect(
      postMonthlyCarparkForTenancy(fakeTx as never, ORG, TENANCY, JUNE, USER),
    ).rejects.toThrow(`postMonthlyCarparkForTenancy: tenancy ${TENANCY} not found`);
  });
});
