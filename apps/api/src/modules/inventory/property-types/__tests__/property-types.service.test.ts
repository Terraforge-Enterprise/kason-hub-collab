import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../property-types.repository", () => ({
  findPropertyTypeById: vi.fn(),
  getPropertyTypeUsageRepo: vi.fn(),
  deletePropertyTypeRow: vi.fn(),
  createPropertyTypeRow: vi.fn(),
  updatePropertyTypeRow: vi.fn(),
  listPropertyTypesRepo: vi.fn(),
}));
vi.mock("../../../../lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@kason/db", async (importActual) => {
  const actual = await importActual<typeof import("@kason/db")>();
  return {
    ...actual, // keep the real Prisma export (P2002 error class used by create/update)
    getDb: vi.fn(() => ({ $transaction: async (fn: (tx: unknown) => unknown) => fn({}) })),
  };
});

import { createPropertyTypeRow, findPropertyTypeById, getPropertyTypeUsageRepo } from "../property-types.repository";
import {
  createPropertyTypeService,
  deletePropertyTypeService,
  getPropertyTypeUsageService,
} from "../property-types.service";

const ctx = { orgId: "o1", actorUserId: "u1", actorRole: "manager" as const };
const row = (name: string) => ({
  id: "t1", organizationId: "o1", name, sortOrder: 0, isActive: true, createdAt: new Date(), updatedAt: new Date(),
});

beforeEach(() => vi.clearAllMocks());

describe("createPropertyTypeService", () => {
  it("returns 409 property_type_name_conflict when createPropertyTypeRow rejects with P2002", async () => {
    const { Prisma } = await import("@kason/db");
    vi.mocked(createPropertyTypeRow).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "x" }),
    );
    const res = await createPropertyTypeService(ctx, { name: "Condominium" });
    expect(res).toEqual({
      ok: false,
      status: 409,
      error: expect.objectContaining({ code: "property_type_name_conflict" }),
    });
  });
});

describe("deletePropertyTypeService", () => {
  it("returns 409 property_type_in_use when a Property uses the name", async () => {
    vi.mocked(findPropertyTypeById).mockResolvedValue(row("Condominium"));
    vi.mocked(getPropertyTypeUsageRepo).mockResolvedValue({ propertyCount: 3 });
    const res = await deletePropertyTypeService(ctx, "t1");
    expect(res).toEqual({ ok: false, status: 409, error: expect.objectContaining({ code: "property_type_in_use" }) });
  });
  it("returns 404 when the id is missing/cross-org", async () => {
    vi.mocked(findPropertyTypeById).mockResolvedValue(null);
    const res = await deletePropertyTypeService(ctx, "nope");
    expect(res).toEqual({ ok: false, status: 404, error: expect.objectContaining({ code: "property_type_not_found" }) });
  });
  it("returns { deleted: true } when not in use", async () => {
    vi.mocked(findPropertyTypeById).mockResolvedValue(row("Landed"));
    vi.mocked(getPropertyTypeUsageRepo).mockResolvedValue({ propertyCount: 0 });
    const res = await deletePropertyTypeService(ctx, "t1");
    expect(res).toEqual({ ok: true, data: { deleted: true } });
  });
});

describe("getPropertyTypeUsageService", () => {
  it("returns propertyCount for an existing type", async () => {
    vi.mocked(findPropertyTypeById).mockResolvedValue(row("Landed"));
    vi.mocked(getPropertyTypeUsageRepo).mockResolvedValue({ propertyCount: 5 });
    const res = await getPropertyTypeUsageService("o1", "t1");
    expect(res).toEqual({ ok: true, data: { propertyCount: 5 } });
  });
  it("returns 404 for a missing type", async () => {
    vi.mocked(findPropertyTypeById).mockResolvedValue(null);
    const res = await getPropertyTypeUsageService("o1", "nope");
    expect(res).toEqual({ ok: false, status: 404, error: expect.objectContaining({ code: "property_type_not_found" }) });
  });
});
