// Tests for the portal inventory service after the three-table refactor.
// The service is now a thin dispatcher around the submissions module —
// create/update/cancel paths route to createUnitSubmissionService /
// createAmendmentService / resubmitSubmissionService / withdrawSubmissionService.
// The previous "direct write + pendingChanges" path is gone (Listings are
// approved by definition; agent edits go through UnitSubmission).
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- In-memory mock stores --------------------------------------------------
const submissionStore = new Map<string, Record<string, unknown>>();
const listingStore = new Map<string, Record<string, unknown>>();
const propertyStore = new Map<string, Record<string, unknown>>();
const propertySubmissionStore = new Map<string, Record<string, unknown>>();

const dbMock = {
  property: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      for (const row of propertyStore.values()) {
        const w = args.where;
        if (w.id !== undefined && row.id !== w.id) continue;
        if (w.organizationId !== undefined && row.organizationId !== w.organizationId) continue;
        return row;
      }
      return null;
    }),
  },
  propertySubmission: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      for (const row of propertySubmissionStore.values()) {
        const w = args.where as {
          id?: string;
          organizationId?: string;
          sourcingAgentId?: string;
        };
        if (w.id !== undefined && row.id !== w.id) continue;
        if (w.organizationId !== undefined && row.organizationId !== w.organizationId) continue;
        if (w.sourcingAgentId !== undefined && row.sourcingAgentId !== w.sourcingAgentId) continue;
        return row;
      }
      return null;
    }),
  },
  unitSubmission: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      for (const row of submissionStore.values()) {
        const w = args.where;
        if (w.id !== undefined && row.id !== w.id) continue;
        if (w.organizationId !== undefined && row.organizationId !== w.organizationId) continue;
        return row;
      }
      return null;
    }),
  },
  listing: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      for (const row of listingStore.values()) {
        const w = args.where;
        if (w.id !== undefined && row.id !== w.id) continue;
        if (w.organizationId !== undefined && row.organizationId !== w.organizationId) continue;
        return row;
      }
      return null;
    }),
  },
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
  Prisma: {},
}));

vi.mock("../../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// Stub the listing-mode helpers — they're tested elsewhere; here we just
// want the portal service's dispatch logic isolated.
vi.mock("../../../inventory/listing-mode", () => ({
  getUnitGroupMode: vi.fn(async () => null),
  resolveRoomTypeKind: vi.fn(async () => "PARTITION"),
}));

vi.mock("../../../inventory/amenities/amenities.service", () => ({
  assertAmenitiesBelongToOrgService: vi.fn(async () => ({ ok: true })),
}));

// Mock the submissions service. Each function records its call args so the
// dispatch path can be asserted; return shape mirrors the real service.
const createUnitSubmissionMock = vi.fn();
const createAmendmentMock = vi.fn();
const resubmitSubmissionMock = vi.fn();
const withdrawSubmissionMock = vi.fn();

vi.mock("../../../submissions/submission.service", () => ({
  createUnitSubmissionService: (...args: unknown[]) => createUnitSubmissionMock(...args),
  createAmendmentService: (...args: unknown[]) => createAmendmentMock(...args),
  resubmitSubmissionService: (...args: unknown[]) => resubmitSubmissionMock(...args),
  withdrawSubmissionService: (...args: unknown[]) => withdrawSubmissionMock(...args),
}));

import {
  portalCancelOwnUnitService,
  portalCreateUnitService,
  portalUpdateOwnUnitService,
} from "../portal.inventory.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const PROP = "00000000-0000-0000-0000-000000000002";
const AGENT_PARTY = "00000000-0000-0000-0000-000000000aaa";
const OTHER_AGENT = "00000000-0000-0000-0000-000000000bbb";
const AGENT_USER = "00000000-0000-0000-0000-000000000a01";
const UNIT_ID = "00000000-0000-0000-0000-0000000000ff";

const ctx = {
  orgId: ORG,
  actorUserId: AGENT_USER,
  partyId: AGENT_PARTY,
  ip: "1.2.3.4",
  userAgent: "vitest",
};

function seedProperty() {
  propertyStore.set(PROP, { id: PROP, organizationId: ORG });
}

function seedSubmission(overrides: Record<string, unknown> = {}) {
  submissionStore.set(UNIT_ID, {
    id: UNIT_ID,
    organizationId: ORG,
    sourcingAgentId: AGENT_PARTY,
    submissionState: "pending",
    ...overrides,
  });
}

function seedListing(overrides: Record<string, unknown> = {}) {
  listingStore.set(UNIT_ID, {
    id: UNIT_ID,
    organizationId: ORG,
    sourcingAgentId: AGENT_PARTY,
    ...overrides,
  });
}

const PROP_SUB = "00000000-0000-0000-0000-000000000pps".replace(/p/g, "f");
function seedPropertySubmission(overrides: Record<string, unknown> = {}) {
  propertySubmissionStore.set(PROP_SUB, {
    id: PROP_SUB,
    organizationId: ORG,
    sourcingAgentId: AGENT_PARTY,
    submissionState: "pending",
    ...overrides,
  });
}

beforeEach(() => {
  submissionStore.clear();
  listingStore.clear();
  propertyStore.clear();
  propertySubmissionStore.clear();
  vi.clearAllMocks();
  createUnitSubmissionMock.mockResolvedValue({ ok: true, status: 201, data: { id: "new-sub" } });
  createAmendmentMock.mockResolvedValue({
    ok: true,
    status: 201,
    data: { submissionId: "amend-sub" },
  });
  resubmitSubmissionMock.mockResolvedValue({ ok: true, status: 200, data: { id: UNIT_ID } });
  withdrawSubmissionMock.mockResolvedValue({ ok: true, status: 200, data: { id: UNIT_ID } });
});

// ---- Create — pending-property attach path (B7 / A2) ----------------------

describe("portalCreateUnitService — propertySubmissionId attach path", () => {
  it("creates a unit submission attached to a pending property the agent owns", async () => {
    seedPropertySubmission({ submissionState: "pending" });

    const result = await portalCreateUnitService(ctx, {
      propertySubmissionId: PROP_SUB,
      unitCode: "U01",
      unitType: "Studio",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
    } as unknown as Parameters<typeof portalCreateUnitService>[1]);

    expect(result).toMatchObject({ ok: true, status: 201, data: { id: "new-sub" } });
    expect(createUnitSubmissionMock).toHaveBeenCalledTimes(1);
    const args = createUnitSubmissionMock.mock.calls[0];
    expect(args[1]).toMatchObject({
      propertySubmissionId: PROP_SUB,
      unitCode: "U01",
      listingType: "Studio",
    });
    // Mutually exclusive — propertyId must NOT be sent when submissionId is.
    expect(args[1].propertyId).toBeUndefined();
  });

  it("allows attaching to a needs_amendment submission too", async () => {
    seedPropertySubmission({ submissionState: "needs_amendment" });
    const result = await portalCreateUnitService(ctx, {
      propertySubmissionId: PROP_SUB,
      unitCode: "U01",
      unitType: "Studio",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
    } as unknown as Parameters<typeof portalCreateUnitService>[1]);
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects with 409 when the submission has already been approved", async () => {
    seedPropertySubmission({ submissionState: "approved" });
    const result = await portalCreateUnitService(ctx, {
      propertySubmissionId: PROP_SUB,
      unitCode: "U01",
      unitType: "Studio",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
    } as unknown as Parameters<typeof portalCreateUnitService>[1]);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(createUnitSubmissionMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the submission belongs to a different agent (own-only)", async () => {
    seedPropertySubmission({ sourcingAgentId: "different-agent" });
    const result = await portalCreateUnitService(ctx, {
      propertySubmissionId: PROP_SUB,
      unitCode: "U01",
      unitType: "Studio",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
    } as unknown as Parameters<typeof portalCreateUnitService>[1]);
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("returns 404 when the submission doesn't exist", async () => {
    const result = await portalCreateUnitService(ctx, {
      propertySubmissionId: "00000000-0000-0000-0000-000000000999",
      unitCode: "U01",
      unitType: "Studio",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
    } as unknown as Parameters<typeof portalCreateUnitService>[1]);
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});

// ---- Create ----------------------------------------------------------------

describe("portalCreateUnitService — dispatches to createUnitSubmissionService", () => {
  it("returns 404 when the parent Property is not in this org", async () => {
    // Property not seeded — service must NOT call into the submissions module.
    const result = await portalCreateUnitService(ctx, {
      propertyId: PROP,
      unitCode: "U01",
      unitType: "Studio",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
    } as unknown as Parameters<typeof portalCreateUnitService>[1]);

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(createUnitSubmissionMock).not.toHaveBeenCalled();
  });

  it("calls createUnitSubmissionService with the split listing/apartmentShared payload", async () => {
    seedProperty();
    const result = await portalCreateUnitService(ctx, {
      propertyId: PROP,
      unitCode: "U01",
      unitType: "Studio",
      bedrooms: 2,
      rentalRate: 1500,
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      description: "Cosy",
    } as unknown as Parameters<typeof portalCreateUnitService>[1]);

    expect(result).toMatchObject({ ok: true, status: 201, data: { id: "new-sub" } });
    expect(createUnitSubmissionMock).toHaveBeenCalledTimes(1);
    const args = createUnitSubmissionMock.mock.calls[0];
    expect(args[0]).toMatchObject({
      orgId: ORG,
      userId: AGENT_USER,
      partyId: AGENT_PARTY,
    });
    expect(args[1]).toMatchObject({
      propertyId: PROP,
      unitCode: "U01",
      listingType: "Studio",
    });
    // apartmentShared fields routed correctly, listing fields stripped from
    // the apartment-shared envelope, and description renamed to
    // publishedDescription.
    expect(args[1].payload).toMatchObject({
      listing: expect.objectContaining({
        rentalRate: 1500,
        depositMonths: 2,
        utilitiesDepositMonths: 1,
      }),
      apartmentShared: expect.objectContaining({
        bedrooms: 2,
        publishedDescription: "Cosy",
      }),
    });
  });
});

// ---- Update — needs_amendment -> resubmit -----------------------------------

describe("portalUpdateOwnUnitService — needs_amendment dispatches to resubmitSubmissionService", () => {
  it("resubmits when the id resolves to an own needs_amendment submission", async () => {
    seedSubmission({ submissionState: "needs_amendment" });

    const result = await portalUpdateOwnUnitService(ctx, UNIT_ID, {
      rentalRate: 1700,
    } as unknown as Parameters<typeof portalUpdateOwnUnitService>[2]);

    expect(result).toMatchObject({ ok: true, status: 200, data: { id: UNIT_ID } });
    expect(resubmitSubmissionMock).toHaveBeenCalledTimes(1);
    expect(createAmendmentMock).not.toHaveBeenCalled();
  });

  it("rejects with 404 when the submission belongs to another agent", async () => {
    seedSubmission({ submissionState: "needs_amendment", sourcingAgentId: OTHER_AGENT });

    const result = await portalUpdateOwnUnitService(ctx, UNIT_ID, {
      rentalRate: 1700,
    } as unknown as Parameters<typeof portalUpdateOwnUnitService>[2]);

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(resubmitSubmissionMock).not.toHaveBeenCalled();
  });

  it("dispatches to resubmit for a pending submission too (agent fixes own typo)", async () => {
    seedSubmission({ submissionState: "pending" });

    const result = await portalUpdateOwnUnitService(ctx, UNIT_ID, {
      rentalRate: 1700,
    } as unknown as Parameters<typeof portalUpdateOwnUnitService>[2]);

    expect(result).toMatchObject({ ok: true, status: 200, data: { id: UNIT_ID } });
    expect(resubmitSubmissionMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with 409 for terminal submissions (approved/rejected/withdrawn)", async () => {
    seedSubmission({ submissionState: "rejected" });

    const result = await portalUpdateOwnUnitService(ctx, UNIT_ID, {
      rentalRate: 1700,
    } as unknown as Parameters<typeof portalUpdateOwnUnitService>[2]);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(resubmitSubmissionMock).not.toHaveBeenCalled();
  });
});

// ---- Update — own approved Listing -> amendment ----------------------------

describe("portalUpdateOwnUnitService — approved Listing dispatches to createAmendmentService", () => {
  it("creates an amendment when the id resolves to an own approved Listing", async () => {
    seedListing();

    const result = await portalUpdateOwnUnitService(ctx, UNIT_ID, {
      rentalRate: 1700,
    } as unknown as Parameters<typeof portalUpdateOwnUnitService>[2]);

    expect(result).toMatchObject({ ok: true, status: 200, data: { id: "amend-sub" } });
    expect(createAmendmentMock).toHaveBeenCalledTimes(1);
    expect(resubmitSubmissionMock).not.toHaveBeenCalled();
  });

  it("rejects with 403 when the listing belongs to another agent (or is COMPANY-sourced)", async () => {
    seedListing({ sourcingAgentId: OTHER_AGENT });

    const result = await portalUpdateOwnUnitService(ctx, UNIT_ID, {
      rentalRate: 1700,
    } as unknown as Parameters<typeof portalUpdateOwnUnitService>[2]);

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(createAmendmentMock).not.toHaveBeenCalled();
  });

  it("rejects with 403 when the listing is COMPANY-sourced (sourcingAgentId is null)", async () => {
    seedListing({ sourcingAgentId: null });

    const result = await portalUpdateOwnUnitService(ctx, UNIT_ID, {
      rentalRate: 1700,
    } as unknown as Parameters<typeof portalUpdateOwnUnitService>[2]);

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(createAmendmentMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the id resolves to neither a submission nor a listing", async () => {
    const result = await portalUpdateOwnUnitService(ctx, UNIT_ID, {
      rentalRate: 1700,
    } as unknown as Parameters<typeof portalUpdateOwnUnitService>[2]);

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(resubmitSubmissionMock).not.toHaveBeenCalled();
    expect(createAmendmentMock).not.toHaveBeenCalled();
  });

  // B11 regression — pre-fix, agent's amendment-time room type change was
  // silently dropped because `unitType` was absent from BOTH the
  // apartmentShared and listing buckets in splitToSubmissionPayload.
  it("routes input.unitType into payload.listing.listingType on amend (B11)", async () => {
    seedListing();

    await portalUpdateOwnUnitService(ctx, UNIT_ID, {
      unitType: "Small",
      rentalRate: 1500,
    } as unknown as Parameters<typeof portalUpdateOwnUnitService>[2]);

    expect(createAmendmentMock).toHaveBeenCalledTimes(1);
    const [, , payload] = createAmendmentMock.mock.calls[0];
    expect(payload).toMatchObject({
      listing: expect.objectContaining({
        listingType: "Small",
        rentalRate: 1500,
      }),
    });
    // No silent fallback to the raw `unitType` key — the payload must use
    // `listingType` so the submission-approval merge writes the right
    // Listing column without further translation.
    expect((payload as { listing: { unitType?: unknown } }).listing.unitType).toBeUndefined();
  });

  it("routes moveOutDate into payload.listing on amend (missing sibling of moveInDate)", async () => {
    seedListing();

    await portalUpdateOwnUnitService(ctx, UNIT_ID, {
      moveOutDate: "2026-12-31",
    } as unknown as Parameters<typeof portalUpdateOwnUnitService>[2]);

    expect(createAmendmentMock).toHaveBeenCalledTimes(1);
    const [, , payload] = createAmendmentMock.mock.calls[0];
    expect(payload).toMatchObject({
      listing: expect.objectContaining({ moveOutDate: "2026-12-31" }),
    });
  });
});

// ---- Cancel ----------------------------------------------------------------

describe("portalCancelOwnUnitService — withdraws own submission", () => {
  it("dispatches to withdrawSubmissionService when the id is the agent's own submission", async () => {
    seedSubmission({ submissionState: "pending" });

    const result = await portalCancelOwnUnitService(ctx, UNIT_ID);

    expect(result).toMatchObject({ ok: true, status: 200, data: { id: UNIT_ID } });
    expect(withdrawSubmissionMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with 404 when the submission belongs to another agent", async () => {
    seedSubmission({ submissionState: "pending", sourcingAgentId: OTHER_AGENT });

    const result = await portalCancelOwnUnitService(ctx, UNIT_ID);

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(withdrawSubmissionMock).not.toHaveBeenCalled();
  });

  it("rejects with 409 when the id resolves to an approved Listing (not withdrawable)", async () => {
    // Approved listings cannot be withdrawn via this endpoint — that's an
    // admin op (archive). Agents file an amendment instead.
    seedListing();

    const result = await portalCancelOwnUnitService(ctx, UNIT_ID);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(withdrawSubmissionMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the id resolves to neither a submission nor an own listing", async () => {
    const result = await portalCancelOwnUnitService(ctx, UNIT_ID);

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(withdrawSubmissionMock).not.toHaveBeenCalled();
  });
});
