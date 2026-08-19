import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkApproveClaimsService, undoApproveClaimService, updateTierMappingService } from "../commissions.service";
import * as repo from "../commissions.repository";

const mockActivityLogCreate = vi.fn().mockResolvedValue({});
const mockPartyFindFirst = vi.fn();
const mockPartyUpdate = vi.fn();
const mockCommissionClaimAggregate = vi.fn();
const mockAgentLevelThresholdFindMany = vi.fn();
const mockCashMovementCreate = vi.fn();
const mockCommissionClaimUpdate = vi.fn();
const mockBillUpdate = vi.fn();
// Returns no outstanding balance by default (allows happy-path tests to pass through the gate).
const mockCommissionClaimItemAggregate = vi.fn().mockResolvedValue({
  _sum: { outstandingBalance: null },
  _count: { id: 0 },
});
const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
  cb({
    activityLog: { create: mockActivityLogCreate },
    party: { findFirst: mockPartyFindFirst, update: mockPartyUpdate },
    commissionClaim: { aggregate: mockCommissionClaimAggregate, update: mockCommissionClaimUpdate },
    commissionClaimItem: { aggregate: mockCommissionClaimItemAggregate },
    agentLevelThreshold: { findMany: mockAgentLevelThresholdFindMany },
    cashMovement: { create: mockCashMovementCreate },
    commissionBill: { update: mockBillUpdate },
  }),
);

const mockCashMovementFindFirst = vi.fn().mockResolvedValue(null);
vi.mock("@kason/db", () => ({
  getDb: () => ({
    activityLog: { create: mockActivityLogCreate },
    cashMovement: { findFirst: mockCashMovementFindFirst },
    commissionClaimItem: { aggregate: mockCommissionClaimItemAggregate },
    listing: { count: vi.fn().mockResolvedValue(0) },
    $transaction: mockTransaction,
  }),
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;
      constructor(message: string, { code }: { code: string }) {
        super(message);
        this.code = code;
      }
    },
  },
}));

vi.mock("../commissions.repository", () => ({
  findClaim: vi.fn(),
  findClaimsByIds: vi.fn(),
  generateBillNumber: vi.fn(),
  bulkApproveTx: vi.fn(),
  undoApproveTx: vi.fn(),
  findTierMapping: vi.fn(),
  updateTierMapping: vi.fn(),
  // New for this task:
  listTierMappings: vi.fn(),
  createTierMapping: vi.fn(),
  deleteTierMapping: vi.fn(),
  listRoomTypes: vi.fn(),
  createRoomType: vi.fn(),
  findRoomType: vi.fn(),
  updateRoomType: vi.fn(),
  deleteRoomType: vi.fn(),
  listClaims: vi.fn(),
}));

const mockedRepo = vi.mocked(repo);
const session = { userId: "u1", orgId: "o1", role: "admin" as const };

describe("bulkApproveClaimsService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all approved when every claim is in submitted status", async () => {
    mockedRepo.findClaimsByIds.mockResolvedValueOnce([
      { id: "c1", claimNumber: "CLM-001", status: "submitted", totalNettPayout: 1000, currency: "MYR", agentPartyId: "a1" },
      { id: "c2", claimNumber: "CLM-002", status: "submitted", totalNettPayout: 2000, currency: "MYR", agentPartyId: "a2" },
    ] as never);
    mockedRepo.generateBillNumber.mockResolvedValue("BIL-001");
    mockedRepo.bulkApproveTx.mockResolvedValueOnce(undefined as never);

    const res = await bulkApproveClaimsService(session, { claimIds: ["c1", "c2"] });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.approved).toEqual(["c1", "c2"]);
      expect(res.data.failed).toEqual([]);
    }
  });

  it("splits results: submitted claims approved, others failed with reason", async () => {
    mockedRepo.findClaimsByIds.mockResolvedValueOnce([
      { id: "c1", claimNumber: "CLM-001", status: "submitted", totalNettPayout: 1000, currency: "MYR", agentPartyId: "a1" },
      { id: "c2", claimNumber: "CLM-002", status: "approved", totalNettPayout: 2000, currency: "MYR", agentPartyId: "a2" },
    ] as never);
    mockedRepo.generateBillNumber.mockResolvedValue("BIL-001");
    mockedRepo.bulkApproveTx.mockResolvedValueOnce(undefined as never);

    const res = await bulkApproveClaimsService(session, { claimIds: ["c1", "c2"] });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.approved).toEqual(["c1"]);
      expect(res.data.failed).toHaveLength(1);
      expect(res.data.failed[0]).toMatchObject({
        claimId: "c2",
        reason: expect.stringContaining("submitted"),
      });
    }
  });

  it("reports missing IDs as failures with 'Claim not found'", async () => {
    mockedRepo.findClaimsByIds.mockResolvedValueOnce([
      { id: "c1", claimNumber: "CLM-001", status: "submitted", totalNettPayout: 1000, currency: "MYR", agentPartyId: "a1" },
    ] as never);
    mockedRepo.generateBillNumber.mockResolvedValue("BIL-001");
    mockedRepo.bulkApproveTx.mockResolvedValueOnce(undefined as never);

    const res = await bulkApproveClaimsService(session, { claimIds: ["c1", "cMissing"] });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.approved).toEqual(["c1"]);
      expect(res.data.failed).toHaveLength(1);
      expect(res.data.failed[0]).toMatchObject({ claimId: "cMissing", reason: expect.stringContaining("not found") });
    }
  });

  it("returns empty approved + all failed if none are valid", async () => {
    mockedRepo.findClaimsByIds.mockResolvedValueOnce([
      { id: "c1", claimNumber: "CLM-001", status: "paid", totalNettPayout: 1000, currency: "MYR", agentPartyId: "a1" },
    ] as never);

    const res = await bulkApproveClaimsService(session, { claimIds: ["c1"] });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.approved).toEqual([]);
      expect(res.data.failed).toHaveLength(1);
    }
    expect(mockedRepo.bulkApproveTx).not.toHaveBeenCalled();
  });
});

describe("undoApproveClaimService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 409 if claim is not in approved status", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({ id: "c1", status: "submitted" } as never);
    const res = await undoApproveClaimService(session, "c1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("returns 409 if claim has been paid", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({ id: "c1", status: "paid" } as never);
    const res = await undoApproveClaimService(session, "c1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("returns 404 if claim not found", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce(null as never);
    const res = await undoApproveClaimService(session, "cMissing");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  it("returns 409 if undo window expired (> 30s since approved)", async () => {
    const longAgo = new Date(Date.now() - 60_000);
    mockedRepo.findClaim.mockResolvedValueOnce({
      id: "c1",
      claimNumber: "CLM-001",
      status: "approved",
      billId: "b1",
      approvedAt: longAgo,
    } as never);
    const res = await undoApproveClaimService(session, "c1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
    if (!res.ok) expect(res.error).toContain("window");
  });

  it("succeeds within the 30s window, calling undoApproveTx", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({
      id: "c1",
      claimNumber: "CLM-001",
      status: "approved",
      billId: "b1",
      approvedAt: new Date(Date.now() - 3000),
    } as never);
    mockedRepo.undoApproveTx = vi.fn().mockResolvedValueOnce(undefined) as never;
    const res = await undoApproveClaimService(session, "c1");
    expect(res.ok).toBe(true);
    expect(mockedRepo.undoApproveTx).toHaveBeenCalledWith("o1", "u1", "c1", "b1", "CLM-001");
  });
});

// ── updateTierMappingService ─────────────────────────────────────────────────

describe("updateTierMappingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActivityLogCreate.mockResolvedValue({});
  });

  const id = "tm-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const updatedAt = "2026-04-18T10:00:00.000Z";
  const existingMapping = {
    id,
    claimType: "tenant_portion",
    agentLevel: "new_agent",
    percentage: "10",
    isActive: true,
    organizationId: "o1",
    createdAt: new Date(),
    updatedAt: new Date(updatedAt),
  };

  it("returns 404 when tier mapping is not found", async () => {
    mockedRepo.findTierMapping.mockResolvedValueOnce(null as never);

    const res = await updateTierMappingService(session, id, { updatedAt, percentage: "15" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
    expect(mockedRepo.updateTierMapping).not.toHaveBeenCalled();
  });

  it("returns 409 when updateTierMapping returns null (stale) — row still exists", async () => {
    mockedRepo.findTierMapping.mockResolvedValueOnce(existingMapping as never);
    mockedRepo.updateTierMapping.mockResolvedValueOnce(null as never);
    // delete-probe: row still exists → 409
    mockedRepo.findTierMapping.mockResolvedValueOnce(existingMapping as never);

    const res = await updateTierMappingService(session, id, { updatedAt, percentage: "15" });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.error).toContain("Record changed");
    }
  });

  it("returns 404 when updateTierMapping returns null and row was concurrently deleted", async () => {
    mockedRepo.findTierMapping.mockResolvedValueOnce(existingMapping as never);
    mockedRepo.updateTierMapping.mockResolvedValueOnce(null as never);
    // delete-probe: row is gone → 404
    mockedRepo.findTierMapping.mockResolvedValueOnce(null as never);

    const res = await updateTierMappingService(session, id, { updatedAt, percentage: "15" });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(404);
      expect(res.error).toContain("not found");
    }
  });

  it("returns ok:true with updatedAt on success", async () => {
    const freshDate = new Date("2026-04-18T10:01:00.000Z");
    mockedRepo.findTierMapping.mockResolvedValueOnce(existingMapping as never);
    mockedRepo.updateTierMapping.mockResolvedValueOnce({ updatedAt: freshDate } as never);

    const res = await updateTierMappingService(session, id, { updatedAt, percentage: "15" });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      expect(res.data.id).toBe(id);
      expect(res.data.updatedAt).toBe(freshDate.toISOString());
    }
  });

  it("passes updatedAt as expectedUpdatedAt to repo", async () => {
    const freshDate = new Date("2026-04-18T10:01:00.000Z");
    mockedRepo.findTierMapping.mockResolvedValueOnce(existingMapping as never);
    mockedRepo.updateTierMapping.mockResolvedValueOnce({ updatedAt: freshDate } as never);

    await updateTierMappingService(session, id, { updatedAt, isActive: false });

    expect(mockedRepo.updateTierMapping).toHaveBeenCalledWith(
      id,
      updatedAt,
      expect.objectContaining({ isActive: false }),
    );
  });
});

import {
  listRoomTypesService,
  createRoomTypeService,
  updateRoomTypeService,
  deleteRoomTypeService,
  listClaimsService,
  listTierMappingsService,
  getClaimDetailService,
} from "../commissions.service";

describe("RoomType services — global shape", () => {
  const session = { orgId: "o1", userId: "u1", role: "admin" as const, userType: "operator" as const };

  beforeEach(() => {
    vi.clearAllMocks();
    mockActivityLogCreate.mockResolvedValue({});
  });

  it("listRoomTypesService calls listRoomTypes with (orgId, filters) — no propertyId", async () => {
    mockedRepo.listRoomTypes.mockResolvedValueOnce([
      { id: "rt1", organizationId: "o1", name: "Master", sortOrder: 1, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    ] as never);
    const res = await listRoomTypesService(session);
    expect(res.ok).toBe(true);
    expect(mockedRepo.listRoomTypes).toHaveBeenCalledWith("o1", expect.any(Object));
  });

  it("createRoomTypeService takes { name, sortOrder?, isActive? } and emits ActivityLog (entityType=room_type, action=created)", async () => {
    mockedRepo.createRoomType.mockResolvedValueOnce({ id: "rt1" } as never);

    const res = await createRoomTypeService(session, { name: "Master", sortOrder: 2 });
    expect(res.ok).toBe(true);
    expect(mockedRepo.createRoomType).toHaveBeenCalledWith("o1", { name: "Master", sortOrder: 2, isActive: undefined });
    expect(mockActivityLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ entityType: "room_type", action: "created" }),
    }));
  });

  it("createRoomTypeService returns 409 on P2002 (duplicate name)", async () => {
    const p2002 = Object.assign(new Error("dup"), { code: "P2002" });
    // Match Prisma.PrismaClientKnownRequestError's duck shape.
    Object.setPrototypeOf(p2002, Object.getPrototypeOf(new Error()));
    mockedRepo.createRoomType.mockRejectedValueOnce(p2002);

    const res = await createRoomTypeService(session, { name: "Master" });
    // Note: the service may match by `err.code === "P2002"` OR by `instanceof Prisma.PrismaClientKnownRequestError`.
    // For this test we just confirm a non-throwing 409.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("updateRoomTypeService accepts sortOrder and emits activity (action=updated)", async () => {
    mockedRepo.findRoomType.mockResolvedValueOnce({ id: "rt1", name: "Master", sortOrder: 1, isActive: true } as never);
    mockedRepo.updateRoomType.mockResolvedValueOnce({} as never);

    const res = await updateRoomTypeService(session, "rt1", { sortOrder: 9 });
    expect(res.ok).toBe(true);
    expect(mockedRepo.updateRoomType).toHaveBeenCalledWith("rt1", { sortOrder: 9 });
    expect(mockActivityLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ entityType: "room_type", action: "updated" }),
    }));
  });

  it("deleteRoomTypeService emits activity (action=deleted)", async () => {
    mockedRepo.findRoomType.mockResolvedValueOnce({ id: "rt1", name: "Master", sortOrder: 1, isActive: true } as never);
    mockedRepo.deleteRoomType.mockResolvedValueOnce({} as never);

    const res = await deleteRoomTypeService(session, "rt1");
    expect(res.ok).toBe(true);
    expect(mockActivityLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ entityType: "room_type", action: "deleted" }),
    }));
  });
});

describe("listClaimsService — sort + search", () => {
  const session = { orgId: "o1", userId: "u1", role: "admin" as const, userType: "operator" as const };

  beforeEach(() => {
    vi.clearAllMocks();
    mockActivityLogCreate.mockResolvedValue({});
  });

  it("passes sort=newest and search through to the repo", async () => {
    mockedRepo.listClaims.mockResolvedValueOnce({ data: [], page: 1, limit: 50, total: 0 });
    await listClaimsService(session, { sort: "newest", search: "CLM-2026" });
    expect(mockedRepo.listClaims).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ sort: "newest", search: "CLM-2026" }),
      "admin",
    );
  });

  it("supports dateField=salesDate to filter items by salesDate", async () => {
    mockedRepo.listClaims.mockResolvedValueOnce({ data: [], page: 1, limit: 50, total: 0 });
    await listClaimsService(session, { dateField: "salesDate", dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    expect(mockedRepo.listClaims).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({
        dateField: "salesDate",
        dateFrom: "2026-01-01",
        dateTo: "2026-12-31",
      }),
      "admin",
    );
  });
});

describe("listTierMappingsService — sort + search + claimType filter", () => {
  const session = { orgId: "o1", userId: "u1", role: "admin" as const, userType: "operator" as const };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes filters through to the repo", async () => {
    mockedRepo.listTierMappings.mockResolvedValueOnce([] as never);
    await listTierMappingsService(session, { sort: "created", order: "desc", search: "leader", claimType: "tenant_portion" });
    expect(mockedRepo.listTierMappings).toHaveBeenCalledWith("o1", expect.objectContaining({
      sort: "created",
      order: "desc",
      search: "leader",
      claimType: "tenant_portion",
    }));
  });
});

describe("getClaimDetailService — remark field", () => {
  const session = { orgId: "o1", userId: "u1", role: "admin" as const, userType: "operator" as const };

  beforeEach(() => { vi.clearAllMocks(); });

  it("includes remark on each item (null when absent)", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({
      id: "c1", claimNumber: "CLM-1", status: "submitted", currency: "MYR", claimType: "tenant_portion",
      totalNettPayout: 100, submittedAt: null, approvedAt: null, paidAt: null,
      agent: { displayName: "A", primaryEmail: null, primaryPhone: null, bankName: null, bankAccountHolder: null, bankAccountNumber: null },
      items: [
        { id: "i1", condoName: "C", unitCode: "U", roomType: "Master", tenantName: "T",
          salesDate: new Date(), moveInDate: new Date(), monthlyRental: 1000,
          agentTierPercentage: 40, commissionPercentage: 50,
          tenancyChargesByAgent: 500, tenancyChargesByKaen: 216, numberOfPax: null, nettPayout: 100,
          remark: "tenant moved in early" },
        { id: "i2", condoName: "C", unitCode: "V", roomType: "Small", tenantName: "T2",
          salesDate: new Date(), moveInDate: new Date(), monthlyRental: 900,
          agentTierPercentage: 40, commissionPercentage: 50,
          tenancyChargesByAgent: 500, tenancyChargesByKaen: 216, numberOfPax: null, nettPayout: 90,
          remark: null },
      ],
    } as never);

    const res = await getClaimDetailService(session, "c1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Admin role → full shape including items.
      expect("items" in res.data).toBe(true);
      const full = res.data as typeof res.data & {
        items: Array<{ remark: string | null }>;
      };
      expect(full.items[0].remark).toBe("tenant moved in early");
      expect(full.items[1].remark).toBeNull();
    }
  });
});

describe("getClaimDetailService — tenant contact fields", () => {
  // Mirrors portal getClaimService projection so the admin claim-detail page's
  // Tenant Profile card and formattedTenantPhone render with real data instead
  // of being silently empty (B1 + Chunk H gap).
  const session = { orgId: "o1", userId: "u1", role: "admin" as const, userType: "operator" as const };

  beforeEach(() => { vi.clearAllMocks(); });

  it("returns tenant contact fields with phone normalized + formatted", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({
      id: "c1", claimNumber: "CLM-1", status: "submitted", currency: "MYR", claimType: "tenant_portion",
      totalNettPayout: 100, submittedAt: null, approvedAt: null, paidAt: null,
      agent: { displayName: "A", primaryEmail: null, primaryPhone: null, bankName: null, bankAccountHolder: null, bankAccountNumber: null },
      items: [
        { id: "i1", condoName: "C", unitCode: "U", roomType: "Master", tenantName: "T",
          salesDate: new Date(), moveInDate: new Date(), monthlyRental: 1000,
          agentTierPercentage: 40, commissionPercentage: 50,
          tenancyChargesByAgent: 500, tenancyChargesByKaen: 216, numberOfPax: null, nettPayout: 100,
          remark: null,
          tenantEmail: "tenant@example.com",
          tenantPhone: "+60 12-345 6789",
          tenantLinkedinUrl: "https://linkedin.com/in/tenant",
          tenantInstagramHandle: "tenant_ig",
          tenantJobPosition: "Engineer" },
        { id: "i2", condoName: "C", unitCode: "V", roomType: "Small", tenantName: "T2",
          salesDate: new Date(), moveInDate: new Date(), monthlyRental: 900,
          agentTierPercentage: 40, commissionPercentage: 50,
          tenancyChargesByAgent: 500, tenancyChargesByKaen: 216, numberOfPax: null, nettPayout: 90,
          remark: null,
          tenantEmail: null,
          tenantPhone: null,
          tenantLinkedinUrl: null,
          tenantInstagramHandle: null,
          tenantJobPosition: null },
      ],
    } as never);

    const res = await getClaimDetailService(session, "c1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const full = res.data as typeof res.data & {
        items: Array<{
          tenantEmail: string | null;
          tenantPhone: string | null;
          formattedTenantPhone: string | null;
          tenantLinkedinUrl: string | null;
          tenantInstagramHandle: string | null;
          tenantJobPosition: string | null;
        }>;
      };
      expect(full.items[0]).toMatchObject({
        tenantEmail: "tenant@example.com",
        tenantPhone: "60123456789",
        formattedTenantPhone: "+60 12-345 6789",
        tenantLinkedinUrl: "https://linkedin.com/in/tenant",
        tenantInstagramHandle: "tenant_ig",
        tenantJobPosition: "Engineer",
      });
      expect(full.items[1]).toMatchObject({
        tenantEmail: null,
        tenantPhone: null,
        formattedTenantPhone: null,
        tenantLinkedinUrl: null,
        tenantInstagramHandle: null,
        tenantJobPosition: null,
      });
    }
  });
});

import Decimal from "decimal.js";
import { payClaimService } from "../commissions.service";

describe("payClaimService — auto-upgrade integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: approved claim found.
    mockedRepo.findClaim.mockResolvedValue({
      id: "c1",
      claimNumber: "CLM-001",
      status: "approved",
      totalNettPayout: new Decimal("1000"),
      currency: "MYR",
      agentPartyId: "a1",
      organizationId: "o1",
      billId: null,
    } as never);

    // cashMovement + commissionClaim update stubs so the tx doesn't crash.
    mockCashMovementCreate.mockResolvedValue({ id: "cm1", movementNumber: "CM-0001" });
    mockCommissionClaimUpdate.mockResolvedValue({});

    // Auto-upgrade helper's queries:
    mockPartyFindFirst.mockResolvedValue({
      id: "a1", displayName: "Agent One", agentLevel: "new_agent",
    });
    mockAgentLevelThresholdFindMany.mockResolvedValue([
      { agentLevel: "leader",     minCumulativeCommission: new Decimal("20000") },
      { agentLevel: "pre_leader", minCumulativeCommission: new Decimal("10000") },
      { agentLevel: "new_agent",  minCumulativeCommission: new Decimal("0") },
    ]);
  });

  it("promotes when cumulative crosses threshold", async () => {
    mockCommissionClaimAggregate.mockResolvedValue({ _sum: { totalNettPayout: new Decimal("10500") } });

    const res = await payClaimService(
      { orgId: "o1", userId: "u1", role: "admin" } as never,
      "c1",
      { movementDate: "2026-04-20", paymentTender: "bank_transfer" },
    );

    expect(res.ok).toBe(true);
    expect(mockPartyUpdate).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { agentLevel: "pre_leader" },
    });
    // One log for claim "paid", one log for "agent_level_auto_upgraded".
    expect(mockActivityLogCreate).toHaveBeenCalledTimes(2);
    const actions = mockActivityLogCreate.mock.calls.map((c) => c[0].data.action);
    expect(actions).toContain("agent_level_auto_upgraded");
  });

  it("does not touch Party.agentLevel when cumulative stays below threshold", async () => {
    mockCommissionClaimAggregate.mockResolvedValue({ _sum: { totalNettPayout: new Decimal("500") } });

    const res = await payClaimService(
      { orgId: "o1", userId: "u1", role: "admin" } as never,
      "c1",
      { movementDate: "2026-04-20", paymentTender: "bank_transfer" },
    );

    expect(res.ok).toBe(true);
    expect(mockPartyUpdate).not.toHaveBeenCalled();
    const actions = mockActivityLogCreate.mock.calls.map((c) => c[0].data.action);
    expect(actions).not.toContain("agent_level_auto_upgraded");
  });
});
