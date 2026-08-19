import { it, expect, vi, beforeEach } from "vitest";
import {
  assignCarparksToTenancyService,
  releaseAssignmentsForTenancyTx,
  releaseAssignmentService,
} from "../carpark-assignment.service";
import { getDb, Prisma } from "@kason/db";

// @kason/db is mocked below. getDb() returns mockDb which has vi.fn() mock
// methods for all tables the carpark-assignment service touches. Tests configure
// per-call return values using mockDb.<table>.<method>.mockResolvedValue(…).
//
// The Prisma namespace is exported so tests can construct
// PrismaClientKnownRequestError instances for P2002-mapping assertions.
const mockDb = {
  tenancy: { findFirst: vi.fn() },
  carpark: { findFirst: vi.fn(), update: vi.fn() },
  carparkAssignment: {
    create: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
  },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("@kason/db", () => {
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
    getDb: vi.fn(() => mockDb),
    Prisma: { PrismaClientKnownRequestError },
  };
});

const SESSION = { orgId: "org-1", userId: "u1", role: "manager" };
beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// assignCarparksToTenancyService
// ---------------------------------------------------------------------------

// Invariant 1: assign attaches N bays, flips each to rented, returns assignment ids.
// All per-bay validation (building match, availability) now happens inside the tx
// via assignCarparksTx, so tx.carpark.findFirst drives both checks.
it("assigns bays to a tenancy, flips status to rented, returns assignment ids", async () => {
  const db = getDb() as any;
  db.tenancy.findFirst.mockResolvedValue({
    id: "ten-1",
    propertyId: "prop-A",
    tenantPartyId: "p1",
    status: "active",
  });
  db.$transaction.mockImplementation(async (fn: any) =>
    fn({
      carparkAssignment: {
        create: vi.fn().mockResolvedValue({ id: "assign-1" }),
      },
      carpark: {
        findFirst: vi.fn().mockResolvedValue({
          propertyId: "prop-A",
          status: "available",
          monthlyRate: "120.00",
        }),
        update: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    }),
  );
  const r = await assignCarparksToTenancyService(SESSION, {
    tenancyId: "ten-1",
    carparks: [{ carparkId: "cp-1" }],
  });
  expect(r).toMatchObject({ ok: true, data: { assignmentIds: ["assign-1"] } });
});

// Invariant 2: building mismatch → 422 CARPARK_WRONG_BUILDING.
// Detected inside the tx via tx.carpark.findFirst returning a different propertyId.
it("rejects a bay from a different building", async () => {
  const db = getDb() as any;
  db.tenancy.findFirst.mockResolvedValue({ id: "ten-1", propertyId: "prop-A", tenantPartyId: "p1" });
  db.$transaction.mockImplementation(async (fn: any) =>
    fn({
      carpark: {
        findFirst: vi.fn().mockResolvedValue({
          propertyId: "prop-B",
          status: "available",
          monthlyRate: "120.00",
        }),
      },
    }),
  );
  const r = await assignCarparksToTenancyService(SESSION, { tenancyId: "ten-1", carparks: [{ carparkId: "cp-1" }] });
  expect(r).toMatchObject({ ok: false, status: 422 });
});

// Invariant 3: bay already has an active assignment / not available → 409 CARPARK_ALREADY_RENTED.
// Detected inside the tx via tx.carpark.findFirst returning status:"rented".
it("rejects an already-rented bay", async () => {
  const db = getDb() as any;
  db.tenancy.findFirst.mockResolvedValue({ id: "ten-1", propertyId: "prop-A", tenantPartyId: "p1" });
  db.$transaction.mockImplementation(async (fn: any) =>
    fn({
      carpark: {
        findFirst: vi.fn().mockResolvedValue({
          propertyId: "prop-A",
          status: "rented",
          monthlyRate: "120.00",
        }),
      },
    }),
  );
  const r = await assignCarparksToTenancyService(SESSION, { tenancyId: "ten-1", carparks: [{ carparkId: "cp-1" }] });
  expect(r).toMatchObject({ ok: false, status: 409 });
});

// Invariant 3b: DB partial-unique index fires (P2002) → 409 CARPARK_ALREADY_RENTED
// Simulates a concurrent double-assign that races past the in-tx availability check;
// the unique index is the final guard.
it("maps P2002 unique-constraint violation on create to 409 CARPARK_ALREADY_RENTED", async () => {
  const db = getDb() as any;
  db.tenancy.findFirst.mockResolvedValue({
    id: "ten-1",
    propertyId: "prop-A",
    tenantPartyId: "p1",
    status: "active",
  });
  const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.0.0",
  });
  db.$transaction.mockImplementation(async (fn: any) =>
    fn({
      carparkAssignment: { create: vi.fn().mockRejectedValue(p2002) },
      carpark: {
        findFirst: vi.fn().mockResolvedValue({
          propertyId: "prop-A",
          status: "available",
          monthlyRate: "120.00",
        }),
        update: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    }),
  );
  const r = await assignCarparksToTenancyService(SESSION, {
    tenancyId: "ten-1",
    carparks: [{ carparkId: "cp-1" }],
  });
  expect(r).toMatchObject({ ok: false, status: 409, error: "CARPARK_ALREADY_RENTED" });
});

// Invariant 3c: 2-bay batch where the 2nd bay is already-rented → 409 AND
// the transaction must throw inside $transaction (which causes real Prisma to
// roll back the entire batch — including bay 1 that was processed first).
it("throws inside $transaction on a multi-bay failure so Prisma can roll back fully", async () => {
  const db = getDb() as any;
  db.tenancy.findFirst.mockResolvedValue({ id: "ten-1", propertyId: "prop-A", tenantPartyId: "p1", status: "active" });

  const carparkFindFirstMock = vi
    .fn()
    // bay 1: available → will be processed first
    .mockResolvedValueOnce({ propertyId: "prop-A", status: "available", monthlyRate: "120.00" })
    // bay 2: already rented → triggers 409
    .mockResolvedValueOnce({ propertyId: "prop-A", status: "rented", monthlyRate: "120.00" });

  // Track whether the tx-callback threw (throw is the Prisma rollback trigger).
  let threwInsideTx = false;
  db.$transaction.mockImplementation(async (fn: any) => {
    try {
      return await fn({
        carpark: { findFirst: carparkFindFirstMock, update: vi.fn().mockResolvedValue({}) },
        carparkAssignment: { create: vi.fn().mockResolvedValue({ id: "assign-1" }) },
        auditLog: { create: vi.fn() },
      });
    } catch (e) {
      threwInsideTx = true;
      throw e; // real Prisma rolls back when this propagates
    }
  });

  const r = await assignCarparksToTenancyService(SESSION, {
    tenancyId: "ten-1",
    carparks: [{ carparkId: "cp-1" }, { carparkId: "cp-2" }],
  });

  // Service must return 409 (2nd bay was already rented).
  expect(r).toMatchObject({ ok: false, status: 409 });
  // The throw-to-rollback mechanism must have fired — this is what causes real
  // Prisma to roll back bay-1's committed writes, leaving no orphaned "rented" rows.
  expect(threwInsideTx).toBe(true);
});

// ---------------------------------------------------------------------------
// releaseAssignmentsForTenancyTx
// ---------------------------------------------------------------------------

// Invariant 4: releaseAssignmentsForTenancyTx ends all active assignments and frees bays
it("releaseAssignmentsForTenancyTx: ends all active assignments and returns bays to available", async () => {
  const mockAssignmentUpdate = vi.fn().mockResolvedValue({});
  const mockCarparkUpdate = vi.fn().mockResolvedValue({});
  const mockTx = {
    carparkAssignment: {
      findMany: vi.fn().mockResolvedValue([
        { id: "assign-1", carparkId: "cp-1" },
        { id: "assign-2", carparkId: "cp-2" },
      ]),
      update: mockAssignmentUpdate,
    },
    carpark: { update: mockCarparkUpdate },
  };
  const endDate = new Date("2026-07-31");
  await releaseAssignmentsForTenancyTx(mockTx as any, "org-1", "ten-1", endDate);

  expect(mockAssignmentUpdate).toHaveBeenCalledTimes(2);
  expect(mockCarparkUpdate).toHaveBeenCalledTimes(2);
  expect(mockAssignmentUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "ended", endDate }) }),
  );
  expect(mockCarparkUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ data: { status: "available" } }),
  );
});

// ---------------------------------------------------------------------------
// releaseAssignmentService
// ---------------------------------------------------------------------------

// Invariant 5: releaseAssignmentService returns 404 when assignment id is unknown
it("releaseAssignmentService: returns 404 if assignment not found", async () => {
  const db = getDb() as any;
  db.carparkAssignment.findFirst.mockResolvedValue(null);
  const r = await releaseAssignmentService(SESSION, "nonexistent-id");
  expect(r).toMatchObject({ ok: false, status: 404 });
});

// Invariant 6: releaseAssignmentService ends the assignment and returns the bay to available
it("releaseAssignmentService: ends assignment, returns bay to available, returns id", async () => {
  const db = getDb() as any;
  db.carparkAssignment.findFirst.mockResolvedValue({
    id: "assign-1",
    carparkId: "cp-1",
    tenancyId: "ten-1",
  });
  const mockAssignmentUpdate = vi.fn().mockResolvedValue({});
  const mockCarparkUpdate = vi.fn().mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: any) =>
    fn({
      carparkAssignment: { update: mockAssignmentUpdate },
      carpark: { update: mockCarparkUpdate },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    }),
  );
  const r = await releaseAssignmentService(SESSION, "assign-1");
  expect(r).toMatchObject({ ok: true, data: { id: "assign-1" } });
  expect(mockAssignmentUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "ended" }) }),
  );
  expect(mockCarparkUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ data: { status: "available" } }),
  );
});
