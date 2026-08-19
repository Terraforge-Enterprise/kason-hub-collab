import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted recordAudit mock — imported by the service under test.
vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// Storage best-effort cleanup — mocked so tests never touch real Supabase.
vi.mock("../../../lib/storage", () => ({
  deleteObjectsBestEffort: vi.fn(async () => ({ deleted: 0, failed: 0 })),
}));

// Deletion preview is exercised by service-level happy + blocker paths;
// fully mocked here. Default returns a safe (canDelete) report so existing
// happy-path tests still pass without per-test setup.
vi.mock("../listings.deletion", () => ({
  buildDeletionPreview: vi.fn(async () => ({
    unitId: "11111111-1111-4111-8111-111111111111",
    unitCode: "UNIT-CODE",
    unitLabel: "Test, UNIT-CODE",
    canDelete: true,
    blockers: [],
    cascades: [
      { kind: "unit-attributes", count: 0 },
      { kind: "listing-visibility-grants", count: 0 },
    ],
  })),
}));

// getDb is only used by getDeletionPreviewService (non-tx read path);
// the service-level mocks for the read functions cover everything else.
vi.mock("@kason/db", async () => {
  const actual = await vi.importActual<typeof import("@kason/db")>("@kason/db");
  return { ...actual, getDb: vi.fn(() => ({}) as never) };
});

// Repository is fully mocked — these are service-level tests.
vi.mock("../listings.repository", () => ({
  listListings: vi.fn(async () => []),
  findListingById: vi.fn(async () => null),
  // findListingByIdTx is the in-tx re-read added by the TOCTOU fix; it
  // mirrors findListingById by default so existing tests that only stub
  // findListingById still hit the happy path.
  findListingByIdTx: vi.fn(async () => null),
  findPropertyById: vi.fn(async () => ({ id: "p1" })),
  findUnitCodeConflict: vi.fn(async () => null),
  createListingRow: vi.fn(),
  updateListingRow: vi.fn(),
  // deleteListingRow now returns `{ count }` — composite-key deleteMany.
  deleteListingRow: vi.fn(async () => ({ count: 1 })),
  // withTransaction just runs the callback with a fake tx object.
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
}));

import { recordAudit } from "../../../lib/audit";
import { deleteObjectsBestEffort } from "../../../lib/storage";
import {
  createListingRow,
  deleteListingRow,
  findListingById,
  findListingByIdTx,
  findPropertyById,
  findUnitCodeConflict,
  listListings,
  updateListingRow,
  withTransaction,
} from "../listings.repository";
import {
  createListingService,
  deleteListingService,
  getListingByIdService,
  getListingsService,
  updateListingService,
} from "../listings.service";
import type { ListingRow } from "../listings.types";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";
const PROPERTY = "00000000-0000-0000-0000-000000000100";
// RFC4122 v4 shape — pinned constant so the value is stable across test runs.
const LISTING_ID = "11111111-1111-4111-8111-111111111111";

function fakeListing(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    id: LISTING_ID,
    organizationId: ORG,
    propertyId: PROPERTY,
    propertyName: "Test Property",
    propertyCode: "TP-01",
    unitCode: "A-01",
    unitType: "condo",
    listingType: "condo",
    occupancyStatus: "vacant",
    listingStatus: "active",
    currency: "MYR",
    bedrooms: 2,
    bathrooms: 1,
    floorArea: 800,
    rentalRate: 1500,
    photoKeys: [],
    coverPhotoKey: null,
    videoKeys: [],
    amenities: [],
    moveInDate: null,
    readyNow: false,
    inChargeName: null,
    inChargePartyId: null,
    sourcingAgentId: null,
    visibilityMode: "PUBLIC",
    hiddenFromPartyIds: [],
    sourceFlag: "COMPANY",
    sourcingApproved: true,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

function baseCreateInput() {
  return {
    propertyId: PROPERTY,
    unitCode: "A-01",
    unitType: "condo",
    photoKeys: [] as string[],
    videoKeys: [] as string[],
    readyNow: false,
    sourceFlag: "COMPANY" as const,
    visibilityMode: "PUBLIC" as const,
    hiddenFromPartyIds: [] as string[],
  };
}

function baseCtx(role: "admin" | "manager" | "editor" = "manager") {
  return {
    orgId: ORG,
    actorUserId: USER,
    actorRole: role,
    ip: "10.0.0.1",
    userAgent: "vitest",
  };
}

describe("createListingService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects editor with 403", async () => {
    const result = await createListingService(baseCtx("editor"), baseCreateInput());
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 403 });
    expect(createListingRow).not.toHaveBeenCalled();
  });

  it("returns 404 when property not found", async () => {
    vi.mocked(findPropertyById).mockResolvedValueOnce(null);
    const result = await createListingService(baseCtx(), baseCreateInput());
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(createListingRow).not.toHaveBeenCalled();
  });

  it("returns 409 on unit-code conflict", async () => {
    vi.mocked(findUnitCodeConflict).mockResolvedValueOnce({ id: "existing" });
    const result = await createListingService(baseCtx(), baseCreateInput());
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(createListingRow).not.toHaveBeenCalled();
  });

  it("writes Listing row and records listing.create audit in a single transaction", async () => {
    const row = fakeListing();
    vi.mocked(createListingRow).mockResolvedValueOnce(row);
    const result = await createListingService(baseCtx(), baseCreateInput());
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(createListingRow).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "listing.create",
        entityType: "Unit",
        entityId: LISTING_ID,
        actorUserId: USER,
        actorRole: "manager",
        organizationId: ORG,
        ip: "10.0.0.1",
        userAgent: "vitest",
      }),
    );
  });

  it("passes through new marketing fields to the repository", async () => {
    vi.mocked(createListingRow).mockResolvedValueOnce(
      fakeListing({
        sourcingAgentId: "00000000-0000-0000-0000-000000000900",
        sourceFlag: "AGENT_SOURCED",
        visibilityMode: "RESTRICTED",
      }),
    );
    await createListingService(baseCtx(), {
      ...baseCreateInput(),
      sourceFlag: "AGENT_SOURCED",
      visibilityMode: "RESTRICTED",
      sourcingAgentId: "00000000-0000-0000-0000-000000000900",
      moveInDate: "2026-05-01T00:00:00.000Z",
      readyNow: true,
      videoKeys: ["v1.mp4"],
      hiddenFromPartyIds: ["00000000-0000-0000-0000-000000000abc"],
    });
    expect(createListingRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        visibilityMode: "RESTRICTED",
        sourcingAgentId: "00000000-0000-0000-0000-000000000900",
        moveInDate: "2026-05-01T00:00:00.000Z",
        readyNow: true,
        videoKeys: ["v1.mp4"],
      }),
    );
  });
});

describe("updateListingService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when listing missing", async () => {
    vi.mocked(findListingById).mockResolvedValueOnce(null);
    const result = await updateListingService(baseCtx(), LISTING_ID, { unitCode: "B-02" });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("409 on unitCode conflict", async () => {
    vi.mocked(findListingById).mockResolvedValueOnce(fakeListing());
    vi.mocked(findUnitCodeConflict).mockResolvedValueOnce({ id: "other" });
    const result = await updateListingService(baseCtx(), LISTING_ID, { unitCode: "B-02" });
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("records listing.update with before/after diff", async () => {
    const before = fakeListing({ readyNow: false });
    const after = fakeListing({ readyNow: true });
    vi.mocked(findListingById).mockResolvedValueOnce(before);
    vi.mocked(findListingByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateListingRow).mockResolvedValueOnce(after);

    const result = await updateListingService(baseCtx(), LISTING_ID, { readyNow: true });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const call = vi.mocked(recordAudit).mock.calls.at(-1)!;
    const payload = call[1] as unknown as {
      action: string;
      diff: { before: ListingRow; after: ListingRow };
    };
    expect(payload.action).toBe("listing.update");
    expect(payload.diff.before.readyNow).toBe(false);
    expect(payload.diff.after.readyNow).toBe(true);
  });

  it("rejects editor with 403", async () => {
    const result = await updateListingService(baseCtx("editor"), LISTING_ID, { readyNow: true });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(updateListingRow).not.toHaveBeenCalled();
  });
});

describe("deleteListingService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects manager with 403 (admin only)", async () => {
    const result = await deleteListingService(baseCtx("manager"), LISTING_ID, "UNIT-CODE");
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(deleteListingRow).not.toHaveBeenCalled();
  });

  it("rejects editor with 403", async () => {
    const result = await deleteListingService(baseCtx("editor"), LISTING_ID, "UNIT-CODE");
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("404 when listing missing", async () => {
    vi.mocked(findListingById).mockResolvedValueOnce(null);
    const result = await deleteListingService(baseCtx("admin"), LISTING_ID, "UNIT-CODE");
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("deletes + records listing.delete audit inside a transaction", async () => {
    const listing = fakeListing();
    vi.mocked(findListingById).mockResolvedValueOnce(listing);
    vi.mocked(findListingByIdTx).mockResolvedValueOnce(listing);
    const result = await deleteListingService(baseCtx("admin"), LISTING_ID, "UNIT-CODE");
    expect(result).toMatchObject({ ok: true, status: 200, data: { id: LISTING_ID } });
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(deleteListingRow).toHaveBeenCalledTimes(1);
    // Composite-key deleteMany — pass orgId through so a row that was
    // re-parented between the read and the delete matches zero.
    expect(deleteListingRow).toHaveBeenCalledWith(expect.anything(), LISTING_ID, ORG);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "listing.delete",
        entityType: "Unit",
        entityId: LISTING_ID,
        actorRole: "admin",
        meta: expect.objectContaining({ unitCode: "UNIT-CODE" }),
      }),
    );
  });

  it("400 when confirmCode does not match unitCode", async () => {
    const listing = fakeListing();
    vi.mocked(findListingById).mockResolvedValueOnce(listing);
    vi.mocked(findListingByIdTx).mockResolvedValueOnce(listing);
    const result = await deleteListingService(
      baseCtx("admin"),
      LISTING_ID,
      "WRONG-CODE",
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(deleteListingRow).not.toHaveBeenCalled();
  });

  it("409 with DeletionReport body when blockers exist", async () => {
    const { buildDeletionPreview } = await import("../listings.deletion");
    const listing = fakeListing();
    vi.mocked(findListingById).mockResolvedValueOnce(listing);
    vi.mocked(findListingByIdTx).mockResolvedValueOnce(listing);
    vi.mocked(buildDeletionPreview).mockResolvedValueOnce({
      unitId: LISTING_ID,
      unitCode: "UNIT-CODE",
      unitLabel: "Test, UNIT-CODE",
      canDelete: false,
      blockers: [
        {
          kind: "any-reservations",
          count: 3,
          sampleIds: ["r1", "r2", "r3"],
          resolveHref: "/reservations?unitId=" + LISTING_ID,
          resolveLabel: "View 3 reservations",
        },
      ],
      cascades: [
        { kind: "unit-attributes", count: 0 },
        { kind: "listing-visibility-grants", count: 0 },
      ],
    });
    const result = await deleteListingService(
      baseCtx("admin"),
      LISTING_ID,
      "UNIT-CODE",
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    if (!result.ok && typeof result.error === "object") {
      expect(result.error).toMatchObject({
        canDelete: false,
        blockers: expect.arrayContaining([
          expect.objectContaining({ kind: "any-reservations", count: 3 }),
        ]),
      });
    }
    expect(deleteListingRow).not.toHaveBeenCalled();
  });

  it("calls deleteObjectsBestEffort with all media keys on successful delete", async () => {
    const listing = fakeListing({
      photoKeys: ["units/u1/a.jpg"],
      coverPhotoKey: "units/u1/cover.jpg",
      videoKeys: ["units/u1/v.mp4"],
      unitCode: "UNIT-CODE",
    });
    vi.mocked(findListingById).mockResolvedValueOnce(listing);
    vi.mocked(findListingByIdTx).mockResolvedValueOnce(listing);
    const result = await deleteListingService(baseCtx("admin"), LISTING_ID, "UNIT-CODE");
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(vi.mocked(deleteObjectsBestEffort)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteObjectsBestEffort)).toHaveBeenCalledWith(
      expect.arrayContaining(["units/u1/a.jpg", "units/u1/cover.jpg", "units/u1/v.mp4"]),
    );
  });

  it("does NOT call deleteObjectsBestEffort when deletion is blocked", async () => {
    const { buildDeletionPreview } = await import("../listings.deletion");
    const listing = fakeListing({ unitCode: "UNIT-CODE" });
    vi.mocked(findListingById).mockResolvedValueOnce(listing);
    vi.mocked(findListingByIdTx).mockResolvedValueOnce(listing);
    vi.mocked(buildDeletionPreview).mockResolvedValueOnce({
      unitId: LISTING_ID,
      unitCode: "UNIT-CODE",
      unitLabel: "Test, UNIT-CODE",
      canDelete: false,
      blockers: [
        {
          kind: "any-reservations",
          count: 1,
          sampleIds: ["r1"],
          resolveHref: "/reservations?unitId=" + LISTING_ID,
          resolveLabel: "View 1 reservation",
        },
      ],
      cascades: [
        { kind: "unit-attributes", count: 0 },
        { kind: "listing-visibility-grants", count: 0 },
      ],
    });
    const result = await deleteListingService(baseCtx("admin"), LISTING_ID, "UNIT-CODE");
    expect(result.ok).toBe(false);
    expect(vi.mocked(deleteObjectsBestEffort)).not.toHaveBeenCalled();
  });

  it("does NOT call deleteObjectsBestEffort on confirm-code mismatch", async () => {
    const listing = fakeListing({ unitCode: "UNIT-CODE" });
    vi.mocked(findListingById).mockResolvedValueOnce(listing);
    vi.mocked(findListingByIdTx).mockResolvedValueOnce(listing);
    const result = await deleteListingService(baseCtx("admin"), LISTING_ID, "WRONG-CODE");
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(vi.mocked(deleteObjectsBestEffort)).not.toHaveBeenCalled();
  });
});

describe("read services", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getListingsService returns rows for editor+", async () => {
    const result = await getListingsService({ orgId: ORG, role: "editor" });
    expect(result).toMatchObject({ ok: true, status: 200, data: [] });
  });

  it("getListingByIdService returns 404 when missing", async () => {
    vi.mocked(findListingById).mockResolvedValueOnce(null);
    const result = await getListingByIdService({ orgId: ORG, role: "editor" }, LISTING_ID);
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("getListingByIdService returns the row for editor", async () => {
    vi.mocked(findListingById).mockResolvedValueOnce(fakeListing());
    const result = await getListingByIdService({ orgId: ORG, role: "editor" }, LISTING_ID);
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("getListingsService passes visibility filter through to repository", async () => {
    vi.mocked(listListings).mockResolvedValueOnce([]);
    await getListingsService(
      { orgId: ORG, role: "manager" },
      { visibilityMode: "RESTRICTED" },
    );
    expect(listListings).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ visibilityMode: "RESTRICTED" }),
    );
  });
});

// NOTE: tests for the deleted code paths
//   - approveSourcedListingService (replaced by submissions.approveSubmissionService)
//   - rejectSourcedListingService / needsAmendmentSourcedListingService
//     (replaced by submissions.rejectSubmissionService / setSubmissionNeedsAmendmentService)
//   - approveChangesService / rejectChangesService
//     (the pendingChanges JSON mechanism is gone; agent amendments now go
//     through UnitSubmission)
// were removed in the inventory three-table refactor. Coverage moves to
// submissions/__tests__/submission.service.test.ts.
