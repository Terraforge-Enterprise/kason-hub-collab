import { Prisma } from "@kason/db";
import {
  type AmenityRow,
  assertAmenitiesBelongToOrgRepo,
  createAmenityRow,
  deleteAmenityRow,
  findAmenityById,
  getAmenityUsageRepo,
  listAmenitiesRepo,
  updateAmenityRow,
} from "./amenities.repository";
import type { CreateAmenityInput, UpdateAmenityInput } from "./amenities.validation";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: 404 | 409 | 422; error: { code: string; message: string } };

export async function listAmenitiesService(orgId: string, opts?: { activeOnly?: boolean }): Promise<AmenityRow[]> {
  return listAmenitiesRepo(orgId, opts);
}

export async function createAmenityService(orgId: string, input: CreateAmenityInput): Promise<Result<AmenityRow>> {
  try {
    const row = await createAmenityRow(orgId, {
      name: input.name,
      sortOrder: input.sortOrder ?? 0,
    });
    return { ok: true, data: row };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return {
        ok: false,
        status: 409,
        error: { code: "amenity_name_conflict", message: "An amenity with this name already exists." },
      };
    }
    throw e;
  }
}

export async function updateAmenityService(
  orgId: string,
  id: string,
  input: UpdateAmenityInput,
): Promise<Result<AmenityRow>> {
  try {
    const row = await updateAmenityRow(orgId, id, input);
    if (!row) {
      return { ok: false, status: 404, error: { code: "amenity_not_found", message: "Amenity not found in this organization." } };
    }
    return { ok: true, data: row };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return {
        ok: false,
        status: 409,
        error: { code: "amenity_name_conflict", message: "An amenity with this name already exists." },
      };
    }
    throw e;
  }
}

export async function deleteAmenityService(orgId: string, id: string): Promise<Result<{ affectedUnitCount: number }>> {
  const existing = await findAmenityById(orgId, id);
  if (!existing) {
    return { ok: false, status: 404, error: { code: "amenity_not_found", message: "Amenity not found in this organization." } };
  }
  const result = await deleteAmenityRow(orgId, id);
  return { ok: true, data: result };
}

export async function getAmenityUsageService(orgId: string, id: string): Promise<Result<{ count: number; units: { id: string; unitCode: string; propertyName: string }[] }>> {
  const existing = await findAmenityById(orgId, id);
  if (!existing) {
    return { ok: false, status: 404, error: { code: "amenity_not_found", message: "Amenity not found in this organization." } };
  }
  const usage = await getAmenityUsageRepo(orgId, id);
  return { ok: true, data: usage };
}

/**
 * Cross-org isolation invariant. Called by unit create/update services
 * BEFORE writing Unit.amenities[]. Throws a typed Result that the caller
 * propagates to the route as 422.
 */
export async function assertAmenitiesBelongToOrgService(
  orgId: string,
  amenityIds: string[],
): Promise<{ ok: true } | { ok: false; status: 422; error: { code: string; message: string } }> {
  const result = await assertAmenitiesBelongToOrgRepo(orgId, amenityIds);
  if (result.ok) return { ok: true };
  return {
    ok: false,
    status: 422,
    error: {
      code: "amenity_org_mismatch",
      message: `One or more amenity IDs do not belong to this organization or do not exist: ${result.missingIds.join(", ")}`,
    },
  };
}
