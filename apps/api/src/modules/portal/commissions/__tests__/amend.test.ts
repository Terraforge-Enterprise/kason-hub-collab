import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/client";

/**
 * Unit tests for `amendClaimService` — agent-only PATCH that flips a claim
 * from `approved` → `amended` (first edit) or `amended` → `amended` (further
 * edits). Pattern mirrors the existing portal.commissions.service.test.ts:
 *
 *  - Mock `@kason/db` with a mutable `dbMock` shape.
 *  - Mock the repository (`findAgentClaim`, `resolveTierPercentage`) so each
 *    test starts the claim in a specific status.
 *  - Assert the state-machine gate (forbidden_transition) when the source
 *    status is not in {approved, amended}.
 *  - Assert the happy-path produces a status=amended return plus an audit
 *    row via `tx.auditLog.create` with action="claim.amend".
 */

// ── DB mock ─────────────────────────────────────────────────────────────────
const dbMock: {
  commissionClaim: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  commissionClaimItem: {
    deleteMany: ReturnType<typeof vi.fn>;
  };
  party: { findFirst: ReturnType<typeof vi.fn> };
  property: { findMany: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
} = {
  commissionClaim: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  commissionClaimItem: {
    deleteMany: vi.fn(),
  },
  party: { findFirst: vi.fn() },
  property: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
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

import * as repo from "../portal.commissions.repository";
import { amendClaimService } from "../portal.commissions.service";

const mockedRepo = vi.mocked(repo);

const session = {
  userId: "u-11111111-1111-4111-8111-111111111111",
  orgId: "11111111-1111-4111-8111-111111111111",
  userType: "agent",
  partyId: "22222222-2222-4222-8222-222222222222",
};

// Minimal claim row + items shape matching what `findAgentClaim` returns
// (include items with Decimal fields as real Decimal instances so the
// service's `.toString()` diffs serialize cleanly).
function baseClaim(status: string) {
  return {
    id: "c-amend-1",
    claimNumber: "CLM-2026-0001",
    organizationId: session.orgId,
    agentPartyId: session.partyId,
    status,
    claimType: "tenant_portion",
    totalNettPayout: new Decimal("1000.00"),
    items: [
      {
        id: "i1",
        propertyId: "33333333-3333-4333-8333-333333333333",
        condoName: "Seri Kembangan Heights",
        unitCode: "A-08-02",
        roomType: "Master",
        tenantName: "Alice",
        salesDate: new Date("2026-04-19"),
        moveInDate: new Date("2026-04-20"),
        monthlyRental: new Decimal("2000.00"),
        agentTierPercentage: new Decimal("40"),
        commissionPercentage: new Decimal("70"),
        tenancyChargesByAgent: new Decimal("0"),
        tenancyChargesByKaen: new Decimal("0"),
        numberOfPax: null as number | null,
        remark: null as string | null,
        nettPayout: new Decimal("560.00"),
        createdAt: new Date("2026-04-20T10:00:00Z"),
        property: { id: "33333333-3333-4333-8333-333333333333", hasPaxDeduction: false, paxDeductionAmount: null },
      },
    ],
    createdAt: new Date("2026-04-20T10:00:00Z"),
  };
}

describe("amendClaimService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default `$transaction` passes the dbMock itself as `tx` — the service's
    // `tx.commissionClaim.update` hits the same mock surface.
    dbMock.$transaction = vi.fn(async (cb: (tx: typeof dbMock) => Promise<unknown>) => cb(dbMock));
    dbMock.commissionClaim.update.mockResolvedValue({ id: "c-amend-1", status: "amended" });
    dbMock.commissionClaimItem.deleteMany.mockResolvedValue({ count: 1 });
    dbMock.auditLog.create.mockResolvedValue({ id: "audit-1" });
    // For the AFTER re-fetch inside the tx — return a plausible shape so the
    // audit row serializer doesn't crash on undefined.items.
    dbMock.commissionClaim.findFirst.mockResolvedValue({
      id: "c-amend-1",
      status: "amended",
      claimType: "tenant_portion",
      totalNettPayout: new Decimal("1000.00"),
      items: [],
    });
  });

  // ── approved → amended (happy path) ──────────────────────────────────────
  it("flips an approved claim to amended and writes a claim.amend audit row", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue(baseClaim("approved") as never);

    const res = await amendClaimService(session, "c-amend-1", {}, {
      ip: "1.2.3.4",
      userAgent: "unit-test",
      actorRole: "agent",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ id: "c-amend-1", status: "amended" });
    }
    // Status flip happened.
    expect(dbMock.commissionClaim.update).toHaveBeenCalledWith({
      where: { id: "c-amend-1" },
      data: { status: "amended" },
    });
    // Audit row written with the right action + entity.
    expect(dbMock.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = dbMock.auditLog.create.mock.calls[0]![0] as {
      data: { action: string; entityType: string; entityId: string; actorUserId: string; actorRole: string };
    };
    expect(auditArg.data.action).toBe("claim.amend");
    expect(auditArg.data.entityType).toBe("CommissionClaim");
    expect(auditArg.data.entityId).toBe("c-amend-1");
    expect(auditArg.data.actorUserId).toBe(session.userId);
    expect(auditArg.data.actorRole).toBe("agent");
  });

  // ── submitted → amended (forbidden_transition) ───────────────────────────
  it("refuses amend on a submitted claim with forbidden_transition (403)", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue(baseClaim("submitted") as never);

    const res = await amendClaimService(session, "c-amend-1", {});

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      const errObj = res.error as unknown as { code: string; from: string; to: string };
      expect(errObj.code).toBe("forbidden_transition");
      expect(errObj.from).toBe("submitted");
      expect(errObj.to).toBe("amended");
    }
    // No write side-effects.
    expect(dbMock.commissionClaim.update).not.toHaveBeenCalled();
    expect(dbMock.auditLog.create).not.toHaveBeenCalled();
  });

  // ── paid → amended (forbidden_transition, terminal state) ────────────────
  it("refuses amend on a paid claim with forbidden_transition (403)", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue(baseClaim("paid") as never);

    const res = await amendClaimService(session, "c-amend-1", {});

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      const errObj = res.error as unknown as { code: string; from: string };
      expect(errObj.code).toBe("forbidden_transition");
      expect(errObj.from).toBe("paid");
    }
    expect(dbMock.commissionClaim.update).not.toHaveBeenCalled();
    expect(dbMock.auditLog.create).not.toHaveBeenCalled();
  });

  // ── amended → amended (further edits before re-approval) ─────────────────
  it("allows amending an already-amended claim (further edits before re-approval)", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue(baseClaim("amended") as never);

    const res = await amendClaimService(session, "c-amend-1", {});

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.status).toBe("amended");
    expect(dbMock.commissionClaim.update).toHaveBeenCalledWith({
      where: { id: "c-amend-1" },
      data: { status: "amended" },
    });
    expect(dbMock.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = dbMock.auditLog.create.mock.calls[0]![0] as { data: { action: string } };
    expect(auditArg.data.action).toBe("claim.amend");
  });

  // ── Audit diff fidelity — items[] entries omit the volatile `id` field ───
  // Items are deleted-and-recreated on each amend, so every amend changes
  // the item UUIDs. If the audit snapshot includes those UUIDs, every diff
  // shows a noisy "id changed" line even when nothing functional moved.
  // Use a logical key (propertyId + unitCode + roomType + moveInDate) for
  // identity instead.
  it("omits the per-item `id` field from before and after audit snapshots", async () => {
    mockedRepo.findAgentClaim.mockResolvedValue(baseClaim("approved") as never);
    dbMock.commissionClaim.findFirst.mockResolvedValue({
      id: "c-amend-1",
      status: "amended",
      claimType: "tenant_portion",
      totalNettPayout: new Decimal("1000.00"),
      items: [
        {
          id: "new-uuid-after-recreate",
          propertyId: "33333333-3333-4333-8333-333333333333",
          condoName: "Seri Kembangan Heights",
          unitCode: "A-08-02",
          roomType: "Master",
          tenantName: "Alice",
          salesDate: new Date("2026-04-19"),
          moveInDate: new Date("2026-04-20"),
          moveOutDate: null,
          monthlyRental: new Decimal("2000.00"),
          agentTierPercentage: new Decimal("40"),
          commissionPercentage: new Decimal("70"),
          tenancyChargesByAgent: new Decimal("0"),
          tenancyChargesByKaen: new Decimal("0"),
          numberOfPax: null,
          remark: null,
          nettPayout: new Decimal("560.00"),
        },
      ],
    });

    await amendClaimService(session, "c-amend-1", {});

    expect(dbMock.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = dbMock.auditLog.create.mock.calls[0]![0] as {
      data: { diff: { before: { items: Array<Record<string, unknown>> }; after: { items?: Array<Record<string, unknown>> } } };
    };
    const beforeItem = auditArg.data.diff.before.items[0]!;
    const afterItem = auditArg.data.diff.after.items![0]!;
    expect(beforeItem).toBeDefined();
    expect(afterItem).toBeDefined();
    expect("id" in beforeItem).toBe(false);
    expect("id" in afterItem).toBe(false);
    // Logical key fields still present — these are what the diff reader uses
    // to match BEFORE rows to AFTER rows.
    expect(beforeItem.unitCode).toBe("A-08-02");
    expect(beforeItem.roomType).toBe("Master");
    expect(afterItem.unitCode).toBe("A-08-02");
    expect(afterItem.roomType).toBe("Master");
  });

  // ── Ownership — claim not owned by agent → 404 ───────────────────────────
  it("returns 404 when the claim does not belong to the calling agent", async () => {
    // findAgentClaim is scoped by agentPartyId in the repository; returning
    // null simulates the row existing but owned by a different agent (or
    // not existing at all — same shape).
    mockedRepo.findAgentClaim.mockResolvedValue(null as never);

    const res = await amendClaimService(session, "c-someone-elses", {});

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
    expect(dbMock.commissionClaim.update).not.toHaveBeenCalled();
    expect(dbMock.auditLog.create).not.toHaveBeenCalled();
  });
});
