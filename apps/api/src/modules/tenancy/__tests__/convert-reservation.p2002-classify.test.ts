/**
 * P2002 discrimination for convertReservationToTenancy (T7): a unique
 * violation on `tx.tenancy.create` must map to a clean 409, and — critically
 * — must NOT conflate two distinct constraints:
 *   - the one-active-per-unit partial index (organizationId, unitId)  -> CONCURRENT_ACTIVE_TENANCY
 *   - the tenancyCode unique (organizationId, tenancyCode)            -> TENANCY_CODE_TAKEN
 *
 * These cases stub `tx.tenancy.create` to throw a synthetic
 * Prisma.PrismaClientKnownRequestError (P2002) via a full @kason/db mock,
 * because there's no way to make a genuine one-active-per-unit race happen
 * inside a single-process integration test (see
 * convert-reservation.integration.test.ts for the REAL, non-stubbed
 * tenancyCode-collision case, which exercises the actual Postgres driver
 * error shape instead).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { convertReservationToTenancy } from "../convert-reservation.service";
import { Prisma } from "@kason/db";

// vi.mock(...) below is hoisted above this file's top-level statements, so
// mockDb must be created via vi.hoisted (a plain top-level const would still
// be in the TDZ when the mock factory executes).
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    unitReservation: { findFirst: vi.fn() },
    tenancy: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    partyRole: { findFirst: vi.fn() },
    listing: { findFirst: vi.fn() },
    carparkAssignment: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@kason/db", () => {
  // Defined INSIDE the factory (not referencing outer scope) so it's safe
  // under vi.mock's hoisting -- see carpark-assignment.service.test.ts for
  // the same pattern.
  class PrismaClientKnownRequestError extends Error {
    code: string;
    clientVersion: string;
    meta?: Record<string, unknown>;
    constructor(
      message: string,
      opts: { code: string; clientVersion: string; meta?: Record<string, unknown> },
    ) {
      super(message);
      this.name = "PrismaClientKnownRequestError";
      this.code = opts.code;
      this.clientVersion = opts.clientVersion;
      this.meta = opts.meta;
    }
  }
  return {
    getDb: () => mockDb,
    Prisma: { PrismaClientKnownRequestError },
  };
});

vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));

const SESSION = { orgId: "org-1", userId: "user-1", role: "admin" };
const RESERVATION_ROW = {
  id: "res-1",
  status: "signed",
  unitId: "unit-1",
  propertyId: "prop-1",
  proposedMoveIn: new Date("2026-01-01T00:00:00Z"),
  proposedMoveOut: new Date("2026-12-31T00:00:00Z"),
  agreedMonthlyRent: "2000.00",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockImplementation((fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  mockDb.unitReservation.findFirst.mockResolvedValue(RESERVATION_ROW);
  // Called twice by the service: (1) RESERVATION_ALREADY_CONVERTED check by
  // reservationId, (2) assertNoActiveTenancyTx's active-tenancy lookup.
  // Both must resolve null/falsy to reach tx.tenancy.create.
  mockDb.tenancy.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  mockDb.tenancy.findMany.mockResolvedValue([]); // generateTenancyCodeTx
  mockDb.partyRole.findFirst.mockResolvedValue({ id: "role-1" });
  mockDb.listing.findFirst.mockResolvedValue({ ownerPartyId: "owner-1" });
});

describe("convertReservationToTenancy P2002 discrimination (stubbed)", () => {
  it("concurrent 409: array-target P2002 on create maps to CONCURRENT_ACTIVE_TENANCY, not a 500", async () => {
    mockDb.tenancy.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`organizationId`,`unitId`)", {
        code: "P2002",
        clientVersion: "x",
        meta: { target: ["organizationId", "unitId"] },
      }),
    );

    const result = await convertReservationToTenancy(SESSION, {
      reservationId: "res-1",
      tenantPartyId: "tenant-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("CONCURRENT_ACTIVE_TENANCY");
  });

  it("string-constraint-name variant: tenancyCode collision string target maps to TENANCY_CODE_TAKEN, distinct from concurrent-active", async () => {
    mockDb.tenancy.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the constraint: "Tenancy_organizationId_tenancyCode_key"', {
        code: "P2002",
        clientVersion: "x",
        meta: { target: "Tenancy_organizationId_tenancyCode_key" },
      }),
    );

    const result = await convertReservationToTenancy(SESSION, {
      reservationId: "res-1",
      tenantPartyId: "tenant-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("TENANCY_CODE_TAKEN");
  });

  // Coverage-lock, not a fresh TDD cycle: once the classifier normalizes
  // both array and string target shapes (added above to make the tenancyCode
  // string-variant pass), a string constraint name for the OTHER index falls
  // out of the same generalized code with no further change -- this pins
  // that down explicitly instead of leaving it implicit.
  it("string-constraint-name variant: one-active-per-unit index string target maps to CONCURRENT_ACTIVE_TENANCY", async () => {
    mockDb.tenancy.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the constraint: "tenancy_one_active_per_unit"', {
        code: "P2002",
        clientVersion: "x",
        meta: { target: "tenancy_one_active_per_unit" },
      }),
    );

    const result = await convertReservationToTenancy(SESSION, {
      reservationId: "res-1",
      tenantPartyId: "tenant-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("CONCURRENT_ACTIVE_TENANCY");
  });

  // T7 review Finding 2: a P2002 on the `reservationId` unique constraint (a
  // concurrent double-convert of the SAME reservation racing past the
  // pre-check) must NOT fall into the CONCURRENT_ACTIVE_TENANCY default --
  // retrying that error can never succeed, since the reservation is already
  // converted. Stubbed with the REAL driver-adapter shape (Prisma 7 +
  // @prisma/adapter-pg leaves meta.target undefined; see the classifier's own
  // comment) so this pins the classifier's actual empirical read path, not
  // just meta.target.
  it("driver-adapter shape: reservationId unique constraint collision on create maps to RESERVATION_ALREADY_CONVERTED, not CONCURRENT_ACTIVE_TENANCY (T7 review F2)", async () => {
    mockDb.tenancy.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "x",
        meta: {
          modelName: "Tenancy",
          driverAdapterError: {
            cause: {
              originalMessage:
                'duplicate key value violates unique constraint "Tenancy_reservationId_key"',
              constraint: { fields: ['"organizationId"', '"reservationId"'] },
            },
          },
        },
      }),
    );

    const result = await convertReservationToTenancy(SESSION, {
      reservationId: "res-1",
      tenantPartyId: "tenant-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("RESERVATION_ALREADY_CONVERTED");
  });
});
