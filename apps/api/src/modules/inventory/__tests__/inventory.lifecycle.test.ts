import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the DB before importing service code so the in-service
// `getDb()` reaches our stubbed prisma client.
const prismaMock = {
  listing: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  apartment: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
  // Required: apartment-owner fan-out now also propagates to active Carpark rows.
  // `findFirst` backs the owner resolvers' bay scans (R2-3): an active bay is an
  // inheritance fallback, an inactive one is conflict evidence. Defaults to
  // undefined => "no bay carries an owner", which is what these tests assume.
  carpark: {
    findFirst: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  property: {
    findFirst: vi.fn(),
    count: vi.fn(),
  },
  partyRole: {
    findFirst: vi.fn(),
  },
  auditLog: { create: vi.fn() },
  // $transaction executes the callback with the mock itself acting as tx.
  $transaction: vi.fn().mockImplementation((cb: (tx: typeof prismaMock) => Promise<unknown>) =>
    cb(prismaMock),
  ),
};

vi.mock("@kason/db", () => ({
  getDb: () => prismaMock,
}));

vi.mock("../occupancy-tenancy-sync", () => ({
  syncOccupancyTenancy: vi.fn(),
}));

// listing-mode helpers — mocked to "no info" so lifecycle tests that don't
// exercise kind-mismatch don't need roomType stubs in prismaMock.
vi.mock("../listing-mode", () => ({
  getUnitGroupMode: vi.fn().mockResolvedValue(null),
  resolveRoomTypeKind: vi.fn().mockResolvedValue(null),
}));

vi.mock("../inventory.repository", async () => {
  const actual = await vi.importActual<
    typeof import("../inventory.repository")
  >("../inventory.repository");
  return {
    ...actual,
    listProperties: vi.fn(),
    listListings: vi.fn(),
    findPropertyById: vi.fn(),
    findPropertyStatus: vi.fn(),
    findPropertyCodeConflict: vi.fn(),
    createProperty: vi.fn(),
    updateProperty: vi.fn(),
    updatePropertyPaxDeduction: vi.fn(),
    findListingById: vi.fn(),
    findListingTypeConflict: vi.fn(),
    findUnitDetail: vi.fn(),
    createListingTx: vi.fn(),
    updateListing: vi.fn(),
    // updateListingTx is kept as the actual implementation so the
    // field-mapping whitelist runs and lands on prismaMock.listing.update,
    // which tests can then assert on.
    updateListingTx: actual.updateListingTx,
    recomputeReadyNowForProperty: vi.fn(),
    replaceVisibilityGrants: vi.fn(),
  };
});

import {
  coerceToDraftIfIncomplete,
  createUnitService,
  deriveReadyNow,
  updatePropertyService,
  updateUnitService,
} from "../inventory.service";
import * as repo from "../inventory.repository";
import * as syncModule from "../occupancy-tenancy-sync";

const mockedRepo = vi.mocked(repo);

const session = {
  userId: "u-1",
  orgId: "org-1",
  role: "admin" as const,
};

const mockedSync = vi.mocked(syncModule);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.listing.findUnique.mockReset();
  prismaMock.listing.findMany.mockReset();
  prismaMock.listing.update.mockReset();
  prismaMock.listing.create.mockReset();
  prismaMock.apartment.findFirst.mockReset();
  prismaMock.apartment.create.mockReset();
  prismaMock.apartment.update.mockReset();
  prismaMock.property.findFirst.mockReset();
  // mockReset also clears the once-queue on the mocked repo functions so
  // a leftover mockResolvedValueOnce from a previous test can't bleed into
  // the next (clearAllMocks alone wipes only call history, not queues).
  mockedRepo.findListingTypeConflict.mockReset();
  mockedRepo.findPropertyStatus.mockReset();
  mockedRepo.findListingById.mockReset();
  mockedRepo.createListingTx.mockReset();
  mockedRepo.replaceVisibilityGrants.mockReset();
  prismaMock.$transaction.mockImplementation(
    (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock),
  );
  // Default: apartment doesn't exist yet — create path. Individual tests
  // that want to simulate an existing apartment can override with
  // mockResolvedValueOnce.
  prismaMock.apartment.findFirst.mockResolvedValue(null);
  prismaMock.apartment.create.mockResolvedValue({ id: "apt-new" });
});

// ---- deriveReadyNow boundary table ----------------------------------------

describe("deriveReadyNow", () => {
  it.each([
    [
      {
        propertyStatus: "active",
        listingStatus: "active",
        visibilityMode: "PUBLIC",
        occupancyStatus: "vacant",
      },
      true,
    ],
    [
      {
        propertyStatus: "archived",
        listingStatus: "active",
        visibilityMode: "PUBLIC",
        occupancyStatus: "vacant",
      },
      false,
    ],
    [
      {
        propertyStatus: "active",
        listingStatus: "active",
        visibilityMode: "PUBLIC",
        occupancyStatus: "occupied",
      },
      false,
    ],
    [
      {
        propertyStatus: "active",
        listingStatus: "draft",
        visibilityMode: "PUBLIC",
        occupancyStatus: "vacant",
      },
      false,
    ],
    [
      {
        propertyStatus: "active",
        listingStatus: "active",
        visibilityMode: "RESTRICTED",
        occupancyStatus: "vacant",
      },
      false,
    ],
    [
      {
        propertyStatus: "active",
        listingStatus: "archived",
        visibilityMode: "PUBLIC",
        occupancyStatus: "vacant",
      },
      false,
    ],
    [
      {
        propertyStatus: "active",
        listingStatus: "active",
        visibilityMode: "PUBLIC",
        occupancyStatus: "reserved",
      },
      false,
    ],
  ])("%j → %s", (input, expected) => {
    expect(deriveReadyNow(input)).toBe(expected);
  });
});

// ---- coerceToDraftIfIncomplete cases --------------------------------------

describe("coerceToDraftIfIncomplete", () => {
  it("coerces to draft when listingStatus=active and bedrooms missing", () => {
    const r = coerceToDraftIfIncomplete({
      listingStatus: "active",
      visibilityMode: "PUBLIC",
      bedrooms: undefined,
      bathrooms: 1,
      rentalRate: 1500,
    } as Parameters<typeof coerceToDraftIfIncomplete>[0]);
    expect(r.coerced).toBe(true);
    expect(r.missing).toEqual(["bedrooms"]);
    expect(r.effectiveInput.listingStatus).toBe("draft");
    expect(r.effectiveInput.visibilityMode).toBe("RESTRICTED");
  });

  it("coerces with multiple missing fields", () => {
    const r = coerceToDraftIfIncomplete({
      listingStatus: "active",
      bedrooms: null,
      bathrooms: undefined,
      rentalRate: null,
    });
    expect(r.coerced).toBe(true);
    expect(r.missing).toEqual(["bedrooms", "bathrooms", "rentalRate"]);
  });

  it("does not coerce when listingStatus=active and all required fields are present", () => {
    const r = coerceToDraftIfIncomplete({
      listingStatus: "active",
      bedrooms: 2,
      bathrooms: 1,
      rentalRate: 2500,
    });
    expect(r.coerced).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.effectiveInput.listingStatus).toBe("active");
  });

  it("does not coerce drafts even when fields are missing", () => {
    const r = coerceToDraftIfIncomplete({
      listingStatus: "draft",
      bedrooms: undefined,
      bathrooms: undefined,
      rentalRate: undefined,
    });
    expect(r.coerced).toBe(false);
    expect(r.missing).toEqual([]);
  });
});

// ---- createUnitService derives readyNow + coerce-to-draft -----------------

describe("createUnitService — derived readyNow", () => {
  it("derives readyNow=true when property+lifecycle are all active/PUBLIC/vacant", async () => {
    mockedRepo.findPropertyStatus.mockResolvedValueOnce("active");
    mockedRepo.findListingTypeConflict.mockResolvedValueOnce(null);
    mockedRepo.createListingTx.mockResolvedValueOnce({ id: "unit-1" } as never);

    await createUnitService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      unitCode: "U-1",
      unitType: "apartment",
      bedrooms: 2,
      bathrooms: 1,
      rentalRate: 2500,
      depositMonths: 2,
      utilitiesDepositMonths: 0.5,
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });

    const call = mockedRepo.createListingTx.mock.calls[0]?.[1];
    expect(call?.readyNow).toBe(true);
  });

  it("derives readyNow=false when property is archived", async () => {
    mockedRepo.findPropertyStatus.mockResolvedValueOnce("archived");
    mockedRepo.findListingTypeConflict.mockResolvedValueOnce(null);
    mockedRepo.createListingTx.mockResolvedValueOnce({ id: "unit-1" } as never);

    await createUnitService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      unitCode: "U-1",
      unitType: "apartment",
      bedrooms: 2,
      bathrooms: 1,
      rentalRate: 2500,
      depositMonths: 2,
      utilitiesDepositMonths: 0.5,
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });

    expect(mockedRepo.createListingTx.mock.calls[0]?.[1]?.readyNow).toBe(false);
  });

  it("coerces to draft + RESTRICTED when listingStatus=active but rentalRate missing", async () => {
    mockedRepo.findPropertyStatus.mockResolvedValueOnce("active");
    mockedRepo.findListingTypeConflict.mockResolvedValueOnce(null);
    mockedRepo.createListingTx.mockResolvedValueOnce({ id: "unit-1" } as never);

    const result = await createUnitService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      unitCode: "U-1",
      unitType: "apartment",
      bedrooms: 2,
      bathrooms: 1,
      // rentalRate missing
      depositMonths: 2,
      utilitiesDepositMonths: 0.5,
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.coercedToDraft).toBe(true);
      expect(result.missingFields).toEqual(["rentalRate"]);
    }
    const call = mockedRepo.createListingTx.mock.calls[0]?.[1];
    expect(call?.listingStatus).toBe("draft");
    expect(call?.visibilityMode).toBe("RESTRICTED");
    expect(call?.readyNow).toBe(false);
  });

  it("does not coerce when listingStatus=draft regardless of missing fields", async () => {
    mockedRepo.findPropertyStatus.mockResolvedValueOnce("active");
    mockedRepo.findListingTypeConflict.mockResolvedValueOnce(null);
    mockedRepo.createListingTx.mockResolvedValueOnce({ id: "unit-1" } as never);

    const result = await createUnitService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      unitCode: "U-1",
      unitType: "apartment",
      depositMonths: 2,
      utilitiesDepositMonths: 0.5,
      occupancyStatus: "vacant",
      listingStatus: "draft",
      visibilityMode: "PUBLIC",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.coercedToDraft).toBe(false);
  });

  it("ignores client-supplied readyNow (not in schema, but defensively recomputed)", async () => {
    mockedRepo.findPropertyStatus.mockResolvedValueOnce("active");
    mockedRepo.findListingTypeConflict.mockResolvedValueOnce(null);
    mockedRepo.createListingTx.mockResolvedValueOnce({ id: "unit-1" } as never);

    // readyNow is derived from (propertyStatus, listingStatus, visibilityMode,
    // occupancyStatus): active + active + RESTRICTED + vacant → false. RESTRICTED
    // (not occupancy) is the lever that forces false here, so this stays a valid
    // vacant create — an occupied create now REQUIRES the tenancy trio (Finding 2)
    // and must never persist an occupied Listing with no Tenancy behind it.
    await createUnitService(
      session,
      {
        propertyId: "00000000-0000-0000-0000-000000000001",
        unitCode: "U-1",
        unitType: "apartment",
        occupancyStatus: "vacant",
        listingStatus: "active",
        visibilityMode: "RESTRICTED",
        bedrooms: 2,
        bathrooms: 1,
        rentalRate: 1500,
        readyNow: true,
      } as unknown as Parameters<typeof createUnitService>[1],
    );

    expect(mockedRepo.createListingTx.mock.calls[0]?.[1]?.readyNow).toBe(false);
  });
});

// ---- createUnitService — listingType + apartmentId uniqueness -------------

describe("createUnitService — (apartmentId, listingType) uniqueness", () => {
  it("scopes the conflict check to (apartmentId, listingType) so the same unitCode can host multiple listingTypes", async () => {
    mockedRepo.findPropertyStatus.mockResolvedValueOnce("active");
    mockedRepo.findListingTypeConflict.mockResolvedValueOnce(null);
    mockedRepo.createListingTx.mockResolvedValueOnce({ id: "unit-master" } as never);
    // Existing apartment present so the conflict path can fire.
    prismaMock.apartment.findFirst.mockResolvedValueOnce({ id: "apt-existing" });

    await createUnitService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      unitCode: "A-11-43",
      unitType: "Master",
      bedrooms: 1,
      bathrooms: 1,
      rentalRate: 1200,
      depositMonths: 2,
      utilitiesDepositMonths: 0.5,
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });

    expect(mockedRepo.findListingTypeConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        apartmentId: "apt-existing",
        listingType: "Master",
      }),
    );
  });

  it("trims unitCode + unitType before persisting and conflict-checking", async () => {
    mockedRepo.findPropertyStatus.mockResolvedValueOnce("active");
    mockedRepo.findListingTypeConflict.mockResolvedValueOnce(null);
    mockedRepo.createListingTx.mockResolvedValueOnce({ id: "unit-1" } as never);

    await createUnitService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      unitCode: "  A-11-43  ",
      unitType: "  Master  ",
      bedrooms: 1,
      bathrooms: 1,
      rentalRate: 1200,
      depositMonths: 2,
      utilitiesDepositMonths: 0.5,
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });

    const create = mockedRepo.createListingTx.mock.calls[0]?.[1];
    expect(create?.listingType).toBe("Master");
  });

  it("rejects with 409 when a Listing already has the same listingType in this apartment", async () => {
    mockedRepo.findPropertyStatus.mockResolvedValueOnce("active");
    mockedRepo.findListingTypeConflict.mockResolvedValueOnce({ id: "existing" } as never);
    prismaMock.apartment.findFirst.mockResolvedValueOnce({ id: "apt-existing" });

    const r = await createUnitService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      unitCode: "A-11-43",
      unitType: "Master",
      bedrooms: 1,
      bathrooms: 1,
      rentalRate: 1200,
      depositMonths: 2,
      utilitiesDepositMonths: 0.5,
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toMatch(/unit type already exists/i);
    }
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
  });
});

// ---- createUnitService — deposit + parking field forwarding ---------------

describe("createUnitService — deposit + parking fields", () => {
  it("forwards all new optional fields to createListingTx", async () => {
    mockedRepo.findPropertyStatus.mockResolvedValueOnce("active");
    mockedRepo.findListingTypeConflict.mockResolvedValueOnce(null);
    mockedRepo.createListingTx.mockResolvedValueOnce({ id: "unit-1" } as never);

    const result = await createUnitService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      unitCode: "DEPOSIT-1",
      unitType: "studio",
      rentalRate: 1000,
      depositMonths: 2,
      utilitiesDepositMonths: 0.5,
      accessCardDepositPerPcs: 100,
      accessCardQuantity: 2,
      parkingQuantity: 2,
      parkingNumbers: ["B2-145", "B3-088"],
    });

    expect(result.ok).toBe(true);
    const call = mockedRepo.createListingTx.mock.calls[0]?.[1];
    expect(call?.depositMonths).toBe(2);
    expect(call?.utilitiesDepositMonths).toBe(0.5);
    expect(call?.accessCardDepositPerPcs).toBe(100);
    expect(call?.accessCardQuantity).toBe(2);
    expect(call?.parkingQuantity).toBe(2);
    expect(call?.parkingNumbers).toEqual(["B2-145", "B3-088"]);
  });

  it("preserves half-month rental deposit (2.5 → 2.5, not rounded to 3)", async () => {
    mockedRepo.findPropertyStatus.mockResolvedValueOnce("active");
    mockedRepo.findListingTypeConflict.mockResolvedValueOnce(null);
    mockedRepo.createListingTx.mockResolvedValueOnce({ id: "unit-half" } as never);

    await createUnitService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      unitCode: "DEPOSIT-HALF",
      unitType: "studio",
      rentalRate: 1000,
      depositMonths: 2.5,
      utilitiesDepositMonths: 0.5,
    });

    const call = mockedRepo.createListingTx.mock.calls[0]?.[1];
    expect(call?.depositMonths).toBe(2.5);
  });

  it("omits still-optional fields when not provided (does not write defaults)", async () => {
    mockedRepo.findPropertyStatus.mockResolvedValueOnce("active");
    mockedRepo.findListingTypeConflict.mockResolvedValueOnce(null);
    mockedRepo.createListingTx.mockResolvedValueOnce({ id: "unit-2" } as never);

    await createUnitService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      unitCode: "NO-OPTIONAL",
      unitType: "studio",
      rentalRate: 1000,
      depositMonths: 2,
      utilitiesDepositMonths: 0.5,
    });

    const call = mockedRepo.createListingTx.mock.calls[0]?.[1];
    expect(call?.depositMonths).toBe(2);
    expect(call?.utilitiesDepositMonths).toBe(0.5);
    expect(call?.accessCardDepositPerPcs).toBeUndefined();
    expect(call?.accessCardQuantity).toBeUndefined();
    expect(call?.parkingQuantity).toBeUndefined();
    expect(call?.parkingNumbers).toBeUndefined();
  });
});

// ---- updateUnitService cascade-aware derive --------------------------------

describe("updateUnitService — derived readyNow", () => {
  it("recomputes readyNow on each update from merged lifecycle", async () => {
    mockedRepo.findListingById.mockResolvedValueOnce({
      id: "unit-1",
      apartmentId: "apt-1",
      propertyId: "p-1",
      organizationId: "org-1",
      unitCode: "U-1",
      unitType: "apartment",
      occupancyStatus: "vacant",
      listingStatus: "draft",
      visibilityMode: "PUBLIC",
      rentalRate: null,
    } as never);

    prismaMock.listing.findUnique.mockResolvedValueOnce({
      occupancyStatus: "vacant",
      listingStatus: "draft",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValueOnce({ status: "active" });

    await updateUnitService(session, {
      unitId: "00000000-0000-0000-0000-000000000010",
      bedrooms: 2,
      bathrooms: 1,
      rentalRate: 1500,
      listingStatus: "active",
    });

    const call = prismaMock.listing.update.mock.calls[0];
    expect(call?.[0]?.data?.readyNow).toBe(true);
  });

  it("readyNow=false when occupancyStatus flips to occupied (with required trio)", async () => {
    mockedRepo.findListingById.mockResolvedValueOnce({
      id: "unit-1",
      apartmentId: "apt-1",
      propertyId: "p-1",
      organizationId: "org-1",
      unitCode: "U-1",
      unitType: "apartment",
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
      rentalRate: 2000,
      // Owner re-point: a unit must have an owner to be marked occupied.
      ownerPartyId: "owner-1",
    } as never);

    prismaMock.listing.findUnique.mockResolvedValueOnce({
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValueOnce({ status: "active" });

    await updateUnitService(session, {
      unitId: "00000000-0000-0000-0000-000000000010",
      occupancyStatus: "occupied",
      tenantPartyId: "00000000-0000-0000-0000-000000000099",
      moveInDate: "2026-04-01",
      moveOutDate: "2026-09-30",
    } as never);

    expect(prismaMock.listing.update.mock.calls[0]?.[0]?.data?.readyNow).toBe(false);
  });
});

// ---- property-archive cascade ---------------------------------------------

describe("updatePropertyService — cascade hook", () => {
  it("calls recomputeReadyNowForProperty when property.status changes", async () => {
    mockedRepo.findPropertyById.mockResolvedValueOnce({ id: "p-1" } as never);
    mockedRepo.findPropertyStatus
      .mockResolvedValueOnce("active")
      .mockResolvedValueOnce("archived");

    await updatePropertyService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      name: "Old name",
    });

    expect(mockedRepo.recomputeReadyNowForProperty).toHaveBeenCalledWith(
      "org-1",
      "00000000-0000-0000-0000-000000000001",
      expect.any(Function),
    );
  });

  it("does NOT call cascade when status is unchanged", async () => {
    mockedRepo.findPropertyById.mockResolvedValueOnce({ id: "p-1" } as never);
    mockedRepo.findPropertyStatus
      .mockResolvedValueOnce("active")
      .mockResolvedValueOnce("active");

    await updatePropertyService(session, {
      propertyId: "00000000-0000-0000-0000-000000000001",
      name: "Different name",
    });

    expect(mockedRepo.recomputeReadyNowForProperty).not.toHaveBeenCalled();
  });
});

// ---- updateUnitService — occupancy tenancy sync ---------------------------

describe("updateUnitService — occupancy tenancy sync", () => {
  const existingListing = {
    id: "unit-1",
    apartmentId: "apt-1",
    propertyId: "prop-1",
    organizationId: "org-1",
    unitCode: "A-22-05",
    unitType: "Medium",
    occupancyStatus: "vacant",
    listingStatus: "active",
    visibilityMode: "PUBLIC",
    rentalRate: 2600,
    // Owner re-point: a unit must have an owner to be marked occupied.
    ownerPartyId: "owner-1",
  };

  const existingOccupiedListing = {
    ...existingListing,
    occupancyStatus: "occupied",
  };

  it("calls syncOccupancyTenancy when occupancyStatus is in the patch", async () => {
    mockedRepo.findListingById.mockResolvedValue(existingListing as never);
    prismaMock.listing.findUnique.mockResolvedValue({
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValue({ status: "active" });

    await updateUnitService(
      { orgId: "org-1", userId: "u1", role: "admin" } as never,
      {
        unitId: "unit-1",
        occupancyStatus: "occupied",
        tenantPartyId: "00000000-0000-0000-0000-000000000099",
        moveInDate: "2026-04-25",
        moveOutDate: "2026-05-20",
      } as never,
    );

    expect(mockedSync.syncOccupancyTenancy).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        incoming: expect.objectContaining({
          occupancyStatus: "occupied",
          tenantPartyId: "00000000-0000-0000-0000-000000000099",
        }),
      }),
    );
  });

  it("does NOT call syncOccupancyTenancy when occupancyStatus is absent from the patch", async () => {
    mockedRepo.findListingById.mockResolvedValue(existingListing as never);
    prismaMock.listing.findUnique.mockResolvedValue({
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValue({ status: "active" });

    await updateUnitService({ orgId: "org-1", userId: "u1", role: "admin" } as never, {
      unitId: "unit-1",
      bedrooms: 3,
    } as never);

    expect(mockedSync.syncOccupancyTenancy).not.toHaveBeenCalled();
  });

  it("returns 400 when transitioning vacant → occupied without trio fields (transition gate)", async () => {
    mockedRepo.findListingById.mockResolvedValue(existingListing as never);
    prismaMock.listing.findUnique.mockResolvedValue({
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValue({ status: "active" });

    const result = await updateUnitService(
      { orgId: "org-1", userId: "u1", role: "admin" } as never,
      { unitId: "unit-1", occupancyStatus: "occupied" } as never,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/tenant.*name.*move-in.*move-out|trio|required/i);
    }
  });

  it("ALLOWS pass-through update on already-occupied listing without trio (no transition)", async () => {
    mockedRepo.findListingById.mockResolvedValue(existingOccupiedListing as never);
    prismaMock.listing.findUnique.mockResolvedValue({
      occupancyStatus: "occupied",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValue({ status: "active" });

    const result = await updateUnitService(
      { orgId: "org-1", userId: "u1", role: "admin" } as never,
      { unitId: "unit-1", occupancyStatus: "occupied", bedrooms: 4 } as never,
    );

    expect(result.ok).toBe(true);
  });

  it("BLOCKS marking a unit occupied when it has no assigned owner (409 UNIT_HAS_NO_OWNER, no sync)", async () => {
    // Owner re-point: owner drives money attribution, so a unit with no owner
    // cannot be marked occupied. The guard returns a structured 409 BEFORE the
    // transaction, and syncOccupancyTenancy is never called.
    mockedRepo.findListingById.mockResolvedValue({
      ...existingListing,
      ownerPartyId: null,
    } as never);
    prismaMock.listing.findUnique.mockResolvedValue({
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValue({ status: "active" });

    const result = await updateUnitService(
      { orgId: "org-1", userId: "u1", role: "admin" } as never,
      {
        unitId: "unit-1",
        occupancyStatus: "occupied",
        tenantPartyId: "00000000-0000-0000-0000-000000000099",
        moveInDate: "2026-04-25",
        moveOutDate: "2026-05-20",
      } as never,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect((result as { code?: string }).code).toBe("UNIT_HAS_NO_OWNER");
    }
    expect(mockedSync.syncOccupancyTenancy).not.toHaveBeenCalled();
  });

  it("ALLOWS marking occupied when the patch assigns an owner in the same update", async () => {
    // The effective owner is the INCOMING ownerPartyId even if the unit currently
    // has none — so assign-owner + mark-occupied in one PUT is permitted.
    mockedRepo.findListingById.mockResolvedValue({
      ...existingListing,
      ownerPartyId: null,
    } as never);
    prismaMock.partyRole.findFirst.mockResolvedValue({ id: "role-1" });
    prismaMock.listing.findUnique.mockResolvedValue({
      occupancyStatus: "vacant",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValue({ status: "active" });

    const result = await updateUnitService(
      { orgId: "org-1", userId: "u1", role: "admin" } as never,
      {
        unitId: "unit-1",
        ownerPartyId: "owner-party-9",
        occupancyStatus: "occupied",
        tenantPartyId: "00000000-0000-0000-0000-000000000099",
        moveInDate: "2026-04-25",
        moveOutDate: "2026-05-20",
      } as never,
    );

    expect(result.ok).toBe(true);
    // sync called with the effective (incoming) owner.
    expect(mockedSync.syncOccupancyTenancy).toHaveBeenCalledWith(
      expect.objectContaining({
        unit: expect.objectContaining({ ownerPartyId: "owner-party-9" }),
      }),
    );
  });

  it.skip("maps description → publishedDescription when updating (TODO: rewrite for Apartment shape — description now writes to Apartment, not Listing)", async () => {
    // Description lives on Apartment now. The legacy test expected the
    // service to map description → publishedDescription on the Listing
    // update payload; in the new model description ONLY writes to
    // Apartment, and only when applyToExistingSiblings is set. A direct
    // single-row Listing edit no longer touches publishedDescription.
    //
    // Skipped pending a rewrite that exercises the apartment.update path.
  });
});
