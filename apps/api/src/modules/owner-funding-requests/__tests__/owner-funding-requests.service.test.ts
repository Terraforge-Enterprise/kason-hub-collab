import { describe, it, expect, vi, beforeEach } from "vitest";

// Collaborator mocks (paths are test-file-relative) — mirrors expenses.service.test.ts.
const ownerFundingRequestCreate = vi.fn();
const ownerFundingRequestFindMany = vi.fn();
const recordAudit = vi.fn();
const computeAvailableOwnerPayableC = vi.fn();

vi.mock("../../../lib/audit", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));
// computeAvailableOwnerPayableC is the SAME primitive owner-remittance uses for its
// live payable balance — read here ONLY as a display helper (task-mandated); no
// write, no lock, no derivation change.
vi.mock("../../owner-remittance/owner-remittance.repository", () => ({
  computeAvailableOwnerPayableC: (...a: unknown[]) => computeAvailableOwnerPayableC(...a),
}));
vi.mock("@kason/db", () => ({
  getDb: () => ({
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        ownerFundingRequest: {
          create: (...a: unknown[]) => ownerFundingRequestCreate(...a),
          findMany: (...a: unknown[]) => ownerFundingRequestFindMany(...a),
        },
        auditLog: { create: vi.fn() },
      }),
  }),
  Prisma: {},
}));

import { createOwnerFundingRequestService, listOwnerFundingRequestsService } from "../owner-funding-requests.service";

const CTX = { orgId: "org-1", actorUserId: "user-1", actorRole: "editor" };
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const goodInput = {
  ownerPartyId: OWNER_ID,
  amount: "5000.00",
  reason: "Roof repair far exceeds rent collected this month",
};
const NOW = new Date("2026-07-23T00:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    organizationId: "org-1",
    ownerPartyId: OWNER_ID,
    propertyId: null,
    amount: "5000.00",
    reason: goodInput.reason,
    status: "requested",
    requestedById: "user-1",
    settledAt: null,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("createOwnerFundingRequestService (P7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ownerFundingRequestCreate.mockResolvedValue(row());
  });

  it("(a) creates an OwnerFundingRequest row with status 'requested' and amount/reason/owner correct", async () => {
    const res = await createOwnerFundingRequestService(CTX, goodInput);
    expect(res).toMatchObject({
      id: "req-1",
      ownerPartyId: OWNER_ID,
      amount: "5000.00",
      reason: goodInput.reason,
      status: "requested",
      requestedById: "user-1",
    });
    const createArg = ownerFundingRequestCreate.mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      organizationId: "org-1",
      ownerPartyId: OWNER_ID,
      propertyId: null,
      amount: goodInput.amount,
      reason: goodInput.reason,
      status: "requested",
      requestedById: "user-1", // requestedById = actor, per spec
    });
  });

  it("records an audit row for the create, inside the same tx", async () => {
    await createOwnerFundingRequestService(CTX, goodInput);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const auditArg = recordAudit.mock.calls[0][1];
    expect(auditArg).toMatchObject({
      organizationId: "org-1",
      actorUserId: "user-1",
      actorRole: "editor",
      action: "owner_funding_requests.create",
      entityType: "OwnerFundingRequest",
      entityId: "req-1",
    });
  });

  it("passes propertyId through when provided, and defaults it to null when omitted", async () => {
    await createOwnerFundingRequestService(CTX, goodInput);
    expect(ownerFundingRequestCreate.mock.calls[0][0].data.propertyId).toBeNull();

    ownerFundingRequestCreate.mockResolvedValue(row({ propertyId: "22222222-2222-4222-8222-222222222222" }));
    const res = await createOwnerFundingRequestService(CTX, {
      ...goodInput,
      propertyId: "22222222-2222-4222-8222-222222222222",
    });
    expect(res.propertyId).toBe("22222222-2222-4222-8222-222222222222");
    expect(ownerFundingRequestCreate.mock.calls[1][0].data.propertyId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("never touches computeAvailableOwnerPayableC on create — amount is admin-supplied, not derived", async () => {
    await createOwnerFundingRequestService(CTX, goodInput);
    expect(computeAvailableOwnerPayableC).not.toHaveBeenCalled();
  });
});

describe("listOwnerFundingRequestsService (P7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ownerFundingRequestFindMany.mockResolvedValue([row()]);
    computeAvailableOwnerPayableC.mockResolvedValue(-12345);
  });

  it("(d) lists the owner's requests, org-scoped", async () => {
    const res = await listOwnerFundingRequestsService(CTX, OWNER_ID);
    expect(res.requests).toHaveLength(1);
    expect(res.requests[0]).toMatchObject({ id: "req-1", status: "requested", amount: "5000.00", ownerPartyId: OWNER_ID });
    expect(ownerFundingRequestFindMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", ownerPartyId: OWNER_ID },
      orderBy: { createdAt: "desc" },
    });
  });

  it("includes the owner's current signed balance as a read-only display helper (no math change)", async () => {
    const res = await listOwnerFundingRequestsService(CTX, OWNER_ID);
    expect(res.currentBalanceC).toBe(-12345);
    expect(computeAvailableOwnerPayableC).toHaveBeenCalledWith(expect.anything(), "org-1", OWNER_ID);
  });

  it("returns an empty list (not an error) when the owner has no requests yet", async () => {
    ownerFundingRequestFindMany.mockResolvedValue([]);
    const res = await listOwnerFundingRequestsService(CTX, OWNER_ID);
    expect(res.requests).toEqual([]);
  });
});
