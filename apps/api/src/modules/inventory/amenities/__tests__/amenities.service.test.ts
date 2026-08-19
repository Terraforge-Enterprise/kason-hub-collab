import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@kason/db";

const repoMocks = vi.hoisted(() => ({
  listAmenitiesRepo: vi.fn(),
  findAmenityById: vi.fn(),
  createAmenityRow: vi.fn(),
  updateAmenityRow: vi.fn(),
  deleteAmenityRow: vi.fn(),
  getAmenityUsageRepo: vi.fn(),
  assertAmenitiesBelongToOrgRepo: vi.fn(),
}));

vi.mock("../amenities.repository", () => repoMocks);

import {
  createAmenityService,
  updateAmenityService,
  deleteAmenityService,
  getAmenityUsageService,
  assertAmenitiesBelongToOrgService,
} from "../amenities.service";

const ORG = "org-1";
const AMENITY = { id: "a1", organizationId: ORG, name: "Gym", sortOrder: 0, isActive: true, createdAt: new Date(), updatedAt: new Date() };

beforeEach(() => {
  Object.values(repoMocks).forEach((m) => m.mockReset());
});

describe("createAmenityService", () => {
  it("returns ok:true with the row on success", async () => {
    repoMocks.createAmenityRow.mockResolvedValue(AMENITY);
    const result = await createAmenityService(ORG, { name: "Gym" });
    expect(result).toEqual({ ok: true, data: AMENITY });
  });

  it("defaults sortOrder to 0 when omitted", async () => {
    repoMocks.createAmenityRow.mockResolvedValue(AMENITY);
    await createAmenityService(ORG, { name: "Gym" });
    expect(repoMocks.createAmenityRow).toHaveBeenCalledWith(ORG, { name: "Gym", sortOrder: 0 });
  });

  it("translates Prisma P2002 into 409 amenity_name_conflict (not generic 500)", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique violation", {
      code: "P2002",
      clientVersion: "test",
    });
    repoMocks.createAmenityRow.mockRejectedValue(p2002);
    const result = await createAmenityService(ORG, { name: "Gym" });
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: { code: "amenity_name_conflict", message: expect.stringContaining("already exists") },
    });
  });

  it("rethrows non-P2002 Prisma errors (bug surface)", async () => {
    const other = new Prisma.PrismaClientKnownRequestError("Some other", { code: "P2003", clientVersion: "test" });
    repoMocks.createAmenityRow.mockRejectedValue(other);
    await expect(createAmenityService(ORG, { name: "Gym" })).rejects.toThrow();
  });
});

describe("updateAmenityService", () => {
  it("returns 404 when amenity not found", async () => {
    repoMocks.updateAmenityRow.mockResolvedValue(null);
    const result = await updateAmenityService(ORG, "missing", { name: "X" });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("translates P2002 on rename to 409", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
    repoMocks.updateAmenityRow.mockRejectedValue(p2002);
    const result = await updateAmenityService(ORG, "a1", { name: "Gym" });
    expect(result).toMatchObject({ ok: false, status: 409 });
  });
});

describe("deleteAmenityService", () => {
  it("returns 404 when amenity not found", async () => {
    repoMocks.findAmenityById.mockResolvedValue(null);
    const result = await deleteAmenityService(ORG, "missing");
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(repoMocks.deleteAmenityRow).not.toHaveBeenCalled();
  });

  it("returns affectedUnitCount on success", async () => {
    repoMocks.findAmenityById.mockResolvedValue(AMENITY);
    repoMocks.deleteAmenityRow.mockResolvedValue({ affectedUnitCount: 47 });
    const result = await deleteAmenityService(ORG, "a1");
    expect(result).toEqual({ ok: true, data: { affectedUnitCount: 47 } });
  });
});

describe("getAmenityUsageService", () => {
  it("returns 404 when amenity not found", async () => {
    repoMocks.findAmenityById.mockResolvedValue(null);
    const result = await getAmenityUsageService(ORG, "missing");
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("returns count + units on success", async () => {
    repoMocks.findAmenityById.mockResolvedValue(AMENITY);
    repoMocks.getAmenityUsageRepo.mockResolvedValue({ count: 5, units: [{ id: "u1", unitCode: "A-1", propertyName: "Building A" }] });
    const result = await getAmenityUsageService(ORG, "a1");
    expect(result).toEqual({ ok: true, data: { count: 5, units: [{ id: "u1", unitCode: "A-1", propertyName: "Building A" }] } });
  });
});

describe("assertAmenitiesBelongToOrgService", () => {
  it("returns ok:true when repo says all IDs belong", async () => {
    repoMocks.assertAmenitiesBelongToOrgRepo.mockResolvedValue({ ok: true });
    const result = await assertAmenitiesBelongToOrgService(ORG, ["a1"]);
    expect(result).toEqual({ ok: true });
  });

  it("returns 422 with missing IDs in error message when some IDs are not in org", async () => {
    repoMocks.assertAmenitiesBelongToOrgRepo.mockResolvedValue({ ok: false, missingIds: ["a-other-org"] });
    const result = await assertAmenitiesBelongToOrgService(ORG, ["a-other-org"]);
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      error: { code: "amenity_org_mismatch", message: expect.stringContaining("a-other-org") },
    });
  });
});
