import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for `reApproveClaimService` — manager+ POST that flips a claim
 * from `amended` → `approved`. Pattern mirrors commissions.service.test.ts:
 *
 *  - Mock `@kason/db` with a `$transaction` that invokes the callback with a
 *    tx stub carrying `commissionClaim.update` + `auditLog.create`.
 *  - Mock the repository (`findClaim`) so each test can fix the starting
 *    state.
 *  - Assert the state-machine gate (forbidden_transition) when source ≠
 *    amended.
 *  - Assert the happy-path writes a `claim.re-approve` audit row.
 */

const mockAuditLogCreate = vi.fn().mockResolvedValue({ id: "audit-1" });
const mockCommissionClaimUpdate = vi.fn().mockResolvedValue({ id: "c1", status: "approved" });
// Returns no outstanding balance by default so happy-path tests pass through the gate.
const mockCommissionClaimItemAggregate = vi.fn().mockResolvedValue({
  _sum: { outstandingBalance: null },
  _count: { id: 0 },
});

const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
  cb({
    auditLog: { create: mockAuditLogCreate },
    commissionClaim: { update: mockCommissionClaimUpdate },
    commissionClaimItem: { aggregate: mockCommissionClaimItemAggregate },
  }),
);

vi.mock("@kason/db", () => ({
  getDb: () => ({
    $transaction: mockTransaction,
    commissionClaimItem: { aggregate: mockCommissionClaimItemAggregate },
  }),
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {
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

import * as repo from "../commissions.repository";
import { reApproveClaimService } from "../commissions.service";

const mockedRepo = vi.mocked(repo);

const adminSession = { userId: "u-admin", orgId: "o1", role: "admin" as const };
const managerSession = { userId: "u-mgr", orgId: "o1", role: "manager" as const };

function claimRow(status: string) {
  return {
    id: "c1",
    claimNumber: "CLM-2026-0001",
    status,
    organizationId: "o1",
    agentPartyId: "a1",
    totalNettPayout: 1000,
    currency: "MYR",
  };
}

describe("reApproveClaimService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy path: amended → approved for ADMIN ────────────────────────────
  it("re-approves an amended claim as admin and writes a claim.re-approve audit row", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce(claimRow("amended") as never);

    const res = await reApproveClaimService(adminSession, "c1", {
      ip: "1.2.3.4",
      userAgent: "unit-test",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ id: "c1" });
    }
    expect(mockCommissionClaimUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: expect.objectContaining({
        status: "approved",
        approvedBy: adminSession.userId,
      }),
    });
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const auditArg = mockAuditLogCreate.mock.calls[0]![0] as {
      data: { action: string; entityType: string; entityId: string; actorRole: string; diff: unknown };
    };
    expect(auditArg.data.action).toBe("claim.re-approve");
    expect(auditArg.data.entityType).toBe("CommissionClaim");
    expect(auditArg.data.entityId).toBe("c1");
    expect(auditArg.data.actorRole).toBe("admin");
    expect(auditArg.data.diff).toEqual({
      before: { status: "amended" },
      after: { status: "approved" },
    });
  });

  // ── Happy path: amended → approved for MANAGER ──────────────────────────
  it("re-approves an amended claim as manager and writes a claim.re-approve audit row", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce(claimRow("amended") as never);

    const res = await reApproveClaimService(managerSession, "c1");

    expect(res.ok).toBe(true);
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const auditArg = mockAuditLogCreate.mock.calls[0]![0] as {
      data: { actorRole: string; action: string };
    };
    expect(auditArg.data.actorRole).toBe("manager");
    expect(auditArg.data.action).toBe("claim.re-approve");
  });

  // ── submitted source → forbidden_transition (wrong starting state) ──────
  it("rejects re-approve when the claim is in submitted status", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce(claimRow("submitted") as never);

    const res = await reApproveClaimService(adminSession, "c1");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      const errObj = res.error as { code: string; from: string; to: string };
      expect(errObj.code).toBe("forbidden_transition");
      expect(errObj.from).toBe("submitted");
      expect(errObj.to).toBe("approved");
    }
    // No tx side-effects when the gate trips.
    expect(mockCommissionClaimUpdate).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
  });

  // ── already-approved → forbidden_transition ─────────────────────────────
  it("rejects re-approve when the claim is already approved", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce(claimRow("approved") as never);

    const res = await reApproveClaimService(adminSession, "c1");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      const errObj = res.error as { code: string; from: string };
      expect(errObj.code).toBe("forbidden_transition");
      expect(errObj.from).toBe("approved");
    }
    expect(mockCommissionClaimUpdate).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
  });

  // ── missing claim → 404 ─────────────────────────────────────────────────
  it("returns 404 when the claim does not exist", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce(null as never);

    const res = await reApproveClaimService(adminSession, "c-nope");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
    expect(mockCommissionClaimUpdate).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
  });
});
