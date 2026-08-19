import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../sales-claims.repository", () => ({
  listClaims: vi.fn(async () => []),
  findClaimById: vi.fn(async () => null),
  findClaimByIdTx: vi.fn(async () => null),
  findFullClaimByIdTx: vi.fn(async () => null),
  createClaimRow: vi.fn(),
  updateClaimRow: vi.fn(),
  appendClaimTransition: vi.fn(async () => undefined),
  findSalesUnitForClaim: vi.fn(async () => null),
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
    cb({
      // No tx.* methods are called directly; service goes through repo mocks.
    }),
  ),
}));

import { recordAudit } from "../../../lib/audit";
import {
  appendClaimTransition,
  createClaimRow,
  findClaimById,
  findFullClaimByIdTx,
  findSalesUnitForClaim,
  listClaims,
  updateClaimRow,
} from "../sales-claims.repository";
import {
  approveClaimService,
  createClaimService,
  getClaimByIdService,
  listClaimsService,
  needsAmendmentClaimService,
  rejectClaimService,
  updateClaimService,
} from "../sales-claims.service";
import type { SalesClaimRow } from "../sales-claims.types";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";
const AGENT = "00000000-0000-0000-0000-0000000000aa";
const SALES = "00000000-0000-0000-0000-0000000000bb";
const CLAIM = "00000000-0000-0000-0000-0000000000dd";
// 1,000,000 × 2.5% = 25,000 — used as the canonical computedAmount in fixtures.
const PURCHASE_PRICE = 1_000_000;
const COMPUTED = 25_000;

function fakeClaim(overrides: Partial<SalesClaimRow> = {}): SalesClaimRow {
  return {
    id: CLAIM,
    organizationId: ORG,
    salesUnitId: SALES,
    commissionType: "percent_of_purchase",
    commissionValue: 2.5,
    computedAmount: COMPUTED,
    paymentType: "full",
    status: "submitted",
    notes: null,
    submittedAt: new Date("2026-04-01T00:00:00.000Z"),
    submittedById: USER,
    reviewedAt: null,
    reviewedById: null,
    reviewerNote: null,
    splits: [
      {
        id: "s-1",
        organizationId: ORG,
        claimId: CLAIM,
        partyPartyId: AGENT,
        partyDisplayName: "Agent A",
        roleLabel: "Sales Commission",
        splitType: "percent",
        splitValue: 60,
        sortOrder: 0,
      },
      {
        id: "s-2",
        organizationId: ORG,
        claimId: CLAIM,
        partyPartyId: null,
        partyDisplayName: "Co-broke",
        roleLabel: "Co-broke Override",
        splitType: "percent",
        splitValue: 40,
        sortOrder: 1,
      },
    ],
    ...overrides,
  };
}

function ctx(role: "admin" | "manager" | "editor" = "manager") {
  return {
    orgId: ORG,
    actorUserId: USER,
    actorRole: role,
    ip: "10.0.0.1",
    userAgent: "vitest",
  } as const;
}

function baseCreateClaimInput() {
  return {
    salesUnitId: SALES,
    commissionType: "percent_of_purchase" as const,
    commissionValue: 2.5,
    paymentType: "full" as const,
    notes: null,
    splits: [
      {
        partyPartyId: AGENT,
        partyDisplayName: "Agent A",
        roleLabel: "Sales Commission",
        splitType: "percent" as const,
        splitValue: 60,
        sortOrder: 0,
      },
      {
        partyPartyId: null,
        partyDisplayName: "Co-broke",
        roleLabel: "Co-broke Override",
        splitType: "percent" as const,
        splitValue: 40,
        sortOrder: 1,
      },
    ],
  };
}

// ─── Claims (list — role-aware) ─────────────────────────────────────────────

describe("listClaimsService — role-aware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor 200; calls listClaims with role=editor (so repo strips $)", async () => {
    vi.mocked(listClaims).mockResolvedValueOnce([]);
    const r = await listClaimsService(ctx("editor"), {});
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(listClaims).toHaveBeenCalledWith(
      ORG,
      "editor",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("manager passes role=manager", async () => {
    vi.mocked(listClaims).mockResolvedValueOnce([fakeClaim()]);
    await listClaimsService(ctx("manager"), {});
    expect(listClaims).toHaveBeenCalledWith(
      ORG,
      "manager",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("forwards portal-side own-only filter via submittedByEq", async () => {
    vi.mocked(listClaims).mockResolvedValueOnce([]);
    await listClaimsService(ctx("editor"), { submittedByEq: USER });
    expect(listClaims).toHaveBeenCalledWith(
      ORG,
      "editor",
      expect.objectContaining({ submittedByEq: USER }),
      expect.any(Object),
    );
  });

  it("forwards forceFullSelect: true to repository (portal own-only)", async () => {
    vi.mocked(listClaims).mockResolvedValueOnce([]);
    await listClaimsService(
      ctx("editor"),
      { submittedByEq: USER },
      { forceFullSelect: true },
    );
    expect(listClaims).toHaveBeenCalledWith(
      ORG,
      "editor",
      expect.any(Object),
      expect.objectContaining({ forceFullSelect: true }),
    );
  });
});

describe("getClaimByIdService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when missing", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(null);
    const r = await getClaimByIdService(ctx("manager"), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("portal own-only: 404 when claim belongs to another agent", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim({ submittedById: "other" }));
    const r = await getClaimByIdService(ctx("editor"), CLAIM, {
      requireSubmittedById: USER,
    });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("happy: returns claim", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    const r = await getClaimByIdService(ctx("manager"), CLAIM);
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("forwards forceFullSelect: true to repository (portal own-only)", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    const r = await getClaimByIdService(ctx("editor"), CLAIM, {
      requireSubmittedById: USER,
      forceFullSelect: true,
    });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(findClaimById).toHaveBeenCalledWith(
      ORG,
      "editor",
      CLAIM,
      expect.objectContaining({ forceFullSelect: true }),
    );
  });
});

// ─── Claims (submit) ────────────────────────────────────────────────────────

describe("createClaimService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when sales unit missing", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce(null);
    const r = await createClaimService(ctx(), baseCreateClaimInput());
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("portal own-only: 404 when sales unit belongs to another agent", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: "someone-else",
      purchasePrice: PURCHASE_PRICE,
    });
    const r = await createClaimService(
      ctx("editor"),
      baseCreateClaimInput(),
      { requireSalesUnitOwnerPartyId: AGENT },
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(createClaimRow).not.toHaveBeenCalled();
  });

  it("400 when splits don't sum to computedAmount", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
      purchasePrice: PURCHASE_PRICE,
    });
    const input = baseCreateClaimInput();
    input.splits[0].splitValue = 50; // total 90% → 22500, off by 2500
    const r = await createClaimService(ctx(), input);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(createClaimRow).not.toHaveBeenCalled();
  });

  it("computes commissionAmount: percent_of_purchase 1m × 2.5% = 25,000", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
      purchasePrice: PURCHASE_PRICE,
    });
    const created = fakeClaim();
    vi.mocked(createClaimRow).mockResolvedValueOnce(created);
    const r = await createClaimService(ctx(), baseCreateClaimInput());
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(createClaimRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        commissionType: "percent_of_purchase",
        commissionValue: 2.5,
        computedAmount: 25_000,
      }),
    );
  });

  it("computes commissionAmount: fixed 30,000 → 30,000 (ignores purchasePrice)", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
      purchasePrice: PURCHASE_PRICE,
    });
    vi.mocked(createClaimRow).mockResolvedValueOnce(
      fakeClaim({ commissionType: "fixed", commissionValue: 30_000, computedAmount: 30_000 }),
    );
    const r = await createClaimService(ctx(), {
      salesUnitId: SALES,
      commissionType: "fixed",
      commissionValue: 30_000,
      paymentType: "full",
      notes: null,
      splits: [
        {
          partyPartyId: AGENT,
          partyDisplayName: "Agent A",
          roleLabel: "Sales Commission",
          splitType: "percent",
          splitValue: 100,
          sortOrder: 0,
        },
      ],
    });
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(createClaimRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        commissionType: "fixed",
        commissionValue: 30_000,
        computedAmount: 30_000,
      }),
    );
  });

  it("happy: creates claim + transition + audit", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
      purchasePrice: PURCHASE_PRICE,
    });
    const created = fakeClaim();
    vi.mocked(createClaimRow).mockResolvedValueOnce(created);
    const r = await createClaimService(ctx(), baseCreateClaimInput(), {
      auditAction: "sales.claim.create.portal",
    });
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(appendClaimTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromStatus: null, toStatus: "submitted" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.claim.create.portal" }),
    );
  });

  it("default audit action when not overridden", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
      purchasePrice: PURCHASE_PRICE,
    });
    vi.mocked(createClaimRow).mockResolvedValueOnce(fakeClaim());
    await createClaimService(ctx(), baseCreateClaimInput());
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.claim.create" }),
    );
  });
});

// ─── Claims (edit) ──────────────────────────────────────────────────────────

describe("updateClaimService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when missing", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(null);
    const r = await updateClaimService(ctx(), CLAIM, { notes: "x" });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("portal own-only: 404 for non-owner", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({ submittedById: "other" }),
    );
    const r = await updateClaimService(
      ctx("editor"),
      CLAIM,
      { notes: "x" },
      { requireSubmittedById: USER },
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("admin path: editor 403", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    const r = await updateClaimService(ctx("editor"), CLAIM, { notes: "x" });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("400 when split rule violated on edit", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    const r = await updateClaimService(ctx(), CLAIM, {
      splits: [
        {
          partyPartyId: null,
          partyDisplayName: "X",
          roleLabel: "X",
          splitType: "percent",
          splitValue: 50, // 50% of 25k = 12500, doesn't sum
          sortOrder: 0,
        },
      ],
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("recomputes computedAmount when commission fields change", async () => {
    const before = fakeClaim();
    vi.mocked(findClaimById).mockResolvedValueOnce(before);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(before);
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
      purchasePrice: PURCHASE_PRICE,
    });
    vi.mocked(updateClaimRow).mockResolvedValueOnce(
      fakeClaim({ commissionValue: 3, computedAmount: 30_000 }),
    );

    // Change commissionValue to 3% → newComputed = 30,000. Provide splits
    // that sum to 30,000.
    const r = await updateClaimService(ctx(), CLAIM, {
      commissionValue: 3,
      splits: [
        {
          partyPartyId: AGENT,
          partyDisplayName: "Agent A",
          roleLabel: "Sales Commission",
          splitType: "fixed",
          splitValue: 30_000,
          sortOrder: 0,
        },
      ],
    });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(updateClaimRow).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      ORG,
      expect.objectContaining({ computedAmount: 30_000 }),
    );
  });

  it("400 when splits no longer match recomputed amount (fixed splits)", async () => {
    // Existing splits are fixed RM 25,000 against computed 25,000. If commission
    // bumps to 3% → recomputed = 30,000 but the fixed splits still sum to
    // 25,000 → must reject.
    const fixedClaim = fakeClaim({
      splits: [
        {
          id: "s",
          organizationId: ORG,
          claimId: CLAIM,
          partyPartyId: AGENT,
          partyDisplayName: "Agent A",
          roleLabel: "Sales Commission",
          splitType: "fixed",
          splitValue: 25_000,
          sortOrder: 0,
        },
      ],
    });
    vi.mocked(findClaimById).mockResolvedValueOnce(fixedClaim);
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
      purchasePrice: PURCHASE_PRICE,
    });
    const r = await updateClaimService(ctx(), CLAIM, { commissionValue: 3 });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(updateClaimRow).not.toHaveBeenCalled();
  });

  it("edit-after-approval rebound: PATCH on approved → needs_amendment + transition", async () => {
    const before = fakeClaim({ status: "approved" });
    vi.mocked(findClaimById).mockResolvedValueOnce(before);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(before);
    const after = fakeClaim({
      status: "needs_amendment",
      reviewerNote: "Edited by agent post-approval",
    });
    vi.mocked(updateClaimRow).mockResolvedValueOnce(after);

    const r = await updateClaimService(
      ctx("editor"),
      CLAIM,
      { notes: "edit" },
      {
        requireSubmittedById: USER,
        rebindOnApproval: true,
        auditAction: "sales.claim.update.portal",
      },
    );
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(updateClaimRow).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      ORG,
      expect.objectContaining({
        status: "needs_amendment",
        reviewerNote: "Edited by agent post-approval",
      }),
    );
    expect(appendClaimTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromStatus: "approved", toStatus: "needs_amendment" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.claim.update.portal" }),
    );
  });
});

// ─── Approve / reject / needs-amendment ─────────────────────────────────────

describe("approveClaimService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor 403 (RBAC)", async () => {
    const r = await approveClaimService(ctx("editor"), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("404 when missing", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(null);
    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("409 when already approved (terminal)", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({ status: "approved" }),
    );
    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(updateClaimRow).not.toHaveBeenCalled();
  });

  it("409 when already rejected (terminal)", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({ status: "rejected" }),
    );
    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("400 when splits invalid at approve time (re-validates)", async () => {
    // Splits sum to 90% → invalid against computedAmount=25,000.
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({
        splits: [
          {
            id: "s",
            organizationId: ORG,
            claimId: CLAIM,
            partyPartyId: null,
            partyDisplayName: "X",
            roleLabel: "X",
            splitType: "percent",
            splitValue: 90,
            sortOrder: 0,
          },
        ],
      }),
    );
    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(updateClaimRow).not.toHaveBeenCalled();
  });

  it("approves from submitted: writes transition + audit", async () => {
    const before = fakeClaim({ status: "submitted" });
    vi.mocked(findClaimById).mockResolvedValueOnce(before);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateClaimRow).mockResolvedValueOnce(fakeClaim({ status: "approved" }));

    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(updateClaimRow).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      ORG,
      expect.objectContaining({ status: "approved" }),
    );
    expect(appendClaimTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromStatus: "submitted", toStatus: "approved" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.claim.approve" }),
    );
  });

  it("approves from needs_amendment", async () => {
    const before = fakeClaim({ status: "needs_amendment" });
    vi.mocked(findClaimById).mockResolvedValueOnce(before);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateClaimRow).mockResolvedValueOnce(fakeClaim({ status: "approved" }));
    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: true, status: 200 });
  });
});

describe("rejectClaimService + needsAmendmentClaimService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejectClaim: editor 403", async () => {
    const r = await rejectClaimService(ctx("editor"), CLAIM, "x");
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("rejectClaim: 409 when already rejected", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({ status: "rejected" }),
    );
    const r = await rejectClaimService(ctx(), CLAIM, "no good");
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("rejectClaim: writes status + reviewerNote + transition + audit", async () => {
    const before = fakeClaim();
    vi.mocked(findClaimById).mockResolvedValueOnce(before);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateClaimRow).mockResolvedValueOnce(
      fakeClaim({ status: "rejected", reviewerNote: "no good" }),
    );
    await rejectClaimService(ctx(), CLAIM, "no good");
    expect(updateClaimRow).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      ORG,
      expect.objectContaining({ status: "rejected", reviewerNote: "no good" }),
    );
    expect(appendClaimTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: "rejected", note: "no good" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.claim.reject" }),
    );
  });

  it("needsAmendmentClaim: writes status=needs_amendment + audit", async () => {
    const before = fakeClaim();
    vi.mocked(findClaimById).mockResolvedValueOnce(before);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateClaimRow).mockResolvedValueOnce(
      fakeClaim({ status: "needs_amendment", reviewerNote: "fix splits" }),
    );
    await needsAmendmentClaimService(ctx(), CLAIM, "fix splits");
    expect(updateClaimRow).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      ORG,
      expect.objectContaining({ status: "needs_amendment", reviewerNote: "fix splits" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.claim.needs_amendment" }),
    );
  });
});

// ─── Org isolation ──────────────────────────────────────────────────────────

describe("org isolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getClaimByIdService: cross-org returns 404", async () => {
    vi.mocked(findClaimById).mockImplementationOnce(async (orgId) => {
      if (orgId !== ORG) return null;
      return fakeClaim();
    });
    const r = await getClaimByIdService(
      { orgId: "other-org", actorUserId: USER, actorRole: "manager" },
      CLAIM,
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("createClaimService: cross-org SalesUnit lookup returns 404", async () => {
    vi.mocked(findSalesUnitForClaim).mockImplementationOnce(async (orgId) => {
      if (orgId !== ORG) return null;
      return { id: SALES, agentPartyId: AGENT, purchasePrice: PURCHASE_PRICE };
    });
    const r = await createClaimService(
      { orgId: "other-org", actorUserId: USER, actorRole: "manager" },
      baseCreateClaimInput(),
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});
