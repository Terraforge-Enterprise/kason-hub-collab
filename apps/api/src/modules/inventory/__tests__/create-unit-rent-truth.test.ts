/**
 * C1 — the rent the Tenancy PERSISTS and the rent the audit RECORDS must be the
 * same number.
 *
 * `create-unit-tenancy.test.ts` mocks `syncOccupancyTenancy` wholesale, so it can
 * only assert what was HANDED to the mock. That is exactly how a divergence
 * between `Tenancy.monthlyRentAmount` and the `inventory.unit.created_occupied`
 * audit's `meta.monthlyRent` survived review: the audit said 3000, the row said 0.
 *
 * This file runs the REAL `syncOccupancyTenancy` against a transaction mock, so
 * `tx.tenancy.create` carries the number that would actually reach Postgres.
 *
 * `ENABLE_PHASE2_RESERVATION_GATED_TENANCY` is stubbed EXPLICITLY in every test.
 * It is unset locally, so an ambient-env test would pass for the wrong reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stubbed per-test. The real sync branches on this to pick which rent it persists.
const isPhase2FlagEnabled = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../../lib/feature-flags", () => ({ isPhase2FlagEnabled }));

// Collaborators of the REAL syncOccupancyTenancy. Stubbed so no DB is needed;
// syncOccupancyTenancy itself is NOT mocked — it is the unit under test here.
const generateTenancyCodeTx = vi.hoisted(() => vi.fn(async () => "TNC-0001"));
vi.mock("../../tenancy/tenancy-code-generator", () => ({ generateTenancyCodeTx }));

const releaseAssignmentsForTenancyTx = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../carpark/carpark-assignment.service", () => ({ releaseAssignmentsForTenancyTx }));

function makeModelSpies() {
  return {
    listing: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    apartment: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    carpark: { findFirst: vi.fn(), updateMany: vi.fn() },
    partyRole: { findFirst: vi.fn() },
    party: { findFirst: vi.fn() },
    tenancy: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  };
}
type ModelSpies = ReturnType<typeof makeModelSpies>;

const prismaMock = { ...makeModelSpies(), $transaction: vi.fn() };
const txMock = makeModelSpies();

vi.mock("@kason/db", () => ({ getDb: () => prismaMock }));

vi.mock("../inventory.repository", () => ({
  createListingTx: vi.fn(),
  createProperty: vi.fn(),
  findListingById: vi.fn(),
  findListingTypeConflict: vi.fn(),
  findPropertyById: vi.fn(),
  findPropertyCodeConflict: vi.fn(),
  findPropertyDetail: vi.fn(),
  findPropertyStatus: vi.fn(),
  findUnitDetail: vi.fn(),
  listListings: vi.fn(),
  listProperties: vi.fn(),
  recomputeReadyNowForProperty: vi.fn(),
  replaceVisibilityGrants: vi.fn(),
  searchApartments: vi.fn(),
  updateListingTx: vi.fn(),
  updateProperty: vi.fn(),
  updatePropertyPaxDeduction: vi.fn(),
}));

vi.mock("../amenities/amenities.service", () => ({
  assertAmenitiesBelongToOrgService: vi.fn(),
}));

vi.mock("../listing-mode", () => ({
  getUnitGroupMode: vi.fn().mockResolvedValue(null),
  resolveRoomTypeKind: vi.fn().mockResolvedValue(null),
}));

import { createUnitService } from "../inventory.service";
import * as repo from "../inventory.repository";
import { assertAmenitiesBelongToOrgService } from "../amenities/amenities.service";

const mockedRepo = vi.mocked(repo);
const mockedAmenity = vi.mocked(assertAmenitiesBelongToOrgService);

const OWNER = "22222222-2222-4222-8222-222222222222";
const TENANT = "33333333-3333-4333-8333-333333333333";
const PROPERTY = "11111111-1111-4111-8111-111111111111";
const session = { orgId: "00000000-0000-4000-8000-000000000000", userId: "u1", role: "admin" };

/** Occupied create carrying the admin's typed rent and NO rentalRate — the C1 shape. */
const baseOccupied = {
  propertyId: PROPERTY,
  unitCode: "A-18-06",
  unitType: "Master",
  depositMonths: 2,
  utilitiesDepositMonths: 1,
  occupancyStatus: "occupied",
  tenantPartyId: TENANT,
  moveInDate: "2026-07-15",
  moveOutDate: "2027-07-14",
  ownerPartyId: OWNER,
};

function stubDefaults(m: ModelSpies) {
  m.apartment.findFirst.mockResolvedValue(null);
  m.apartment.create.mockResolvedValue({ id: "apt-new" });
  m.apartment.update.mockResolvedValue({ id: "apt-new" });
  m.listing.findFirst.mockResolvedValue(null);
  m.listing.findMany.mockResolvedValue([]);
  m.listing.create.mockResolvedValue({ id: "room-new" });
  m.listing.updateMany.mockResolvedValue({ count: 1 });
  m.carpark.findFirst.mockResolvedValue(null);
  m.carpark.updateMany.mockResolvedValue({ count: 0 });
  m.partyRole.findFirst.mockResolvedValue({ id: "role-1" });
  // Flag-off tenant validation reads Party.partyType; flag-on reads PartyRole.
  m.party.findFirst.mockResolvedValue({ id: TENANT });
  m.tenancy.findFirst.mockResolvedValue(null);
  m.tenancy.create.mockResolvedValue({ id: "tenancy-new" });
  m.auditLog.create.mockResolvedValue(undefined);
}

function txAudit(action: string): Record<string, unknown> | undefined {
  return txMock.auditLog.create.mock.calls
    .map((c) => (c[0] as { data: Record<string, unknown> }).data)
    .find((a) => a.action === action);
}

/** The `monthlyRentAmount` the Tenancy row would actually carry into Postgres. */
function persistedRent(): unknown {
  const call = txMock.tenancy.create.mock.calls[0];
  if (!call) return undefined;
  return (call[0] as { data: Record<string, unknown> }).data.monthlyRentAmount;
}

/** The `monthlyRent` the `inventory.unit.created_occupied` audit row asserts. */
function auditedRent(): unknown {
  const audit = txAudit("inventory.unit.created_occupied");
  if (!audit) return undefined;
  return (audit.meta as Record<string, unknown>).monthlyRent;
}

beforeEach(() => {
  vi.clearAllMocks();
  isPhase2FlagEnabled.mockReturnValue(false);
  generateTenancyCodeTx.mockResolvedValue("TNC-0001");
  prismaMock.$transaction.mockImplementation((cb: (tx: typeof txMock) => Promise<unknown>) =>
    cb(txMock),
  );
  stubDefaults(prismaMock);
  stubDefaults(txMock);
  mockedRepo.findPropertyStatus.mockResolvedValue("active" as never);
  mockedRepo.findListingTypeConflict.mockResolvedValue(null as never);
  mockedRepo.createListingTx.mockResolvedValue({ id: "u-new" } as never);
  mockedRepo.replaceVisibilityGrants.mockResolvedValue(undefined as never);
  mockedAmenity.mockResolvedValue({ ok: true } as never);
});

describe("createUnitService — the persisted rent and the audited rent are one number", () => {
  // B1. The C1 defect: monthlyRent typed, rentalRate absent, flag off.
  it("persists the admin's typed monthlyRent when no rentalRate is supplied (flag off)", async () => {
    const res = await createUnitService(session as never, {
      ...baseOccupied,
      monthlyRent: 3000,
    } as never);

    expect(res.ok).toBe(true);
    expect(txMock.tenancy.create).toHaveBeenCalledTimes(1);
    // Compared as one object so a failure prints BOTH numbers: the false audit is
    // only visible as a divergence, never from either value alone.
    expect({ persisted: persistedRent(), audited: auditedRent() }).toEqual({
      persisted: 3000,
      audited: 3000,
    });
  });

  // B3. `rentalRate` and `monthlyRent` are INDEPENDENTLY optional on
  // createUnitObjectSchema (packages/shared/src/schemas/inventory.ts), so an admin
  // can send both with different values: an advertised rate of 2000 and a
  // negotiated rent of 3000. The explicit tenancy rent must win -- that is what
  // the flag-ON branch of syncOccupancyTenancy already does -- and the audit must
  // record whichever number the Tenancy actually got.
  it("prefers the explicit monthlyRent over rentalRate, and audits what it persisted", async () => {
    const res = await createUnitService(session as never, {
      ...baseOccupied,
      rentalRate: 2000,
      monthlyRent: 3000,
    } as never);

    expect(res.ok).toBe(true);
    expect({ persisted: persistedRent(), audited: auditedRent() }).toEqual({
      persisted: 3000,
      audited: 3000,
    });
  });

  // B2. No explicit rent, but the listing carries an advertised rate: today's
  // flag-off behaviour (inherit it) is preserved, and the audit follows.
  it("falls back to rentalRate when no monthlyRent is supplied (flag off)", async () => {
    const res = await createUnitService(session as never, {
      ...baseOccupied,
      rentalRate: 2500,
    } as never);

    expect(res.ok).toBe(true);
    expect({ persisted: persistedRent(), audited: auditedRent() }).toEqual({
      persisted: 2500,
      audited: 2500,
    });
  });

  // B6. Flag ON: the sync ignores `unit.rentalRate` entirely and uses
  // `incoming.monthlyRent`. Both branches must land on the same number.
  it("persists and audits the same rent under the reservation-gated flag", async () => {
    isPhase2FlagEnabled.mockReturnValue(true);
    // Flag-on validates the tenant by PartyRole, not Party.partyType.
    txMock.partyRole.findFirst.mockResolvedValue({ id: "tenant-role-1" });

    const res = await createUnitService(session as never, {
      ...baseOccupied,
      rentalRate: 2000,
      monthlyRent: 3000,
    } as never);

    expect(res.ok).toBe(true);
    expect({ persisted: persistedRent(), audited: auditedRent() }).toEqual({
      persisted: 3000,
      audited: 3000,
    });
  });
});

describe("createUnitService — an occupied create with no usable rent writes nothing", () => {
  // B4. The silent zero is refused outright rather than persisted.
  it("rejects an occupied create carrying neither monthlyRent nor rentalRate (400)", async () => {
    const res = await createUnitService(session as never, { ...baseOccupied } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    // Nested `error: { code, message }` — the shape the existing rent-required
    // catch already returns, NOT the top-level `code` the 409s use.
    expect(res.error).toEqual({
      code: "OCCUPANCY_RENT_REQUIRED",
      message: "Enter the monthly rent before marking this unit occupied.",
    });
    // Rejected before the transaction opened: no listing, no tenancy, no audit.
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
    expect(txMock.tenancy.create).not.toHaveBeenCalled();
    expect(txMock.auditLog.create).not.toHaveBeenCalled();
  });

  // B5. Zero is a value the admin can type. It must reject, not persist.
  it("rejects an explicit monthlyRent of 0 (400)", async () => {
    const res = await createUnitService(session as never, {
      ...baseOccupied,
      monthlyRent: 0,
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(txMock.tenancy.create).not.toHaveBeenCalled();
  });

  // B5b. The `??` vs `||` discriminator. `0 ?? 2500` is 0 (reject); `0 || 2500`
  // is 2500 (silently persist a rent the admin did not type). Only this test
  // fails if someone "simplifies" the coalesce.
  it("rejects monthlyRent 0 even when a positive rentalRate could rescue it", async () => {
    const res = await createUnitService(session as never, {
      ...baseOccupied,
      monthlyRent: 0,
      rentalRate: 2500,
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(txMock.tenancy.create).not.toHaveBeenCalled();
  });

  // B7. Flag ON with only an advertised rate: the sync's own guard throws
  // (`no silent default to the unit's rentalRate`) and is mapped to the same 400.
  it("rejects a rentalRate-only occupied create under the reservation-gated flag", async () => {
    isPhase2FlagEnabled.mockReturnValue(true);
    txMock.partyRole.findFirst.mockResolvedValue({ id: "tenant-role-1" });

    const res = await createUnitService(session as never, {
      ...baseOccupied,
      rentalRate: 2500,
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toEqual({
      code: "OCCUPANCY_RENT_REQUIRED",
      message: "Enter the monthly rent before marking this unit occupied.",
    });
    // The transaction opened, then rolled back: nothing is persisted.
    expect(txMock.tenancy.create).not.toHaveBeenCalled();
  });

  // B22 (adversarial audit, finding 3). A payload that violates BOTH the no-owner
  // and the no-rent guard must return a deterministic code. The rent guard sits
  // after the owner guard, so the 409 admins see today is unchanged.
  it("returns UNIT_HAS_NO_OWNER, not the rent 400, when a payload violates both", async () => {
    const { ownerPartyId: _drop, ...noOwnerNoRent } = baseOccupied;
    const res = await createUnitService(session as never, noOwnerNoRent as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("UNIT_HAS_NO_OWNER");
  });

  // B8. The vacant path never had a rent requirement and must not acquire one.
  it("leaves a vacant create with no rent untouched", async () => {
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-18-07",
      unitType: "Master",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
    } as never);

    expect(res.ok).toBe(true);
    expect(txMock.tenancy.create).not.toHaveBeenCalled();
    expect(txAudit("inventory.unit.created_occupied")).toBeUndefined();
  });
});
