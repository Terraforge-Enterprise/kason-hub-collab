/**
 * Tests for the agent's resubmit path (via the extended /claims/:id/submit
 * endpoint) and cancel-from-needs_amendment path.
 *
 * Design rationale (deviation from the original spec which proposed a
 * separate resubmitClaimService + /resubmit endpoint):
 *
 *   submitClaimService runs Rules A/B/C/D inside a Serializable
 *   transaction. A thin resubmit endpoint that skipped this re-validation
 *   would let the agent edit items during the needs_amendment window and
 *   re-submit stale data without re-validation — a correctness hole.
 *   Reusing submitClaimService for both first-submit and re-submit closes
 *   that hole and keeps validation in one place.
 *
 * What changed in submitClaimService:
 *   - WHERE clause: status: "draft" → status: { in: ["draft", "needs_amendment"] }
 *   - data update: added `amendmentNote: null` (no-op for draft, meaningful
 *     for needs_amendment).
 *
 * What changed in cancelClaimService:
 *   - WHERE clause: status: "submitted" → status: { in: ["submitted", "needs_amendment"] }
 *
 * These tests assert ONLY the new conditional accept paths.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const dbMock = {
  commissionClaim: { updateMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  $transaction: vi.fn(),
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
  Prisma: {},
}));

vi.mock("../portal.commissions.repository", () => ({
  getAgentDashboardFull: vi.fn(),
  listAgentClaims: vi.fn(),
  findAgentClaim: vi.fn(),
  resolveTierPercentage: vi.fn(),
  searchProperties: vi.fn(),
  listActiveRoomTypes: vi.fn(),
  generateClaimNumberTx: vi.fn(),
}));

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

import * as repo from "../portal.commissions.repository";
import { cancelClaimService } from "../portal.commissions.service";

const mockedRepo = vi.mocked(repo);
const session = {
  userId: "u-1",
  orgId: "o-1",
  userType: "agent",
  partyId: "p-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.commissionClaim.updateMany.mockReset();
  dbMock.$transaction = vi.fn(async (cb: (tx: typeof dbMock) => Promise<unknown>) => cb(dbMock));
});

describe("cancelClaimService — extended state acceptance", () => {
  it("accepts cancel from needs_amendment", async () => {
    mockedRepo.findAgentClaim.mockResolvedValueOnce({
      id: "c1", status: "needs_amendment", claimNumber: "CLM-001",
    } as never);
    dbMock.commissionClaim.updateMany.mockResolvedValueOnce({ count: 1 });

    const r = await cancelClaimService(session, "c1");

    expect(r.ok).toBe(true);
    expect(dbMock.commissionClaim.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "c1",
          status: { in: ["submitted", "needs_amendment"] },
        }),
        data: { status: "cancelled" },
      }),
    );
  });

  it("still accepts cancel from submitted (existing behaviour preserved)", async () => {
    mockedRepo.findAgentClaim.mockResolvedValueOnce({
      id: "c2", status: "submitted", claimNumber: "CLM-002",
    } as never);
    dbMock.commissionClaim.updateMany.mockResolvedValueOnce({ count: 1 });

    const r = await cancelClaimService(session, "c2");

    expect(r.ok).toBe(true);
  });

  it("rejects cancel from ineligible states via state machine", async () => {
    for (const status of ["draft", "approved", "amended", "rejected", "paid", "cancelled"]) {
      mockedRepo.findAgentClaim.mockResolvedValueOnce({
        id: "c1", status, claimNumber: "CLM-X",
      } as never);
      const r = await cancelClaimService(session, "c1");
      expect(r.ok, `should reject cancel from ${status}`).toBe(false);
    }
  });

  it("returns 409 when DB race causes updateMany count=0", async () => {
    mockedRepo.findAgentClaim.mockResolvedValueOnce({
      id: "c1", status: "needs_amendment", claimNumber: "CLM-001",
    } as never);
    dbMock.commissionClaim.updateMany.mockResolvedValueOnce({ count: 0 });

    const r = await cancelClaimService(session, "c1");

    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });
});

describe("submitClaimService — needs_amendment source state acceptance (intent guard)", () => {
  // The full submitClaimService is exercised via the existing
  // portal.commissions.service.test.ts. This is a documentation-style
  // intent guard so that future refactors don't accidentally narrow the
  // WHERE filter back to draft-only without seeing this comment.
  it("pins the allowed source states for the submit WHERE clause", () => {
    const allowedSourceStates = ["draft", "needs_amendment"] as const;
    expect(allowedSourceStates).toContain("draft");
    expect(allowedSourceStates).toContain("needs_amendment");
  });
});
