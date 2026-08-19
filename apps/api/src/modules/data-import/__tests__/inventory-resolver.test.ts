import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  propertyCodeFor,
  ensureProperty,
  ensureRoomListing,
  ensureCarpark,
} from "../inventory-resolver";
import type { ImportSession } from "../types";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../inventory/inventory.service", () => ({
  createPropertyService: vi.fn(),
  createUnitsBatchService: vi.fn(),
}));

vi.mock("../repository", () => ({
  findPropertyByCode: vi.fn(),
  findApartmentByCode: vi.fn(),
  findListing: vi.fn(),
}));

// getDb mock: $transaction calls the callback with fakeTx.
// The outer db object exposes carpark.findFirst and apartment.findFirst
// (used by ensureCarpark for idempotency + owner resolution).
const fakeTx = {
  carpark: {
    create: vi.fn().mockResolvedValue({ id: "cp-bay-new" }),
  },
  auditLog: {
    create: vi.fn().mockResolvedValue(undefined),
  },
};

const mockDb = {
  carpark: {
    findFirst: vi.fn(),
  },
  apartment: {
    findFirst: vi.fn(),
  },
  $transaction: vi.fn(async (fn: (tx: typeof fakeTx) => Promise<unknown>) =>
    fn(fakeTx),
  ),
};

vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => mockDb),
}));

// ---------------------------------------------------------------------------
// Import mocked modules for assertion
// ---------------------------------------------------------------------------

import * as inventoryService from "../../inventory/inventory.service";
import * as repository from "../repository";
import * as auditLib from "../../../lib/audit";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SESSION: ImportSession = {
  orgId: "org-1",
  userId: "user-1",
  role: "admin",
  userType: "operator",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("propertyCodeFor", () => {
  it('converts "UCSI 2" → "UCSI-2"', () => {
    expect(propertyCodeFor("UCSI 2")).toBe("UCSI-2");
  });

  it("uppercases and strips leading/trailing hyphens", () => {
    expect(propertyCodeFor("  Riana South  ")).toBe("RIANA-SOUTH");
  });

  it("collapses multiple special chars into one hyphen", () => {
    expect(propertyCodeFor("Other -- Condos!!")).toBe("OTHER-CONDOS");
  });

  it("slices to 24 chars max", () => {
    const long = "A".repeat(30);
    expect(propertyCodeFor(long)).toHaveLength(24);
  });
});

// ---------------------------------------------------------------------------

describe("ensureProperty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeTx.carpark.create.mockResolvedValue({ id: "cp-bay-new" });
    fakeTx.auditLog.create.mockResolvedValue(undefined);
  });

  it("returns existing id without calling createPropertyService", async () => {
    vi.mocked(repository.findPropertyByCode).mockResolvedValue({ id: "prop-existing" });

    const id = await ensureProperty(SESSION, "PV9");

    expect(id).toBe("prop-existing");
    expect(inventoryService.createPropertyService).not.toHaveBeenCalled();
  });

  it("calls createPropertyService and returns new id when property is missing", async () => {
    vi.mocked(repository.findPropertyByCode).mockResolvedValue(null);
    vi.mocked(inventoryService.createPropertyService).mockResolvedValue({
      ok: true,
      status: 201,
      data: { id: "prop-new" },
    });

    const id = await ensureProperty(SESSION, "PV9");

    expect(inventoryService.createPropertyService).toHaveBeenCalledOnce();
    const [callSession, callInput] = vi.mocked(inventoryService.createPropertyService).mock.calls[0];
    expect(callSession).toMatchObject({ orgId: "org-1", userId: "user-1", role: "admin" });
    expect(callInput).toMatchObject({
      name: "PV9",
      propertyCode: "PV9",
      propertyType: "condominium",
    });
    expect(id).toBe("prop-new");
  });

  it("re-queries on 409 and returns existing id (race condition)", async () => {
    vi.mocked(repository.findPropertyByCode)
      .mockResolvedValueOnce(null) // first check
      .mockResolvedValueOnce({ id: "prop-race" }); // re-query after 409
    vi.mocked(inventoryService.createPropertyService).mockResolvedValue({
      ok: false,
      status: 409,
      error: "Property code already exists",
    });

    const id = await ensureProperty(SESSION, "PV9");
    expect(id).toBe("prop-race");
  });

  it("throws when createPropertyService fails and re-query finds nothing", async () => {
    vi.mocked(repository.findPropertyByCode).mockResolvedValue(null);
    vi.mocked(inventoryService.createPropertyService).mockResolvedValue({
      ok: false,
      status: 400,
      error: "Some error",
    });

    await expect(ensureProperty(SESSION, "PV9")).rejects.toThrow(
      "ensureProperty failed for PV9",
    );
  });
});

// ---------------------------------------------------------------------------

describe("ensureRoomListing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeTx.carpark.create.mockResolvedValue({ id: "cp-bay-new" });
    fakeTx.auditLog.create.mockResolvedValue(undefined);
  });

  it("returns {created:false} when listing already exists without calling batch service", async () => {
    vi.mocked(repository.findApartmentByCode).mockResolvedValue({ id: "apt-1" });
    vi.mocked(repository.findListing).mockResolvedValue({ id: "listing-1" });

    const result = await ensureRoomListing(SESSION, "prop-1", "B-08-08", "Master", 1200);

    expect(result).toEqual({ id: "listing-1", created: false });
    expect(inventoryService.createUnitsBatchService).not.toHaveBeenCalled();
  });

  it("calls createUnitsBatchService and returns {created:true} when listing is missing", async () => {
    // First findApartmentByCode call: before batch (apt exists but no listing)
    vi.mocked(repository.findApartmentByCode).mockResolvedValue({ id: "apt-1" });
    // findListing: first call = null (not found), second call = found after create
    vi.mocked(repository.findListing)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "listing-new" });
    vi.mocked(inventoryService.createUnitsBatchService).mockResolvedValue({
      ok: true,
      status: 201,
      data: { ids: ["listing-new"], updatedIds: [] },
    });

    const result = await ensureRoomListing(SESSION, "prop-1", "B-08-08", "Master", 1200);

    expect(inventoryService.createUnitsBatchService).toHaveBeenCalledOnce();
    const [, input] = vi.mocked(inventoryService.createUnitsBatchService).mock.calls[0];
    expect(input.shared).toMatchObject({ propertyId: "prop-1", unitCode: "B-08-08" });
    expect(input.rooms[0]).toMatchObject({
      unitType: "Master",
      rentalRate: 1200,
      depositMonths: 2,
      utilitiesDepositMonths: 0,
    });
    expect(result).toEqual({ id: "listing-new", created: true });
  });

  it("passes rentalRate:undefined when rentalRate is null", async () => {
    // First call: no existing apt (skip pre-check). Second call: apt exists (re-query after create).
    vi.mocked(repository.findApartmentByCode)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "apt-x" });
    vi.mocked(repository.findListing).mockResolvedValue({ id: "listing-x" });
    vi.mocked(inventoryService.createUnitsBatchService).mockResolvedValue({
      ok: true,
      status: 201,
      data: { ids: ["listing-x"], updatedIds: [] },
    });

    await ensureRoomListing(SESSION, "prop-1", "A-01", "Single", null);

    const [, input] = vi.mocked(inventoryService.createUnitsBatchService).mock.calls[0];
    expect(input.rooms[0].rentalRate).toBeUndefined();
  });

  it("throws when createUnitsBatchService fails", async () => {
    vi.mocked(repository.findApartmentByCode).mockResolvedValue(null);
    vi.mocked(inventoryService.createUnitsBatchService).mockResolvedValue({
      ok: false,
      status: 409,
      error: "Unit code + types already exist: Master",
    });

    await expect(
      ensureRoomListing(SESSION, "prop-1", "A-01", "Master", null),
    ).rejects.toThrow("ensureRoomListing failed A-01/Master");
  });
});

// ---------------------------------------------------------------------------

describe("ensureCarpark", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeTx.carpark.create.mockResolvedValue({ id: "cp-bay-new" });
    fakeTx.auditLog.create.mockResolvedValue(undefined);
    mockDb.carpark.findFirst.mockReset();
    mockDb.apartment.findFirst.mockReset();
  });

  it("returns {created:false} when carpark bay already exists (idempotent)", async () => {
    vi.mocked(repository.findApartmentByCode).mockResolvedValue({ id: "apt-1" });
    mockDb.carpark.findFirst.mockResolvedValue({ id: "cp-existing" });

    const result = await ensureCarpark(SESSION, "prop-1", "B-08-08", "B-08-08", 120);

    expect(result).toEqual({ id: "cp-existing", created: false });
    expect(fakeTx.carpark.create).not.toHaveBeenCalled();
    expect(auditLib.recordAudit).not.toHaveBeenCalled();
  });

  it("creates carpark bay with correct fields, records audit, returns {created:true}", async () => {
    vi.mocked(repository.findApartmentByCode).mockResolvedValue({ id: "apt-1" });
    mockDb.carpark.findFirst.mockResolvedValue(null); // no existing bay
    mockDb.apartment.findFirst.mockResolvedValue({
      listings: [{ ownerPartyId: "owner-party-1" }],
    });
    fakeTx.carpark.create.mockResolvedValue({ id: "cp-bay-new" });

    const result = await ensureCarpark(SESSION, "prop-1", "B-08-08", "B-08-08", 120);

    // Bay was created in the transaction.
    expect(fakeTx.carpark.create).toHaveBeenCalledOnce();
    const createArg = (fakeTx.carpark.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect(createArg.data).toMatchObject({
      organizationId: "org-1",
      propertyId: "prop-1",
      apartmentId: "apt-1",
      ownerPartyId: "owner-party-1",
      label: "B-08-08",
      monthlyRate: 120,
      status: "available",
    });

    // Audit was recorded.
    expect(auditLib.recordAudit).toHaveBeenCalledOnce();
    const auditCall = vi.mocked(auditLib.recordAudit).mock.calls[0];
    expect(auditCall[1]).toMatchObject({
      organizationId: "org-1",
      actorUserId: "user-1",
      actorRole: "admin",
      action: "data-import.carpark.create",
      entityType: "Carpark",
      entityId: "cp-bay-new",
    });

    expect(result).toEqual({ id: "cp-bay-new", created: true });
  });

  it("sets ownerPartyId null when apartment has no owner listing", async () => {
    vi.mocked(repository.findApartmentByCode).mockResolvedValue({ id: "apt-1" });
    mockDb.carpark.findFirst.mockResolvedValue(null);
    mockDb.apartment.findFirst.mockResolvedValue({ listings: [] });
    fakeTx.carpark.create.mockResolvedValue({ id: "cp-no-owner" });

    await ensureCarpark(SESSION, "prop-1", "A-01", "A-01", 120);

    const createArg = (fakeTx.carpark.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect(createArg.data.ownerPartyId).toBeNull();
  });

  it("throws when apartment is not found for the unit", async () => {
    vi.mocked(repository.findApartmentByCode).mockResolvedValue(null);

    await expect(
      ensureCarpark(SESSION, "prop-1", "A-01", "A-01", 120),
    ).rejects.toThrow("ensureCarpark: apartment not found for unit A-01");
  });

  it("queries carpark by org + apartmentId + label for the idempotency check", async () => {
    vi.mocked(repository.findApartmentByCode).mockResolvedValue({ id: "apt-2" });
    mockDb.carpark.findFirst.mockResolvedValue(null);
    mockDb.apartment.findFirst.mockResolvedValue({ listings: [] });
    fakeTx.carpark.create.mockResolvedValue({ id: "cp-new" });

    await ensureCarpark(SESSION, "prop-1", "C-01", "C-01", 150);

    expect(mockDb.carpark.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          apartmentId: "apt-2",
          label: "C-01",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// F1 — ensureCarpark (bulk Excel import path) must not mint a bay carrying an
// ARCHIVED listing's stale owner.
//
// `mockDb.apartment.findFirst` here HONOURS the nested `listings` where/orderBy/
// take, unlike the dumb stubs above. A resolver that omits the `listingStatus`
// filter sees the archived row and fails.
// ---------------------------------------------------------------------------

type ListingRow = { id: string; ownerPartyId: string | null; listingStatus: string };

function stubApartmentListings(rows: ListingRow[]) {
  mockDb.apartment.findFirst.mockImplementation((args: any) => {
    const nested = args?.select?.listings ?? {};
    const where = nested.where ?? {};
    let out = rows;
    if (where.ownerPartyId?.not === null) out = out.filter((r) => r.ownerPartyId !== null);
    if (where.listingStatus?.not) out = out.filter((r) => r.listingStatus !== where.listingStatus.not);
    if (nested.orderBy?.id === "asc") out = [...out].sort((a, b) => a.id.localeCompare(b.id));
    const take = nested.take ?? out.length;
    return Promise.resolve({
      listings: out.slice(0, take).map((r) => ({ ownerPartyId: r.ownerPartyId })),
    });
  });
}

async function createdBayData() {
  await ensureCarpark(SESSION, "prop-1", "B-08-08", "B-08-08", 120);
  const call = fakeTx.carpark.create.mock.calls[0] as [{ data: Record<string, unknown> }];
  return call[0].data;
}

describe("ensureCarpark — F1 archived-owner guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeTx.carpark.create.mockResolvedValue({ id: "cp-bay-new" });
    fakeTx.auditLog.create.mockResolvedValue(undefined);
    mockDb.carpark.findFirst.mockReset();
    mockDb.apartment.findFirst.mockReset();
    vi.mocked(repository.findApartmentByCode).mockResolvedValue({ id: "apt-1" });
    mockDb.carpark.findFirst.mockResolvedValue(null); // no existing bay
  });

  it("is born OWNERLESS when the apartment's only owned listing is ARCHIVED", async () => {
    stubApartmentListings([{ id: "l-1", ownerPartyId: "owner-stale", listingStatus: "archived" }]);
    expect((await createdBayData()).ownerPartyId).toBeNull();
  });

  it("skips the archived row and takes the active one when both exist", async () => {
    stubApartmentListings([
      { id: "l-1", ownerPartyId: "owner-stale", listingStatus: "archived" },
      { id: "l-2", ownerPartyId: "owner-current", listingStatus: "active" },
    ]);
    expect((await createdBayData()).ownerPartyId).toBe("owner-current");
  });

  // ---- Bulk-import behaviour invariance -----------------------------------
  // The import path's outcome must be UNCHANGED for any apartment whose listings
  // are all non-archived: the added filter removes no candidate, and the owner is
  // apartment-scoped so every owned candidate carries the same party.

  it("is UNCHANGED for a single non-archived owned listing", async () => {
    stubApartmentListings([{ id: "l-1", ownerPartyId: "owner-party-1", listingStatus: "active" }]);
    expect((await createdBayData()).ownerPartyId).toBe("owner-party-1");
  });

  it("is UNCHANGED for several non-archived listings that share one owner", async () => {
    stubApartmentListings([
      { id: "l-2", ownerPartyId: "owner-party-1", listingStatus: "draft" },
      { id: "l-1", ownerPartyId: "owner-party-1", listingStatus: "active" },
      { id: "l-3", ownerPartyId: null, listingStatus: "active" },
    ]);
    expect((await createdBayData()).ownerPartyId).toBe("owner-party-1");
  });

  it("is UNCHANGED (ownerless) when no listing carries an owner", async () => {
    stubApartmentListings([{ id: "l-1", ownerPartyId: null, listingStatus: "active" }]);
    expect((await createdBayData()).ownerPartyId).toBeNull();
  });

  it("pins a deterministic orderBy on the owner-derivation scan", async () => {
    stubApartmentListings([]);
    await createdBayData();
    const args = mockDb.apartment.findFirst.mock.calls[0][0];
    expect(args.select.listings.orderBy).toEqual({ id: "asc" });
    expect(args.select.listings.where).toMatchObject({
      ownerPartyId: { not: null },
      listingStatus: { not: "archived" },
    });
  });
});
