import { beforeEach, describe, expect, it, vi } from "vitest";
import * as repo from "../commissions.repository";

const mockActivityLogCreate = vi.fn().mockResolvedValue({});
const mockCommissionClaimUpdate = vi.fn().mockResolvedValue({});
const mockBillDelete = vi.fn().mockResolvedValue({});

const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
  cb({
    activityLog: { create: mockActivityLogCreate },
    commissionClaim: { update: mockCommissionClaimUpdate },
    commissionBill: { delete: mockBillDelete },
  }),
);

vi.mock("@kason/db", () => ({
  getDb: () => ({
    $transaction: mockTransaction,
  }),
  Prisma: {},
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

import { setClaimNeedsAmendmentService } from "../commissions.service";

const mockedRepo = vi.mocked(repo);
const session = { userId: "u1", orgId: "o1", role: "admin" as const };

const baseClaim = {
  id: "c1",
  claimNumber: "CLM-001",
  organizationId: "o1",
  agentPartyId: "a1",
  currency: "MYR",
  claimType: "rental",
  status: "submitted" as string,
  billId: null as string | null,
  approvedAt: null as Date | null,
  totalNettPayout: 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockActivityLogCreate.mockClear();
  mockCommissionClaimUpdate.mockClear();
  mockBillDelete.mockClear();
});

describe("setClaimNeedsAmendmentService — happy paths", () => {
  it("transitions submitted → needs_amendment, persists note, no bill reversal", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({ ...baseClaim, status: "submitted", billId: null } as never);

    const r = await setClaimNeedsAmendmentService(session, "c1", { note: "please attach the PDF" });

    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(mockBillDelete).not.toHaveBeenCalled();
    expect(mockCommissionClaimUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "c1" },
      data: expect.objectContaining({
        status: "needs_amendment",
        amendmentNote: "please attach the PDF",
      }),
    }));
    expect(mockActivityLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "needs_amendment" }),
    }));
  });

  it("transitions approved → needs_amendment AND reverses bill + clears approval fields", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({
      ...baseClaim, status: "approved", billId: "b1", approvedAt: new Date(),
    } as never);

    const r = await setClaimNeedsAmendmentService(session, "c1", { note: "wrong amount" });

    expect(r.ok).toBe(true);
    expect(mockBillDelete).toHaveBeenCalledWith({ where: { id: "b1" } });
    expect(mockCommissionClaimUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "c1" },
      data: expect.objectContaining({
        status: "needs_amendment",
        amendmentNote: "wrong amount",
        billId: null,
        approvedAt: null,
        approvedBy: null,
      }),
    }));
  });

  it("transitions amended → needs_amendment AND reverses bill", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({
      ...baseClaim, status: "amended", billId: "b1", approvedAt: new Date(),
    } as never);

    const r = await setClaimNeedsAmendmentService(session, "c1", { note: "needs more detail" });

    expect(r.ok).toBe(true);
    expect(mockBillDelete).toHaveBeenCalledWith({ where: { id: "b1" } });
  });

  it("trims the note before persisting", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({ ...baseClaim, status: "submitted" } as never);

    await setClaimNeedsAmendmentService(session, "c1", { note: "  fix the date  " });

    expect(mockCommissionClaimUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amendmentNote: "fix the date" }),
    }));
  });
});

describe("setClaimNeedsAmendmentService — guards", () => {
  it("404s when claim not found", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce(null as never);
    const r = await setClaimNeedsAmendmentService(session, "c1", { note: "x" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it.each(["draft", "rejected", "paid", "cancelled", "deleted", "needs_amendment"])(
    "409s for invalid source state: %s",
    async (status) => {
      mockedRepo.findClaim.mockResolvedValueOnce({ ...baseClaim, status } as never);
      const r = await setClaimNeedsAmendmentService(session, "c1", { note: "x" });
      expect(r.ok).toBe(false);
      expect(r.status).toBe(409);
    },
  );

  it("400s on empty note", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({ ...baseClaim, status: "submitted" } as never);
    const r = await setClaimNeedsAmendmentService(session, "c1", { note: "" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it("400s on whitespace-only note", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({ ...baseClaim, status: "submitted" } as never);
    const r = await setClaimNeedsAmendmentService(session, "c1", { note: "   " });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it("400s on note over 2000 chars", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({ ...baseClaim, status: "submitted" } as never);
    const r = await setClaimNeedsAmendmentService(session, "c1", { note: "x".repeat(2001) });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
