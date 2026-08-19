/**
 * Integration tests for createTenancyService — Task T9 (overwrite param +
 * active-tenancy guard + P2002->409 map on the MANUAL/direct tenancy-assign
 * path). No RESERVATION_REQUIRED gate exists or is added here -- the manual
 * path (admin enters rent+dates, no reservation required) stays open; see
 * "manual create no gate" below.
 *
 * Hits a real local Postgres. Skipped by default. Run explicitly:
 *   cd apps/api && RUN_INTEGRATION=1 \
 *     DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *     npx vitest run tenancy.service.overwrite
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  // Real Tenancy rows written here (money-critical write path) -- refuse to
  // run against anything but the local dev DB, even by accident.
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`tenancy.service.overwrite.integration.test.ts: refusing non-local DB host "${host}"`);
  }
}

// The one-active-per-unit P2002 case ("concurrent 409") can't be produced by
// a genuine single-process race against the app-level pre-check (the check
// always wins the race in-process -- see one-active-per-unit.migration
// .integration.test.ts's own comment on this). Mirroring
// convert-reservation.p2002-classify.test.ts's approach: stub it, but keep
// the REST of this file on the real DB by toggling only for that one test
// (verified empirically: `tx` inside $transaction is a distinct object from
// the top-level client, so a plain monkeypatch of the top-level client does
// NOT reach `tx.*` -- a full pass-through/stub swap via the mocked module is
// the only way that also lets the other cases hit real Postgres).
const { p2002Toggle } = vi.hoisted(() => ({ p2002Toggle: { stub: false } }));

vi.mock("@kason/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kason/db")>();
  // Covers createTenancyService's pre-checks (findProperty/findUnit/
  // findTenantRole/findTenancyByCode, all via getDb()) with a "unit is free,
  // valid, owned" fixture so control flow reaches the create -- ONLY
  // tenancy.create is stubbed to fail, the real thing under test.
  const stubTx = {
    property: { findFirst: vi.fn().mockResolvedValue({ id: "stub-property" }) },
    listing: {
      findFirst: vi.fn().mockResolvedValue({
        id: "stub-unit",
        ownerPartyId: "stub-owner",
        apartment: { propertyId: "stub-property" },
      }),
    },
    partyRole: { findFirst: vi.fn().mockResolvedValue({ id: "stub-role" }) },
    tenancy: {
      findFirst: vi.fn().mockResolvedValue(null), // no duplicate code, no active tenancy
      create: vi.fn().mockRejectedValue(
        new actual.Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed on the fields: (`organizationId`,`unitId`)",
          { code: "P2002", clientVersion: "x", meta: { target: ["organizationId", "unitId"] } },
        ),
      ),
    },
  };
  const stubClient = { ...stubTx, $transaction: vi.fn((fn: (tx: typeof stubTx) => unknown) => fn(stubTx)) };
  return {
    ...actual,
    getDb: () => (p2002Toggle.stub ? stubClient : actual.getDb()),
  };
});

import { getDb } from "@kason/db";
import { createTenancyService } from "../tenancy.service";

const ORG = "99990007-0007-4007-8007-000000000001";
const ADMIN_USER = "99990007-0007-4007-8007-000000000002";
const OWNER_PARTY = "99990007-0007-4007-8007-000000000003";
const PROPERTY = "99990007-0007-4007-8007-000000000004";
const APARTMENT = "99990007-0007-4007-8007-000000000005";
const UNIT = "99990007-0007-4007-8007-000000000006";
const TENANT_PARTY_A = "99990007-0007-4007-8007-000000000007"; // incumbent
const TENANT_ROLE_A = "99990007-0007-4007-8007-000000000008";
const TENANT_PARTY_B = "99990007-0007-4007-8007-000000000009"; // incoming
const TENANT_ROLE_B = "99990007-0007-4007-8007-00000000000a";
const CARPARK_TAKEN = "99990007-0007-4007-8007-00000000000c";
// T14 sibling-door fix: a second, owned+free unit so the already-converted
// guard test can isolate itself from the UNIT_HAS_ACTIVE_TENANCY guard.
const APARTMENT_2 = "99990007-0007-4007-8007-00000000000d";
const UNIT_2 = "99990007-0007-4007-8007-00000000000e";
// Signed reservation linked (tenantPartyId) to TENANT_PARTY_A -- the
// "created-from" state -- proves createTenancyService's tenant-match guard.
const RES_T14_LINKED = "99990007-0007-4007-8007-000000000120";
// Signed reservation with NO tenant link (tenantPartyId null) -- proves the
// null-link backward-compat path stays open.
const RES_T14_NULL_LINK = "99990007-0007-4007-8007-000000000121";
// Signed reservation used to prove one-reservation-one-tenancy: converted
// once via createTenancyService, then reconverted onto a DIFFERENT unit.
const RES_T14_ALREADY = "99990007-0007-4007-8007-000000000122";
// T14-fix2: reservation linked to TENANT_PARTY_A, status "cancelled" (never
// signed) -- proves createTenancyService rejects seeding a tenancy from a
// reservation that hasn't reached "signed", mirroring convert's status gate.
const RES_T14_NOT_SIGNED = "99990007-0007-4007-8007-000000000123";

const SESSION = { orgId: ORG, userId: ADMIN_USER, role: "admin" };

async function cleanup() {
  const db = getDb();
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.carparkAssignment.deleteMany({ where: { organizationId: ORG } });
  await db.carpark.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.partyRole.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "T9 Overwrite Test Org",
      slug: "t9-overwrite-test-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: ADMIN_USER,
      organizationId: ORG,
      email: "admin@t9-overwrite.test",
      fullName: "T9 Admin",
      passwordHash: "x",
      status: "active",
      role: "admin",
      userType: "operator",
    },
  });
  await db.party.create({
    data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner Co", partyType: "agent", status: "active" },
  });
  await db.party.create({
    data: { id: TENANT_PARTY_A, organizationId: ORG, displayName: "Tenant A (incumbent)", partyType: "individual", status: "active" },
  });
  await db.partyRole.create({
    data: { id: TENANT_ROLE_A, organizationId: ORG, partyId: TENANT_PARTY_A, roleType: "tenant", status: "active" },
  });
  await db.party.create({
    data: { id: TENANT_PARTY_B, organizationId: ORG, displayName: "Tenant B (incoming)", partyType: "individual", status: "active" },
  });
  await db.partyRole.create({
    data: { id: TENANT_ROLE_B, organizationId: ORG, partyId: TENANT_PARTY_B, roleType: "tenant", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "T9 Overwrite Test Property",
      propertyCode: "T9OW-1",
      propertyType: "residential",
      addressLine1: "1 T9 St",
      city: "Kuala Lumpur",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "T9-101", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT,
      organizationId: ORG,
      apartmentId: APARTMENT,
      listingType: "apartment",
      occupancyStatus: "vacant",
      listingStatus: "active",
      readyNow: true,
      currency: "MYR",
      ownerPartyId: OWNER_PARTY,
    },
  });

  // T14 sibling-door fix: a second, owned+free unit for the already-converted
  // guard test (isolates it from the active-tenancy guard on UNIT).
  await db.apartment.create({
    data: { id: APARTMENT_2, organizationId: ORG, propertyId: PROPERTY, unitCode: "T9-102", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT_2,
      organizationId: ORG,
      apartmentId: APARTMENT_2,
      listingType: "apartment",
      occupancyStatus: "vacant",
      listingStatus: "active",
      readyNow: true,
      currency: "MYR",
      ownerPartyId: OWNER_PARTY,
    },
  });

  // T14: signed + valid rent + linked (tenantPartyId) to TENANT_PARTY_A --
  // the "created-from" state a real applicant flow leaves behind.
  await db.unitReservation.create({
    data: {
      id: RES_T14_LINKED,
      organizationId: ORG,
      referenceCode: "RES-T14-LINKED",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t14b-linked",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-07-06T00:00:00Z"),
      proposedMoveOut: new Date("2026-07-25T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "2800.00",
      signedAt: new Date("2026-07-01T00:00:00Z"),
      tenantPartyId: TENANT_PARTY_A,
    },
  });

  // T14: signed + valid rent, NO tenant link (legacy/direct reservation) --
  // proves the null-link path stays open (backward-compat).
  await db.unitReservation.create({
    data: {
      id: RES_T14_NULL_LINK,
      organizationId: ORG,
      referenceCode: "RES-T14-NULLLINK",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t14b-nulllink",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-07-06T00:00:00Z"),
      proposedMoveOut: new Date("2026-07-25T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "2900.00",
      signedAt: new Date("2026-07-01T00:00:00Z"),
      // tenantPartyId deliberately omitted (null)
    },
  });

  // T14: signed + valid rent, no tenant link -- used ONLY for the
  // already-converted test, so that guard fires in isolation from the
  // tenant-match guard.
  await db.unitReservation.create({
    data: {
      id: RES_T14_ALREADY,
      organizationId: ORG,
      referenceCode: "RES-T14-ALREADY",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t14b-already",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-07-06T00:00:00Z"),
      proposedMoveOut: new Date("2026-07-25T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "3000.00",
      signedAt: new Date("2026-07-01T00:00:00Z"),
    },
  });

  // T14-fix2: linked to TENANT_PARTY_A like RES_T14_LINKED, but status
  // "cancelled" -- never reached "signed". Proves the not-signed guard fires
  // even though tenant + unit both match.
  await db.unitReservation.create({
    data: {
      id: RES_T14_NOT_SIGNED,
      organizationId: ORG,
      referenceCode: "RES-T14-NOTSIGNED",
      status: "cancelled",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t14b-notsigned",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-07-06T00:00:00Z"),
      proposedMoveOut: new Date("2026-07-25T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "2750.00",
      tenantPartyId: TENANT_PARTY_A,
      cancelledAt: new Date("2026-07-02T00:00:00Z"),
    },
  });
}

// Seeds a pre-existing ACTIVE incumbent tenancy ("tenant A") directly on
// UNIT -- the shared "given" state for the blocks-active / overwrite tests.
async function seedIncumbentTenancy(opts?: { startDate?: Date; endDate?: Date | null }) {
  const db = getDb();
  const TENANCY_INCUMBENT = "99990007-0007-4007-8007-000000000101";
  await db.tenancy.create({
    data: {
      id: TENANCY_INCUMBENT,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY_A,
      tenancyCode: "TEN-T9-INCUMBENT",
      status: "active",
      billingStatus: "active",
      startDate: opts?.startDate ?? new Date("2026-01-01T00:00:00Z"),
      endDate: opts?.endDate === undefined ? new Date("2026-11-30T00:00:00Z") : opts.endDate,
      monthlyRentAmount: "2500.00",
    },
  });
  return { tenancyId: TENANCY_INCUMBENT };
}

dn("createTenancyService overwrite + active-tenancy guard + P2002 (T9, integration)", () => {
  beforeEach(async () => {
    p2002Toggle.stub = false;
    await cleanup();
    await seed();
  });

  it("manual create no gate: no reservationId + manual rent/dates on a free unit creates a tenancy (proves the manual path stays open, no RESERVATION_REQUIRED)", async () => {
    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY_A,
      tenancyCode: "TEN-T9-MANUAL",
      startDate: "2026-01-01",
      monthlyRentAmount: "2000",
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    const db = getDb();
    const tenancy = await db.tenancy.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(tenancy.status).toBe("active");
    expect(tenancy.reservationId).toBeNull();
    expect(Number(tenancy.monthlyRentAmount)).toBe(2000);
  });

  it("blocks active: 409 UNIT_HAS_ACTIVE_TENANCY with incumbent details, no overwrite requested, no mutation", async () => {
    const { tenancyId: incumbentId } = await seedIncumbentTenancy();

    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY_B,
      tenancyCode: "TEN-T9-BLOCKED",
      startDate: "2026-12-01",
      monthlyRentAmount: "2600",
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect((result as { code?: string }).code).toBe("UNIT_HAS_ACTIVE_TENANCY");
    const incumbent = (result as { incumbent?: { tenantName: string; endDate: Date | null } }).incumbent;
    expect(incumbent?.tenantName).toBe("Tenant A (incumbent)");
    expect(incumbent?.endDate?.toISOString()).toBe(new Date("2026-11-30T00:00:00Z").toISOString());

    // No new row, incumbent completely untouched.
    const db = getDb();
    const count = await db.tenancy.count({ where: { organizationId: ORG, tenancyCode: "TEN-T9-BLOCKED" } });
    expect(count).toBe(0);
    const incumbent2 = await db.tenancy.findUniqueOrThrow({ where: { id: incumbentId } });
    expect(incumbent2.status).toBe("active");
    expect(incumbent2.endDate?.toISOString()).toBe(new Date("2026-11-30T00:00:00Z").toISOString());
  });

  it("overwrite supersedes: closes the incumbent, links previousTenancyId, new tenancy active", async () => {
    const { tenancyId: incumbentId } = await seedIncumbentTenancy();

    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY_B,
      tenancyCode: "TEN-T9-OVERWRITE",
      startDate: "2026-12-01",
      monthlyRentAmount: "2700",
      overwrite: true,
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    const newId = result.data.id;

    const db = getDb();
    const incumbent = await db.tenancy.findUniqueOrThrow({ where: { id: incumbentId } });
    expect(incumbent.status).toBe("ended");
    expect(incumbent.endDate?.toISOString()).toBe(new Date("2026-12-01T00:00:00Z").toISOString());

    const created = await db.tenancy.findUniqueOrThrow({ where: { id: newId } });
    expect(created.status).toBe("active");
    expect(created.previousTenancyId).toBe(incumbentId);
    expect(created.tenantPartyId).toBe(TENANT_PARTY_B);

    // T9 review Finding 2: closing the incumbent (status=ended + bay release)
    // is a money-material lease termination -- must be audited, mirroring
    // convertReservationToTenancy's supersession audit row.
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, entityId: newId, action: "tenancy.manual_overwrite" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(ADMIN_USER);
    expect(audit?.actorRole).toBe("admin");
    expect((audit?.meta as { supersededTenancyId?: string } | null)?.supersededTenancyId).toBe(incumbentId);
  });

  it("overwrite clamps incumbent endDate to its own start when the new startDate is backdated (a tenancy can never end before it began)", async () => {
    // Incumbent starts 2026-06-01; the incoming (overwrite) tenancy's
    // startDate is 2026-01-01 -- BEFORE the incumbent even began. Clamp
    // endDate = max(newStartDate, prior.startDate) = incumbent's own start.
    const { tenancyId: incumbentId } = await seedIncumbentTenancy({
      startDate: new Date("2026-06-01T00:00:00Z"),
      endDate: new Date("2027-05-31T00:00:00Z"),
    });

    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY_B,
      tenancyCode: "TEN-T9-BACKDATED",
      startDate: "2026-01-01",
      monthlyRentAmount: "2700",
      overwrite: true,
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDb();
    const incumbent = await db.tenancy.findUniqueOrThrow({ where: { id: incumbentId } });
    expect(incumbent.status).toBe("ended");
    // Clamped to the incumbent's OWN start, NOT the (earlier) new startDate.
    expect(incumbent.endDate?.toISOString()).toBe(new Date("2026-06-01T00:00:00Z").toISOString());
  });

  it("concurrent 409: a P2002 on the one-active-per-unit index maps to 409 CONCURRENT_ACTIVE_TENANCY, not a raw 500 (race backstop, stubbed)", async () => {
    // The app-level active-tenancy pre-check always wins a genuine
    // single-process race, so this can't be produced by seeding + a real
    // call (see one-active-per-unit.migration.integration.test.ts's own
    // comment on this). Stubbed the same way
    // convert-reservation.p2002-classify.test.ts does: toggle @kason/db's
    // getDb() to a client whose tenancy.create rejects with a real P2002
    // shape, for just this one test.
    p2002Toggle.stub = true;

    const result = await createTenancyService(SESSION, {
      propertyId: "stub-property",
      unitId: "stub-unit",
      tenantPartyId: TENANT_PARTY_A,
      tenancyCode: "TEN-T9-RACE",
      startDate: "2026-01-01",
      monthlyRentAmount: "2000",
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect((result as { code?: string }).code).toBe("CONCURRENT_ACTIVE_TENANCY");
  });

  it("overwrite rolls back atomically when the carpark assignment fails (incumbent stays active, no orphan new tenancy)", async () => {
    const { tenancyId: incumbentId } = await seedIncumbentTenancy();
    const db = getDb();
    // A bay that's already rented elsewhere -- assignCarparksTx's
    // availability guard rejects it (409), which must roll back the
    // incumbent close-out too (never a partial supersession).
    await db.carpark.create({
      data: {
        id: CARPARK_TAKEN,
        organizationId: ORG,
        propertyId: PROPERTY,
        apartmentId: APARTMENT,
        label: "TAKEN",
        monthlyRate: "100.00",
        status: "rented",
      },
    });

    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY_B,
      tenancyCode: "TEN-T9-OVERWRITE-CPFAIL",
      startDate: "2026-12-01",
      monthlyRentAmount: "2700",
      overwrite: true,
      carparks: [{ carparkId: CARPARK_TAKEN }],
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe("CARPARK_ALREADY_RENTED");

    const incumbent = await db.tenancy.findUniqueOrThrow({ where: { id: incumbentId } });
    expect(incumbent.status).toBe("active");
    const newCount = await db.tenancy.count({ where: { organizationId: ORG, tenancyCode: "TEN-T9-OVERWRITE-CPFAIL" } });
    expect(newCount).toBe(0);
  });

  // ── T14 sibling-door fix: reservation tenant-match + already-converted ────
  // guards mirrored from convertReservationToTenancy onto createTenancyService
  // (POST /tenancies), the second authenticated door that also accepts a
  // reservationId and applies its rent.

  it("422s RESERVATION_TENANT_MISMATCH when the reservation is linked to a DIFFERENT tenant than the one being assigned, and creates NO tenancy row (fails closed)", async () => {
    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY_B, // reservation is linked to TENANT_PARTY_A, not B
      tenancyCode: "TEN-T14-MISMATCH",
      startDate: "2026-07-06",
      reservationId: RES_T14_LINKED,
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect((result as { code?: string }).code).toBe("RESERVATION_TENANT_MISMATCH");

    const db = getDb();
    const count = await db.tenancy.count({ where: { reservationId: RES_T14_LINKED } });
    expect(count).toBe(0);
  });

  it("409s RESERVATION_ALREADY_CONVERTED with existingTenancyId when the reservation already has a tenancy (a DIFFERENT free unit isolates this from UNIT_HAS_ACTIVE_TENANCY)", async () => {
    const first = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY_A,
      tenancyCode: "TEN-T14-ALREADY-1",
      startDate: "2026-07-06",
      reservationId: RES_T14_ALREADY,
    } as never);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT_2, // a DIFFERENT free unit -- proves this is the already-converted
      // guard firing, not the unit's active-tenancy guard.
      tenantPartyId: TENANT_PARTY_A,
      tenancyCode: "TEN-T14-ALREADY-2",
      startDate: "2026-07-06",
      reservationId: RES_T14_ALREADY,
    } as never);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
    expect((second as { code?: string }).code).toBe("RESERVATION_ALREADY_CONVERTED");
    expect((second as { existingTenancyId?: string }).existingTenancyId).toBe(first.data.id);

    const db = getDb();
    const count = await db.tenancy.count({ where: { reservationId: RES_T14_ALREADY } });
    expect(count).toBe(1);
  });

  it("201s when the reservation's linked tenant MATCHES the tenant being assigned (the normal created-from-then-assign flow)", async () => {
    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY_A, // matches the reservation's linked tenant
      tenancyCode: "TEN-T14-MATCH",
      startDate: "2026-07-06",
      reservationId: RES_T14_LINKED,
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    const db = getDb();
    const tenancy = await db.tenancy.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(tenancy.tenantPartyId).toBe(TENANT_PARTY_A);
    expect(tenancy.reservationId).toBe(RES_T14_LINKED);
    expect(Number(tenancy.monthlyRentAmount)).toBe(2800);
  });

  it("201s backward-compat: a reservation with NO tenant link (tenantPartyId null) allows create with ANY valid tenant-role party", async () => {
    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY_B,
      tenancyCode: "TEN-T14-NULLLINK",
      startDate: "2026-07-06",
      reservationId: RES_T14_NULL_LINK,
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    const db = getDb();
    const tenancy = await db.tenancy.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(tenancy.tenantPartyId).toBe(TENANT_PARTY_B);
    expect(tenancy.reservationId).toBe(RES_T14_NULL_LINK);
    expect(Number(tenancy.monthlyRentAmount)).toBe(2900);
  });

  // ── T14-fix2: unit-consistency + status guards (completes convert parity) ──
  // Adversarial review found createTenancyService's reservationId branch
  // still diverged from convertReservationToTenancy on two invariants:
  // (a) convert forces unitId = r.unitId, so a mismatched unitId can never
  //     reach it; this path takes input.unitId verbatim, so a reservation
  //     signed for UNIT could seed a tenancy on UNIT_2 while applying UNIT's
  //     negotiated rent + stamping this reservation's id.
  // (b) convert requires status === "signed"; this path never checked it, so
  //     a cancelled/expired reservation still linked to a tenant could seed
  //     rent.

  it("422s RESERVATION_UNIT_MISMATCH when input.unitId differs from the reservation's own unitId, and creates NO tenancy row (fails closed)", async () => {
    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT_2, // RES_T14_LINKED was signed for UNIT, not UNIT_2
      tenantPartyId: TENANT_PARTY_A, // matches the reservation's linked tenant -- isolates this from RESERVATION_TENANT_MISMATCH
      tenancyCode: "TEN-T14-UNITMISMATCH",
      startDate: "2026-07-06",
      reservationId: RES_T14_LINKED,
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect((result as { code?: string }).code).toBe("RESERVATION_UNIT_MISMATCH");

    const db = getDb();
    const count = await db.tenancy.count({ where: { reservationId: RES_T14_LINKED } });
    expect(count).toBe(0);
  });

  it("400s RESERVATION_NOT_SIGNED when the reservation is linked + unit-matched but never reached signed, and creates NO tenancy row (fails closed)", async () => {
    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT, // matches RES_T14_NOT_SIGNED's own unitId -- isolates this from RESERVATION_UNIT_MISMATCH
      tenantPartyId: TENANT_PARTY_A, // matches the reservation's linked tenant -- isolates this from RESERVATION_TENANT_MISMATCH
      tenancyCode: "TEN-T14-NOTSIGNED",
      startDate: "2026-07-06",
      reservationId: RES_T14_NOT_SIGNED,
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect((result as { code?: string }).code).toBe("RESERVATION_NOT_SIGNED");

    const db = getDb();
    const count = await db.tenancy.count({ where: { reservationId: RES_T14_NOT_SIGNED } });
    expect(count).toBe(0);
  });
});
