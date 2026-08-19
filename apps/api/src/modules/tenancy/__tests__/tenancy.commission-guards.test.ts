import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createTenancyService, updateTenancyService } from "../tenancy.service";
import { tenancyRoutes } from "../tenancy.routes";
import * as repo from "../tenancy.repository";
import type { TenancySession } from "../tenancy.types";

// Mirrors the mocking pattern in tenancy.service.test.ts exactly: mock the
// repository module and @kason/db so getDb() can be controlled per-test.
vi.mock("../tenancy.repository", () => ({
  listLandlordTenancies: vi.fn(),
  findProperty: vi.fn(),
  findOwnerRole: vi.fn(),
  createLandlordTenancy: vi.fn(),
  findLandlordTenancy: vi.fn(),
  updateLandlordTenancy: vi.fn(),
  listTenancies: vi.fn(),
  findUnit: vi.fn(),
  findTenantRole: vi.fn(),
  findTenancyByCode: vi.fn(),
  findTenancy: vi.fn(),
  updateTenancy: vi.fn(),
  renewTenancyTx: vi.fn(),
  findReservationRent: vi.fn(),
}));

// Extends the sibling suite's mockTenancyDb with the models the commission lock
// predicate (assertCommissionWritable) reads via getDb(): the tenancy's
// rent/letting_commission charges, their cash-filtered PaymentAllocations, and
// the reversals netted off those allocations. tenancy.findFirst defaults to
// undefined (falsy / "no active tenancy") so the create-path active-tenancy
// guard is unaffected.
const mockTenancyDb = {
  tenancy: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  charge: { findMany: vi.fn() },
  paymentAllocation: { findMany: vi.fn() },
  paymentAllocationReversal: { groupBy: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => mockTenancyDb),
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

vi.mock("../../carpark/carpark-assignment.service", () => ({
  assignCarparksTx: vi.fn(),
  releaseAssignmentsForTenancyTx: vi.fn(),
}));

const mockedRepo = vi.mocked(repo);

const managerSession = { userId: "u1", orgId: "o1", role: "manager" };
const editorSession = { userId: "u2", orgId: "o1", role: "editor" };

// Route-level tests need a session injected via c.set() -- tenancyRoutes.request()
// alone has no middleware to populate c.get("session"). Mirrors the makeApp()
// pattern in billing-documents/__tests__/routes.test.ts.
function makeApp(session: TenancySession) {
  const app = new Hono<{ Variables: { session: TenancySession } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", tenancyRoutes);
  return app;
}

// A property/unit/tenant fixture set common to the create-path tests, mirroring
// the sibling suite's setup for createTenancyService.
function seedCreatePrereqs() {
  mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
  mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
  mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
  mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
}

describe("commission field guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the tenancy has billable charges but nothing has been paid, so
    // the fields stay editable.
    mockTenancyDb.charge.findMany.mockResolvedValue([{ id: "c1" }]);
    mockTenancyDb.paymentAllocation.findMany.mockResolvedValue([]);
    mockTenancyDb.paymentAllocationReversal.groupBy.mockResolvedValue([]);
  });

  /** Simulate cash received: one settled allocation of `amount` on the charge. */
  function seedReceivedPayment(amount = "500.00") {
    mockTenancyDb.paymentAllocation.findMany.mockResolvedValueOnce([
      { id: "a1", allocatedAmount: amount },
    ]);
  }

  it("manager persists both commission columns on create", async () => {
    seedCreatePrereqs();
    const mockTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "ten-1" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn() },
    };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));

    const res = await createTenancyService(managerSession, {
      propertyId: "p1",
      unitId: "u1",
      tenantPartyId: "t1",
      tenancyCode: "T-1",
      startDate: "2026-01-01",
      monthlyRentAmount: "2000",
      firstMonthIsCommission: true,
      commissionSstBearer: "kaen",
    } as never);

    expect(res.ok).toBe(true);
    expect(mockTx.tenancy.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ firstMonthIsCommission: true, commissionSstBearer: "kaen" }) }),
    );
  });

  it("editor CREATING with a commission column set -> 403 COMMISSION_FIELDS_FORBIDDEN, nothing written", async () => {
    seedCreatePrereqs();

    const res = await createTenancyService(editorSession, {
      propertyId: "p1",
      unitId: "u1",
      tenantPartyId: "t1",
      tenancyCode: "T-2",
      startDate: "2026-01-01",
      monthlyRentAmount: "2000",
      firstMonthIsCommission: true,
    } as never);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect((res as { code?: string }).code).toBe("COMMISSION_FIELDS_FORBIDDEN");
    }
    // Rejected before any write: no create transaction opens.
    expect(mockTenancyDb.$transaction).not.toHaveBeenCalled();
  });

  it("editor changing a commission column on update -> 403 COMMISSION_FIELDS_FORBIDDEN, nothing written", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({
      id: "ten-3", propertyId: "p1", unitId: "u1", tenantPartyId: "t1", status: "active",
      startDate: new Date(Date.UTC(2026, 0, 1)),
      firstMonthIsCommission: false, commissionSstBearer: "owner",
    } as never);

    const res = await updateTenancyService(editorSession, {
      tenancyId: "ten-3",
      firstMonthIsCommission: true,
    } as never);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect((res as { code?: string }).code).toBe("COMMISSION_FIELDS_FORBIDDEN");
    }
    expect(mockedRepo.updateTenancy).not.toHaveBeenCalled();
    expect(mockTenancyDb.$transaction).not.toHaveBeenCalled();
  });

  it("editor leaving columns unchanged -> write succeeds", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({
      id: "ten-4", propertyId: "p1", unitId: "u1", tenantPartyId: "t1", status: "active",
      startDate: new Date(Date.UTC(2026, 0, 1)),
      firstMonthIsCommission: false, commissionSstBearer: "owner",
    } as never);

    const res = await updateTenancyService(editorSession, {
      tenancyId: "ten-4",
      monthlyRentAmount: "2500",
      firstMonthIsCommission: false,
      commissionSstBearer: "owner",
    } as never);

    expect(res.ok).toBe(true);
    expect(mockedRepo.updateTenancy).toHaveBeenCalledTimes(1);
  });

  it("manager changing a commission column on a non-invoiced tenancy -> write persists", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({
      id: "ten-4b", propertyId: "p1", unitId: "u1", tenantPartyId: "t1", status: "active",
      startDate: new Date(Date.UTC(2026, 0, 1)),
      firstMonthIsCommission: false, commissionSstBearer: "owner",
    } as never);

    const res = await updateTenancyService(managerSession, {
      tenancyId: "ten-4b",
      firstMonthIsCommission: true,
    } as never);

    expect(res.ok).toBe(true);
    expect(mockedRepo.updateTenancy).toHaveBeenCalledWith(
      "ten-4b",
      expect.objectContaining({ firstMonthIsCommission: true }),
    );
  });

  it("manager changing a column on a PAID tenancy -> 409 COMMISSION_FIELDS_LOCKED", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({
      id: "ten-5", propertyId: "p1", unitId: "u1", tenantPartyId: "t1", status: "active",
      startDate: new Date(Date.UTC(2026, 0, 1)),
      firstMonthIsCommission: false, commissionSstBearer: "owner",
    } as never);
    seedReceivedPayment();

    const res = await updateTenancyService(managerSession, {
      tenancyId: "ten-5",
      firstMonthIsCommission: true,
    } as never);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect((res as { code?: string }).code).toBe("COMMISSION_FIELDS_LOCKED");
    }
    expect(mockedRepo.updateTenancy).not.toHaveBeenCalled();
    expect(mockTenancyDb.$transaction).not.toHaveBeenCalled();
  });

  // Was: "lock stays after the invoice is voided (monotonic)". That behaviour is
  // exactly the trap this change removes -- Invoice.status defaults to "draft"
  // and there is no DELETE route, so a draft or voided invoice froze the columns
  // with no way back. The lock now tracks received cash and is deliberately
  // NON-monotonic; reversing the payment re-opens the fields, as it does for a
  // re-Bill (assessPaidBlockers).
  it("a reversed payment re-opens the columns -- the lock is not monotonic", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({
      id: "ten-6", propertyId: "p1", unitId: "u1", tenantPartyId: "t1", status: "active",
      startDate: new Date(Date.UTC(2026, 0, 1)),
      firstMonthIsCommission: false, commissionSstBearer: "owner",
    } as never);
    seedReceivedPayment("500.00");
    // ...fully reversed, so net cash is zero.
    mockTenancyDb.paymentAllocationReversal.groupBy.mockResolvedValueOnce([
      { originalAllocationId: "a1", _sum: { amount: "500.00" } },
    ]);

    const res = await updateTenancyService(managerSession, {
      tenancyId: "ten-6",
      commissionSstBearer: "kaen",
    } as never);

    expect(res.ok).toBe(true);
    expect(mockedRepo.updateTenancy).toHaveBeenCalledWith(
      "ten-6",
      expect.objectContaining({ commissionSstBearer: "kaen" }),
    );
  });

  it("an unpaid tenancy is editable however much paperwork exists -- the reported bug", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({
      id: "ten-6b", propertyId: "p1", unitId: "u1", tenantPartyId: "t1", status: "active",
      startDate: new Date(Date.UTC(2026, 0, 1)),
      firstMonthIsCommission: false, commissionSstBearer: "owner",
    } as never);
    // Charges exist (draft documents were raised) but no cash ever arrived.
    mockTenancyDb.charge.findMany.mockResolvedValueOnce([{ id: "c1" }, { id: "c2" }]);
    mockTenancyDb.paymentAllocation.findMany.mockResolvedValueOnce([]);

    const res = await updateTenancyService(managerSession, {
      tenancyId: "ten-6b",
      commissionSstBearer: "kaen",
    } as never);

    expect(res.ok).toBe(true);
  });

  it("PUT route propagates code:COMMISSION_FIELDS_LOCKED with status 409", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111", propertyId: "p1", unitId: "u1", tenantPartyId: "t1", status: "active",
      startDate: new Date(Date.UTC(2026, 0, 1)),
      firstMonthIsCommission: false, commissionSstBearer: "owner",
    } as never);
    seedReceivedPayment();

    const res = await makeApp(managerSession).request(
      "/tenancies/11111111-1111-4111-8111-111111111111",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstMonthIsCommission: true }),
      },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("COMMISSION_FIELDS_LOCKED");
  });
});
