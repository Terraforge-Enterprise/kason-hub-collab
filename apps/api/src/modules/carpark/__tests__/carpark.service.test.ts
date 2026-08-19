import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCarparkService, deactivateCarparkService, updateCarparkService } from "../carpark.service";

// @kason/db is mocked below. getDb() returns mockDb which has vi.fn() mock
// methods for all tables the carpark service touches. Tests configure per-call
// return values using mockDb.<table>.<method>.mockResolvedValue(…).
import { getDb } from "@kason/db";

const mockDb = {
  apartment: { findFirst: vi.fn() },
  carpark: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  carparkAssignment: { count: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => mockDb),
}));

const SESSION = { orgId: "org-1", userId: "user-1", role: "manager" };

describe("registerCarparkService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("derives owner + property from the home apartment", async () => {
    const db = getDb() as any;
    db.apartment.findFirst.mockResolvedValue({
      id: "apt-1", propertyId: "prop-1",
      listings: [{ ownerPartyId: "owner-9" }],
    });
    db.$transaction.mockImplementation(async (fn: any) => fn({
      carpark: { create: vi.fn().mockResolvedValue({ id: "cp-1" }) },
      // recordAudit writes via tx; provide the table it touches
      auditLog: { create: vi.fn() },
    }));

    const r = await registerCarparkService(SESSION, { apartmentId: "apt-1", label: "P-12", monthlyRate: "120.00" });
    expect(r.ok).toBe(true);
  });

  it("rejects an apartment not in the org", async () => {
    const db = getDb() as any;
    db.apartment.findFirst.mockResolvedValue(null);
    const r = await registerCarparkService(SESSION, { apartmentId: "nope", label: "P-1", monthlyRate: "100.00" });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  // -------------------------------------------------------------------------
  // F1 — a bay must never be BORN carrying an archived listing's stale owner.
  //
  // These tests replace the dumb `mockResolvedValue` with a mock that HONOURS the
  // nested `listings` where/orderBy/take. A resolver that forgets the
  // `listingStatus` filter therefore sees the archived row and fails the test.
  // -------------------------------------------------------------------------

  type Row = { id: string; ownerPartyId: string | null; listingStatus: string };

  /** Faithful mini-DB for `apartment.findFirst`'s nested `listings` read. */
  function stubApartmentListings(rows: Row[]) {
    const db = getDb() as any;
    db.apartment.findFirst.mockImplementation((args: any) => {
      const nested = args?.select?.listings ?? {};
      const where = nested.where ?? {};
      let out = rows;
      // `ownerPartyId: { not: null }`
      if (where.ownerPartyId?.not === null) out = out.filter((r) => r.ownerPartyId !== null);
      // `listingStatus: { not: "archived" }` — absent in the buggy version.
      if (where.listingStatus?.not) out = out.filter((r) => r.listingStatus !== where.listingStatus.not);
      if (nested.orderBy?.id === "asc") out = [...out].sort((a, b) => a.id.localeCompare(b.id));
      const take = nested.take ?? out.length;
      return Promise.resolve({
        id: "apt-1",
        propertyId: "prop-1",
        listings: out.slice(0, take).map((r) => ({ ownerPartyId: r.ownerPartyId })),
      });
    });
  }

  /** Runs registerCarparkService and returns the `data` handed to carpark.create. */
  async function capturedCreateData() {
    const db = getDb() as any;
    const create = vi.fn().mockResolvedValue({ id: "cp-1" });
    db.$transaction.mockImplementation(async (fn: any) =>
      fn({ carpark: { create }, auditLog: { create: vi.fn() } }),
    );
    const r = await registerCarparkService(SESSION, {
      apartmentId: "apt-1", label: "P-12", monthlyRate: "120.00",
    } as any);
    expect(r.ok).toBe(true);
    return create.mock.calls[0][0].data as Record<string, unknown>;
  }

  it("is born OWNERLESS when the apartment's only owned listing is ARCHIVED", async () => {
    stubApartmentListings([
      { id: "l-1", ownerPartyId: "owner-stale", listingStatus: "archived" },
    ]);
    const data = await capturedCreateData();
    // A bay defaults to status:"available" (active), so an archived owner stamped
    // here would immediately become an inheritance source for the next room.
    expect(data.ownerPartyId).toBeNull();
  });

  it("still inherits the owner from a NON-archived listing", async () => {
    stubApartmentListings([
      { id: "l-1", ownerPartyId: "owner-9", listingStatus: "active" },
    ]);
    const data = await capturedCreateData();
    expect(data.ownerPartyId).toBe("owner-9");
  });

  it("skips the archived row and takes the active one when both exist", async () => {
    stubApartmentListings([
      { id: "l-1", ownerPartyId: "owner-stale", listingStatus: "archived" },
      { id: "l-2", ownerPartyId: "owner-current", listingStatus: "active" },
    ]);
    const data = await capturedCreateData();
    expect(data.ownerPartyId).toBe("owner-current");
  });

  it("pins a deterministic orderBy on the owner-derivation scan", async () => {
    stubApartmentListings([]);
    await capturedCreateData();
    const db = getDb() as any;
    const args = db.apartment.findFirst.mock.calls[0][0];
    // `take: 1` without an orderBy returns an arbitrary row.
    expect(args.select.listings.orderBy).toEqual({ id: "asc" });
    expect(args.select.listings.where).toMatchObject({
      ownerPartyId: { not: null },
      listingStatus: { not: "archived" },
    });
  });
});

describe("deactivateCarparkService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when carpark is not found", async () => {
    const db = getDb() as any;
    db.carpark.findFirst.mockResolvedValue(null);
    const r = await deactivateCarparkService(SESSION, "cp-unknown");
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("blocks deactivation when carpark has an active assignment", async () => {
    const db = getDb() as any;
    db.carpark.findFirst.mockResolvedValue({ id: "cp-1" });
    db.carparkAssignment.count.mockResolvedValue(1);
    const r = await deactivateCarparkService(SESSION, "cp-1");
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("deactivates successfully when no active assignments exist", async () => {
    const db = getDb() as any;
    db.carpark.findFirst.mockResolvedValue({ id: "cp-1" });
    db.carparkAssignment.count.mockResolvedValue(0);
    db.$transaction.mockImplementation(async (fn: any) => fn({
      carpark: { update: vi.fn().mockResolvedValue({ id: "cp-1" }) },
      auditLog: { create: vi.fn() },
    }));
    const r = await deactivateCarparkService(SESSION, "cp-1");
    expect(r).toMatchObject({ ok: true, data: { id: "cp-1" } });
  });
});

describe("updateCarparkService — inactive guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 409 when PATCH sets status=inactive but an active assignment exists", async () => {
    // Mirrors the same guard as deactivateCarparkService — a PATCH must not
    // bypass the 409 by supplying status:"inactive" directly.
    const db = getDb() as any;
    db.carpark.findFirst.mockResolvedValue({ id: "cp-1" });
    db.carparkAssignment.count.mockResolvedValue(1);
    const r = await updateCarparkService(SESSION, { carparkId: "cp-1", status: "inactive" });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("allows PATCH to set status=inactive when no active assignments exist", async () => {
    const db = getDb() as any;
    db.carpark.findFirst.mockResolvedValue({ id: "cp-1" });
    db.carparkAssignment.count.mockResolvedValue(0);
    db.$transaction.mockImplementation(async (fn: any) => fn({
      carpark: { update: vi.fn().mockResolvedValue({ id: "cp-1" }) },
      auditLog: { create: vi.fn() },
    }));
    const r = await updateCarparkService(SESSION, { carparkId: "cp-1", status: "inactive" });
    expect(r).toMatchObject({ ok: true, data: { id: "cp-1" } });
  });

  it("allows PATCH with other fields (label, monthlyRate) without any active-assignment check", async () => {
    const db = getDb() as any;
    db.carpark.findFirst.mockResolvedValue({ id: "cp-1" });
    db.$transaction.mockImplementation(async (fn: any) => fn({
      carpark: { update: vi.fn().mockResolvedValue({ id: "cp-1" }) },
      auditLog: { create: vi.fn() },
    }));
    const r = await updateCarparkService(SESSION, { carparkId: "cp-1", label: "P-99", monthlyRate: "150.00" });
    expect(r).toMatchObject({ ok: true });
    // countActiveAssignments must NOT be called when status is not "inactive".
    expect(db.carparkAssignment.count).not.toHaveBeenCalled();
  });
});
