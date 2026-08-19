import { describe, it, expect, vi, beforeEach } from "vitest";

const { findManyMock, findFirstMock, createMock, updateMock, deleteMock, queryRawUnsafeMock, executeRawUnsafeMock, transactionMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  findFirstMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  queryRawUnsafeMock: vi.fn(),
  executeRawUnsafeMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("@kason/db", () => ({
  getDb: () => ({
    amenity: {
      findMany: findManyMock,
      findFirst: findFirstMock,
      create: createMock,
      update: updateMock,
      delete: deleteMock,
    },
    // amenities live on Apartment post-refactor — the usage preview reads
    // from db.apartment.findMany. We reuse findManyMock for both the
    // amenity catalog and the apartment usage list (the tests scope each
    // call by mockResolvedValueOnce/-Value as needed).
    apartment: {
      findMany: findManyMock,
    },
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: executeRawUnsafeMock,
    $transaction: transactionMock,
  }),
}));

import {
  listAmenitiesRepo,
  findAmenityById,
  createAmenityRow,
  updateAmenityRow,
  deleteAmenityRow,
  getAmenityUsageRepo,
  assertAmenitiesBelongToOrgRepo,
} from "../amenities.repository";

const ORG = "org-1";

beforeEach(() => {
  findManyMock.mockReset();
  findFirstMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  transactionMock.mockReset();
});

describe("listAmenitiesRepo", () => {
  it("scopes by orgId, sorts by sortOrder then name", async () => {
    findManyMock.mockResolvedValue([]);
    await listAmenitiesRepo(ORG);
    expect(findManyMock).toHaveBeenCalledWith({
      where: { organizationId: ORG },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
  });

  it("activeOnly=true filters by isActive=true", async () => {
    findManyMock.mockResolvedValue([]);
    await listAmenitiesRepo(ORG, { activeOnly: true });
    expect(findManyMock.mock.calls[0][0].where).toEqual({ organizationId: ORG, isActive: true });
  });
});

describe("assertAmenitiesBelongToOrgRepo", () => {
  // The Amenity.id column is a Postgres uuid. Real catalog ids are UUIDs;
  // legacy Apartment.amenities rows can still hold pre-catalog free-string
  // slugs ("pool", "gym"). Feeding a non-uuid into `id: { in: [...] }` makes
  // Postgres throw `invalid input syntax for type uuid` (Prisma P2023) — which
  // previously escaped as a 500 on the inventory batch / create / edit paths.
  const A1 = "11111111-1111-4111-8111-111111111111";
  const A2 = "22222222-2222-4222-8222-222222222222";
  const OTHER = "99999999-9999-4999-8999-999999999999";

  it("returns ok:true on empty input", async () => {
    const result = await assertAmenitiesBelongToOrgRepo(ORG, []);
    expect(result).toEqual({ ok: true });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns ok:true when every catalog UUID is found in the org", async () => {
    findManyMock.mockResolvedValue([{ id: A1 }, { id: A2 }]);
    const result = await assertAmenitiesBelongToOrgRepo(ORG, [A1, A2]);
    expect(result).toEqual({ ok: true });
    expect(findManyMock).toHaveBeenCalledWith({
      where: { organizationId: ORG, id: { in: [A1, A2] } },
      select: { id: true },
    });
  });

  it("returns ok:false with missingIds when a catalog UUID is absent", async () => {
    findManyMock.mockResolvedValue([{ id: A1 }]);
    const result = await assertAmenitiesBelongToOrgRepo(ORG, [A1, OTHER]);
    expect(result).toEqual({ ok: false, missingIds: [OTHER] });
  });

  // --- Regression (the batch-add 500): legacy non-uuid amenity tokens must
  // never be fed into the uuid `id IN (...)` query. ---

  it("passes through an all-legacy (non-uuid) amenity list without querying (ok:true)", async () => {
    const result = await assertAmenitiesBelongToOrgRepo(ORG, ["parking", "gym", "pool"]);
    expect(result).toEqual({ ok: true });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("queries ONLY the uuid-shaped ids when the list mixes legacy slugs + catalog UUIDs", async () => {
    findManyMock.mockResolvedValue([{ id: A1 }]);
    const result = await assertAmenitiesBelongToOrgRepo(ORG, ["pool", A1]);
    expect(result).toEqual({ ok: true });
    expect(findManyMock).toHaveBeenCalledWith({
      where: { organizationId: ORG, id: { in: [A1] } },
      select: { id: true },
    });
  });

  it("reports only the missing UUID (legacy slug is ignored) for a mixed list with an absent catalog id", async () => {
    findManyMock.mockResolvedValue([]);
    const result = await assertAmenitiesBelongToOrgRepo(ORG, ["pool", OTHER]);
    expect(result).toEqual({ ok: false, missingIds: [OTHER] });
  });
});

describe("getAmenityUsageRepo", () => {
  it("returns count + first 100 units with unitCode + propertyName", async () => {
    queryRawUnsafeMock.mockResolvedValue([{ count: 47n }]);
    findManyMock.mockResolvedValue([
      { id: "u1", unitCode: "A-1", property: { name: "Building A" } },
      { id: "u2", unitCode: "A-2", property: { name: "Building A" } },
    ]);
    const result = await getAmenityUsageRepo(ORG, "amenity-1");
    expect(result.count).toBe(47);
    expect(result.units).toEqual([
      { id: "u1", unitCode: "A-1", propertyName: "Building A" },
      { id: "u2", unitCode: "A-2", propertyName: "Building A" },
    ]);
  });

  it("falls back to '(unknown)' when property is missing", async () => {
    queryRawUnsafeMock.mockResolvedValue([{ count: 1n }]);
    findManyMock.mockResolvedValue([{ id: "u1", unitCode: "A-1", property: null }]);
    const result = await getAmenityUsageRepo(ORG, "amenity-1");
    expect(result.units[0].propertyName).toBe("(unknown)");
  });
});
