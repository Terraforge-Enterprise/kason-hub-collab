/**
 * Integration tests for convertReservationToTenancy — Task 5 (guards + derivation).
 *
 * Hits a real local Postgres. Skipped by default. Run explicitly:
 *   cd apps/api && RUN_INTEGRATION=1 \
 *     DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *     npx vitest run convert-reservation
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { convertReservationToTenancy } from "../convert-reservation.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  // This suite creates real Tenancy rows. Refuse to run against anything but
  // the local dev DB, even by accident (money-critical write path).
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`convert-reservation.integration.test.ts: refusing non-local DB host "${host}"`);
  }
}

const ORG = "99990005-0005-4005-8005-000000000001";
const ORG_OTHER = "99990005-0005-4005-8005-0000000000f1";
const ADMIN_USER = "99990005-0005-4005-8005-000000000002";
const OWNER_PARTY = "99990005-0005-4005-8005-000000000003";
const PROPERTY = "99990005-0005-4005-8005-000000000004";
const APARTMENT = "99990005-0005-4005-8005-000000000005";
const UNIT = "99990005-0005-4005-8005-000000000006";
const APARTMENT_NO_OWNER = "99990005-0005-4005-8005-00000000000b";
const UNIT_NO_OWNER = "99990005-0005-4005-8005-00000000000c";
const TENANT_PARTY = "99990005-0005-4005-8005-000000000007";
const TENANT_ROLE = "99990005-0005-4005-8005-000000000008";
// Deliberately partyType === "tenant" but holds an unrelated "owner" role,
// never a tenant role -- proves the guard rejects by ROLE, not by partyType.
const INVALID_TENANT_PARTY = "99990005-0005-4005-8005-000000000009";
const INVALID_TENANT_ROLE = "99990005-0005-4005-8005-00000000000a";

const RES_HAPPY = "99990005-0005-4005-8005-000000000101";
const RES_NOT_SIGNED = "99990005-0005-4005-8005-000000000102";
const RES_MISSING_RENT = "99990005-0005-4005-8005-000000000103";
const RES_ZERO_RENT = "99990005-0005-4005-8005-00000000010a";
const RES_ALREADY = "99990005-0005-4005-8005-000000000104";
const RES_INVALID_TENANT = "99990005-0005-4005-8005-000000000105";
const RES_NO_OWNER = "99990005-0005-4005-8005-000000000106";
const RES_ACTIVE_CONFLICT = "99990005-0005-4005-8005-000000000107";
const RES_OPEN_ENDED = "99990005-0005-4005-8005-000000000108";
const RES_CROSS_ORG = "99990005-0005-4005-8005-000000000109";

// T7 (overlap warn + overwrite) fixtures -- a second tenant party ("tenant B",
// the incoming tenant) and a carpark bay, used to seed a pre-existing
// incumbent tenancy ("tenant A") directly (not via convertReservationToTenancy)
// so the overwrite tests start from a known active-tenancy + rented-bay state.
const TENANT_PARTY_B = "99990005-0005-4005-8005-00000000000d";
const TENANT_ROLE_B = "99990005-0005-4005-8005-00000000000e";
const CARPARK_B1 = "99990005-0005-4005-8005-00000000000f";
const CARPARK_TAKEN = "99990005-0005-4005-8005-000000000010";
const TENANCY_T1_INCUMBENT = "99990005-0005-4005-8005-000000000110";
const CARPARK_ASSIGNMENT_T1 = "99990005-0005-4005-8005-000000000111";
const CHARGE_T1 = "99990005-0005-4005-8005-000000000112";
const RES_OVERWRITE = "99990005-0005-4005-8005-000000000113";
const RES_OVERWRITE_CARPARK_FAIL = "99990005-0005-4005-8005-000000000114";
// A second, owned+free unit -- needed so the REAL tenancyCode-collision test
// can reach tx.tenancy.create (no active-tenancy guard in the way) while
// still colliding on the real (organizationId, tenancyCode) DB constraint.
const APARTMENT_2 = "99990005-0005-4005-8005-000000000115";
const UNIT_2 = "99990005-0005-4005-8005-000000000116";
const RES_TENANCY_CODE_DUP = "99990005-0005-4005-8005-000000000117";
// T7 review Finding 1 -- a backdated incumbent + reservation pair: the
// incumbent starts LATER than the incoming reservation's proposedMoveIn,
// exercising the endDate-clamp fix (see seedBackdatedIncumbentTenancy).
const TENANCY_T1_BACKDATED = "99990005-0005-4005-8005-000000000118";
const RES_OVERWRITE_BACKDATED = "99990005-0005-4005-8005-000000000119";
// T14: signed reservation already linked (tenantPartyId) to TENANT_PARTY --
// the "created-from" link -- used to prove the tenant-match guard rejects a
// convert onto a DIFFERENT tenant (TENANT_PARTY_B) while a MATCHING convert
// still succeeds.
const RES_TENANT_LINKED = "99990005-0005-4005-8005-00000000011a";

const SESSION = { orgId: ORG, userId: ADMIN_USER, role: "admin" };

async function cleanup() {
  const db = getDb();
  // Charge before Tenancy (Charge.tenancyId is onDelete:SetNull, order doesn't
  // matter for the FK, but keep money rows out of the way first). Tenancy
  // deletion cascades CarparkAssignment (onDelete:Cascade); Carpark itself
  // must go AFTER that (CarparkAssignment -> Carpark is onDelete:Restrict).
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.carpark.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.unitReservation.deleteMany({ where: { organizationId: { in: [ORG, ORG_OTHER] } } });
  await db.partyRole.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: { in: [ORG, ORG_OTHER] } } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Convert Test Org",
      slug: "convert-test-org-t5",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  // A second org, used only to prove a reservation belonging to it is 404
  // (never leaked) when looked up under SESSION.orgId=ORG.
  await db.organization.create({
    data: {
      id: ORG_OTHER,
      name: "Convert Test Org (Other)",
      slug: "convert-test-org-t5-other",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  // AuditLog.actorUserId FK -> User.id (onDelete: Restrict): the acting admin
  // must exist or the audit insert (inside the same tx) rolls the whole
  // conversion back on a FK violation.
  await db.user.create({
    data: {
      id: ADMIN_USER,
      organizationId: ORG,
      email: "admin@convert-t5.test",
      fullName: "Convert Admin",
      passwordHash: "x",
      status: "active",
      role: "admin",
      userType: "operator",
    },
  });
  await db.party.create({
    data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner Co", partyType: "agent", status: "active" },
  });
  // Deliberately partyType !== "tenant" -- must still be accepted because the
  // guard checks the tenant PartyRole, never Party.partyType (Requirement #1).
  await db.party.create({
    data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Valid Tenant", partyType: "individual", status: "active" },
  });
  await db.partyRole.create({
    data: { id: TENANT_ROLE, organizationId: ORG, partyId: TENANT_PARTY, roleType: "tenant", status: "active" },
  });
  // Deliberately partyType === "tenant" but NO tenant PartyRole (holds an
  // unrelated "owner" role instead) -- proves the guard rejects on the
  // missing ROLE, not because partyType looks wrong.
  await db.party.create({
    data: { id: INVALID_TENANT_PARTY, organizationId: ORG, displayName: "Fake Tenant", partyType: "tenant", status: "active" },
  });
  await db.partyRole.create({
    data: { id: INVALID_TENANT_ROLE, organizationId: ORG, partyId: INVALID_TENANT_PARTY, roleType: "owner", status: "active" },
  });
  // "Tenant B" -- the incoming tenant used by the T7 overlap/overwrite tests
  // (distinct from TENANT_PARTY, which plays the incumbent "tenant A").
  await db.party.create({
    data: { id: TENANT_PARTY_B, organizationId: ORG, displayName: "Tenant B", partyType: "individual", status: "active" },
  });
  await db.partyRole.create({
    data: { id: TENANT_ROLE_B, organizationId: ORG, partyId: TENANT_PARTY_B, roleType: "tenant", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Convert Test Property",
      propertyCode: "CVT5-1",
      propertyType: "residential",
      addressLine1: "1 Convert St",
      city: "Kuala Lumpur",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "CV-101", listingMode: "WHOLE" },
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
  // Deliberately no ownerPartyId -- owner drives money attribution (parity
  // with createTenancyService + occupancy-tenancy-sync).
  await db.apartment.create({
    data: { id: APARTMENT_NO_OWNER, organizationId: ORG, propertyId: PROPERTY, unitCode: "CV-102", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT_NO_OWNER,
      organizationId: ORG,
      apartmentId: APARTMENT_NO_OWNER,
      listingType: "apartment",
      occupancyStatus: "vacant",
      listingStatus: "active",
      readyNow: true,
      currency: "MYR",
      // ownerPartyId deliberately omitted
    },
  });

  // A second, owned+free unit for the REAL tenancyCode-collision test.
  await db.apartment.create({
    data: { id: APARTMENT_2, organizationId: ORG, propertyId: PROPERTY, unitCode: "CV-103", listingMode: "WHOLE" },
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

  await db.unitReservation.create({
    data: {
      id: RES_HAPPY,
      organizationId: ORG,
      referenceCode: "RES-T5-HAPPY",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t5-happy",
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
    },
  });

  await db.unitReservation.create({
    data: {
      id: RES_NOT_SIGNED,
      organizationId: ORG,
      referenceCode: "RES-T5-NOTSIGNED",
      status: "pending_customer",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t5-notsigned",
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
    },
  });

  await db.unitReservation.create({
    data: {
      id: RES_MISSING_RENT,
      organizationId: ORG,
      referenceCode: "RES-T5-NORENT",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t5-norent",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-07-06T00:00:00Z"),
      proposedMoveOut: new Date("2026-07-25T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: null, // signed before agreedMonthlyRent was required (R5) -- must refuse, never default.
      signedAt: new Date("2026-07-01T00:00:00Z"),
    },
  });

  // Signed with agreedMonthlyRent="0.00" -- distinct from RES_MISSING_RENT
  // (null): proves the guard also rejects a non-null but non-positive rent,
  // not just a missing one (R9, Task-5 review).
  await db.unitReservation.create({
    data: {
      id: RES_ZERO_RENT,
      organizationId: ORG,
      referenceCode: "RES-T5-ZERORENT",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t5-zerorent",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-07-06T00:00:00Z"),
      proposedMoveOut: new Date("2026-07-25T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "0.00",
      signedAt: new Date("2026-07-01T00:00:00Z"),
    },
  });

  await db.unitReservation.create({
    data: {
      id: RES_ALREADY,
      organizationId: ORG,
      referenceCode: "RES-T5-ALREADY",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t5-already",
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
    },
  });

  await db.unitReservation.create({
    data: {
      id: RES_INVALID_TENANT,
      organizationId: ORG,
      referenceCode: "RES-T5-INVALIDTENANT",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t5-invalidtenant",
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
    },
  });

  await db.unitReservation.create({
    data: {
      id: RES_NO_OWNER,
      organizationId: ORG,
      referenceCode: "RES-T5-NOOWNER",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t5-noowner",
      propertyId: PROPERTY,
      unitId: UNIT_NO_OWNER,
      proposedMoveIn: new Date("2026-07-06T00:00:00Z"),
      proposedMoveOut: new Date("2026-07-25T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "2800.00",
      signedAt: new Date("2026-07-01T00:00:00Z"),
    },
  });

  // Second signed reservation on the SAME unit as RES_HAPPY -- used to prove
  // the unit-free guard once RES_HAPPY has already been converted there.
  await db.unitReservation.create({
    data: {
      id: RES_ACTIVE_CONFLICT,
      organizationId: ORG,
      referenceCode: "RES-T5-ACTIVECONFLICT",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t5-activeconflict",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-08-01T00:00:00Z"),
      proposedMoveOut: new Date("2026-08-20T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "2500.00",
      signedAt: new Date("2026-07-01T00:00:00Z"),
    },
  });

  // Open-ended reservation (no move-out date yet) -- proves endDate stays
  // null rather than being defaulted.
  await db.unitReservation.create({
    data: {
      id: RES_OPEN_ENDED,
      organizationId: ORG,
      referenceCode: "RES-T5-OPENENDED",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t5-openended",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-07-06T00:00:00Z"),
      proposedMoveOut: null,
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "2800.00",
      signedAt: new Date("2026-07-01T00:00:00Z"),
    },
  });

  // Belongs to ORG_OTHER, not ORG -- proves the org-scoped lookup can't leak
  // a reservation across organizations (property/unit/party ids are reused
  // from ORG purely to minimize fixture setup; only organizationId differs).
  await db.unitReservation.create({
    data: {
      id: RES_CROSS_ORG,
      organizationId: ORG_OTHER,
      referenceCode: "RES-T5-CROSSORG",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t5-crossorg",
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
    },
  });

  // T7: signed reservation for "tenant B" on the SAME unit as the seeded
  // incumbent tenancy (see seedIncumbentTenancyWithBay) -- proposedMoveIn is
  // the date the incumbent gets closed to on overwrite.
  await db.unitReservation.create({
    data: {
      id: RES_OVERWRITE,
      organizationId: ORG,
      referenceCode: "RES-T7-OVERWRITE",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t7-overwrite",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-12-01T00:00:00Z"),
      proposedMoveOut: new Date("2027-05-31T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "3000.00",
      signedAt: new Date("2026-11-01T00:00:00Z"),
    },
  });

  // T7: a second, distinct reservation for the carpark-failure-during-overwrite
  // test (kept separate from RES_OVERWRITE so the two tests never share a
  // reservation, even though beforeEach reseeds fresh state per test anyway).
  await db.unitReservation.create({
    data: {
      id: RES_OVERWRITE_CARPARK_FAIL,
      organizationId: ORG,
      referenceCode: "RES-T7-OVERWRITE-CARPARKFAIL",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t7-overwrite-carparkfail",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-12-01T00:00:00Z"),
      proposedMoveOut: new Date("2027-05-31T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "3000.00",
      signedAt: new Date("2026-11-01T00:00:00Z"),
    },
  });

  // T7: signed reservation on UNIT_2 (a DIFFERENT, owned+free unit) for the
  // REAL tenancyCode-collision test -- reaches tx.tenancy.create (no active
  // tenancy blocks UNIT_2) so the actual DB unique constraint fires.
  await db.unitReservation.create({
    data: {
      id: RES_TENANCY_CODE_DUP,
      organizationId: ORG,
      referenceCode: "RES-T7-TENANCYCODEDUP",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t7-tenancycodedup",
      propertyId: PROPERTY,
      unitId: UNIT_2,
      proposedMoveIn: new Date("2026-08-01T00:00:00Z"),
      proposedMoveOut: new Date("2027-01-31T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "2600.00",
      signedAt: new Date("2026-07-15T00:00:00Z"),
    },
  });

  // T7 review F1: signed reservation whose proposedMoveIn PREDATES the
  // incumbent's own startDate (a backdated/erroneous reservation) -- pairs
  // with seedBackdatedIncumbentTenancy() to exercise the endDate-clamp fix.
  await db.unitReservation.create({
    data: {
      id: RES_OVERWRITE_BACKDATED,
      organizationId: ORG,
      referenceCode: "RES-T7-OVERWRITE-BACKDATED",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t7-overwrite-backdated",
      propertyId: PROPERTY,
      unitId: UNIT,
      proposedMoveIn: new Date("2026-01-01T00:00:00Z"),
      proposedMoveOut: new Date("2026-05-31T00:00:00Z"),
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      agreedMonthlyRent: "2000.00",
      signedAt: new Date("2025-12-01T00:00:00Z"),
    },
  });

  // T14: signed + valid rent + unconverted, but linked (tenantPartyId) to
  // TENANT_PARTY -- the "created-from" state a real applicant flow leaves
  // behind. On UNIT (vacant/owned), reused safely since each test starts from
  // a fresh cleanup+reseed and never leaves a tenancy behind on a 422.
  await db.unitReservation.create({
    data: {
      id: RES_TENANT_LINKED,
      organizationId: ORG,
      referenceCode: "RES-T14-LINKED",
      status: "signed",
      issuedByPartyId: OWNER_PARTY,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      publicToken: "tok-t14-linked",
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
      tenantPartyId: TENANT_PARTY,
    },
  });
}

// T7: seeds a pre-existing ACTIVE incumbent tenancy ("tenant A") directly
// (not via convertReservationToTenancy) on UNIT, with an already-assigned
// carpark bay (B1) and one posted Charge row -- the shared "given" state for
// the overlap-warn / overwrite / carpark-rollback tests. Returns the ids so
// each test can assert against them.
async function seedIncumbentTenancyWithBay() {
  const db = getDb();
  await db.carpark.create({
    data: {
      id: CARPARK_B1,
      organizationId: ORG,
      propertyId: PROPERTY,
      apartmentId: APARTMENT,
      label: "B1",
      monthlyRate: "150.00",
      status: "rented",
    },
  });
  await db.tenancy.create({
    data: {
      id: TENANCY_T1_INCUMBENT,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY,
      tenancyCode: "TEN-T7-INCUMBENT",
      status: "active",
      billingStatus: "active",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-11-30T00:00:00Z"),
      monthlyRentAmount: "2500.00",
    },
  });
  await db.carparkAssignment.create({
    data: {
      id: CARPARK_ASSIGNMENT_T1,
      organizationId: ORG,
      carparkId: CARPARK_B1,
      tenancyId: TENANCY_T1_INCUMBENT,
      monthlyCharge: "150.00",
      startDate: new Date("2026-01-01T00:00:00Z"),
      status: "active",
    },
  });
  await db.charge.create({
    data: {
      id: CHARGE_T1,
      organizationId: ORG,
      chargeNumber: "CHG-T7-INCUMBENT-0001",
      tenancyId: TENANCY_T1_INCUMBENT,
      partyId: TENANT_PARTY,
      chargeType: "rent",
      status: "posted",
      dueDate: new Date("2026-02-01T00:00:00Z"),
      postedAt: new Date("2026-01-01T00:00:00Z"),
      amount: "2500.00",
      currency: "MYR",
      outstandingAmount: "2500.00",
    },
  });
  return {
    tenancyId: TENANCY_T1_INCUMBENT,
    carparkId: CARPARK_B1,
    carparkAssignmentId: CARPARK_ASSIGNMENT_T1,
    chargeId: CHARGE_T1,
  };
}

// T7 review F1: seeds a pre-existing ACTIVE incumbent tenancy on UNIT whose
// startDate (2026-06-01) is AFTER RES_OVERWRITE_BACKDATED's proposedMoveIn
// (2026-01-01) -- the "backdated/erroneous reservation" scenario. No carpark
// bay here (kept minimal; the clamp is orthogonal to bay reassignment, which
// is already covered by seedIncumbentTenancyWithBay).
async function seedBackdatedIncumbentTenancy() {
  const db = getDb();
  await db.tenancy.create({
    data: {
      id: TENANCY_T1_BACKDATED,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY,
      tenancyCode: "TEN-T7-BACKDATED",
      status: "active",
      billingStatus: "active",
      startDate: new Date("2026-06-01T00:00:00Z"),
      endDate: new Date("2027-05-31T00:00:00Z"),
      monthlyRentAmount: "2500.00",
    },
  });
  return { tenancyId: TENANCY_T1_BACKDATED };
}

dn("convertReservationToTenancy (integration, Task 5 guards + derivation)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  it("derives dates and rent from a signed reservation and creates an active tenancy", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_HAPPY,
      tenantPartyId: TENANT_PARTY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    const db = getDb();
    const tenancy = await db.tenancy.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(tenancy.organizationId).toBe(ORG);
    expect(tenancy.unitId).toBe(UNIT);
    expect(tenancy.propertyId).toBe(PROPERTY);
    expect(tenancy.tenantPartyId).toBe(TENANT_PARTY);
    expect(tenancy.status).toBe("active");
    expect(tenancy.billingStatus).toBe("active");
    expect(tenancy.startDate.toISOString()).toBe(new Date("2026-07-06T00:00:00Z").toISOString());
    expect(tenancy.endDate?.toISOString()).toBe(new Date("2026-07-25T00:00:00Z").toISOString());
    expect(Number(tenancy.monthlyRentAmount)).toBe(2800);
    expect(tenancy.reservationId).toBe(RES_HAPPY);
    expect(tenancy.tenancyCode).toMatch(/^TEN-\d{4}-\d{4}$/);

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, entityId: tenancy.id, action: "tenancy.convert_from_reservation" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(ADMIN_USER);
  });

  it("400s when the reservation is not signed", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_NOT_SIGNED,
      tenantPartyId: TENANT_PARTY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.code).toBe("RESERVATION_NOT_SIGNED");

    const count = await getDb().tenancy.count({ where: { reservationId: RES_NOT_SIGNED } });
    expect(count).toBe(0);
  });

  it("400s when a signed reservation has no agreed rent (missing billing data)", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_MISSING_RENT,
      tenantPartyId: TENANT_PARTY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.code).toBe("RESERVATION_MISSING_BILLING_DATA");

    const count = await getDb().tenancy.count({ where: { reservationId: RES_MISSING_RENT } });
    expect(count).toBe(0);
  });

  it("400s zero rent rejected -- a signed reservation with agreedMonthlyRent=0.00 (missing billing data)", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_ZERO_RENT,
      tenantPartyId: TENANT_PARTY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.code).toBe("RESERVATION_MISSING_BILLING_DATA");

    const count = await getDb().tenancy.count({ where: { reservationId: RES_ZERO_RENT } });
    expect(count).toBe(0);
  });

  it("409s and returns existingTenancyId on a sequential reconvert of an already-converted reservation", async () => {
    const first = await convertReservationToTenancy(SESSION, {
      reservationId: RES_ALREADY,
      tenantPartyId: TENANT_PARTY,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await convertReservationToTenancy(SESSION, {
      reservationId: RES_ALREADY,
      tenantPartyId: TENANT_PARTY,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
    expect(second.code).toBe("RESERVATION_ALREADY_CONVERTED");
    expect(second.existingTenancyId).toBe(first.data.id);

    const count = await getDb().tenancy.count({ where: { reservationId: RES_ALREADY } });
    expect(count).toBe(1);
  });

  it("400s an invalid tenant with no tenant role, by role not partyType", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_INVALID_TENANT,
      tenantPartyId: INVALID_TENANT_PARTY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.code).toBe("TENANT_PARTY_INVALID");

    const count = await getDb().tenancy.count({ where: { reservationId: RES_INVALID_TENANT } });
    expect(count).toBe(0);
  });

  it("409s when the unit has no owner", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_NO_OWNER,
      tenantPartyId: TENANT_PARTY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("UNIT_HAS_NO_OWNER");

    const count = await getDb().tenancy.count({ where: { reservationId: RES_NO_OWNER } });
    expect(count).toBe(0);
  });

  it("409s with incumbent details when the unit already has an active tenancy and overwrite is not requested", async () => {
    const first = await convertReservationToTenancy(SESSION, {
      reservationId: RES_HAPPY,
      tenantPartyId: TENANT_PARTY,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await convertReservationToTenancy(SESSION, {
      reservationId: RES_ACTIVE_CONFLICT,
      tenantPartyId: TENANT_PARTY,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
    expect(second.code).toBe("UNIT_HAS_ACTIVE_TENANCY");

    // No new row, and the incumbent tenancy is untouched.
    const count = await getDb().tenancy.count({ where: { reservationId: RES_ACTIVE_CONFLICT } });
    expect(count).toBe(0);
    const incumbent = await getDb().tenancy.findUniqueOrThrow({ where: { id: first.data.id } });
    expect(incumbent.status).toBe("active");
  });

  it("creates an open-ended tenancy (endDate null) when proposedMoveOut is null", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_OPEN_ENDED,
      tenantPartyId: TENANT_PARTY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tenancy = await getDb().tenancy.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(tenancy.endDate).toBeNull();
  });

  it("404s for an unknown reservation id", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: "00000000-0000-0000-0000-000000000000",
      tenantPartyId: TENANT_PARTY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.code).toBe("RESERVATION_NOT_FOUND");
  });

  it("404s for a reservation belonging to a different organization (no cross-org leakage)", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_CROSS_ORG,
      tenantPartyId: TENANT_PARTY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.code).toBe("RESERVATION_NOT_FOUND");
  });

  // ── T7: overlap warn + overwrite + carpark + P2002 discrimination ────────

  it("overlap warns: 409 UNIT_HAS_ACTIVE_TENANCY with incumbent details, no change, when overwrite is not requested", async () => {
    const { tenancyId: t1Id } = await seedIncumbentTenancyWithBay();

    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_OVERWRITE,
      tenantPartyId: TENANT_PARTY_B,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("UNIT_HAS_ACTIVE_TENANCY");
    expect(result.incumbent).toBeDefined();
    expect(result.incumbent?.tenantName).toBe("Valid Tenant");
    expect(result.incumbent?.endDate?.toISOString()).toBe(new Date("2026-11-30T00:00:00Z").toISOString());

    // No new row, and T1 is completely untouched.
    const db = getDb();
    const count = await db.tenancy.count({ where: { reservationId: RES_OVERWRITE } });
    expect(count).toBe(0);
    const t1 = await db.tenancy.findUniqueOrThrow({ where: { id: t1Id } });
    expect(t1.status).toBe("active");
    expect(t1.endDate?.toISOString()).toBe(new Date("2026-11-30T00:00:00Z").toISOString());
  });

  it("overwrite supersedes: closes T1, reassigns its bay to T2, links previousTenancyId, leaves T1's Charge untouched", async () => {
    const { tenancyId: t1Id, carparkId, carparkAssignmentId, chargeId } = await seedIncumbentTenancyWithBay();
    const db = getDb();
    const chargeBefore = await db.charge.findUniqueOrThrow({ where: { id: chargeId } });

    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_OVERWRITE,
      tenantPartyId: TENANT_PARTY_B,
      overwrite: true,
      carparks: [{ carparkId }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    expect(result.data.supersededTenancyId).toBe(t1Id);
    const t2Id = result.data.id;

    // T1: ended, endDate pinned to T2's start (RES_OVERWRITE.proposedMoveIn).
    const t1 = await db.tenancy.findUniqueOrThrow({ where: { id: t1Id } });
    expect(t1.status).toBe("ended");
    expect(t1.endDate?.toISOString()).toBe(new Date("2026-12-01T00:00:00Z").toISOString());

    // T2: active, chained to T1, correct tenant/unit.
    const t2 = await db.tenancy.findUniqueOrThrow({ where: { id: t2Id } });
    expect(t2.status).toBe("active");
    expect(t2.previousTenancyId).toBe(t1Id);
    expect(t2.tenantPartyId).toBe(TENANT_PARTY_B);
    expect(t2.unitId).toBe(UNIT);

    // Bay: T1's old assignment released (ended), a NEW active assignment
    // exists for T2 on the same bay, and the bay itself is "rented" again.
    const oldAssignment = await db.carparkAssignment.findUniqueOrThrow({ where: { id: carparkAssignmentId } });
    expect(oldAssignment.status).toBe("ended");
    const newAssignment = await db.carparkAssignment.findFirst({
      where: { organizationId: ORG, carparkId, tenancyId: t2Id, status: "active" },
    });
    expect(newAssignment).not.toBeNull();
    const bay = await db.carpark.findUniqueOrThrow({ where: { id: carparkId } });
    expect(bay.status).toBe("rented");

    // Money-safety: T1's Charge row is byte-for-byte unchanged.
    const chargeAfter = await db.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(chargeAfter).toEqual(chargeBefore);
  });

  it("overwrite rolls back atomically when the carpark assignment fails (prior tenancy stays active)", async () => {
    const { tenancyId: t1Id, carparkAssignmentId } = await seedIncumbentTenancyWithBay();
    const db = getDb();
    // A bay in the SAME building that's already rented to someone else --
    // assignCarparksTx's availability guard rejects it (409), which must roll
    // back the incumbent close-out too (never a partial supersession).
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

    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_OVERWRITE_CARPARK_FAIL,
      tenantPartyId: TENANT_PARTY_B,
      overwrite: true,
      carparks: [{ carparkId: CARPARK_TAKEN }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("CARPARK_ASSIGN_FAILED");

    // Atomic rollback: T1 is still active/untouched, no T2 row was created,
    // and T1's ORIGINAL bay assignment is still active (never released).
    const t1 = await db.tenancy.findUniqueOrThrow({ where: { id: t1Id } });
    expect(t1.status).toBe("active");
    const t2Count = await db.tenancy.count({ where: { reservationId: RES_OVERWRITE_CARPARK_FAIL } });
    expect(t2Count).toBe(0);
    const originalAssignment = await db.carparkAssignment.findUniqueOrThrow({ where: { id: carparkAssignmentId } });
    expect(originalAssignment.status).toBe("active");
  });

  it("tenancy code collision distinct: REAL duplicate tenancyCode maps to 409 TENANCY_CODE_TAKEN, not CONCURRENT_ACTIVE_TENANCY", async () => {
    const first = await convertReservationToTenancy(SESSION, {
      reservationId: RES_HAPPY,
      tenantPartyId: TENANT_PARTY,
      tenancyCode: "TEN-T7-DUPTEST",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // RES_TENANCY_CODE_DUP is on a DIFFERENT, owned+free unit (UNIT_2), so
    // this reaches the real tx.tenancy.create -- the (organizationId,
    // tenancyCode) unique constraint is what actually fires, a genuine
    // Postgres P2002 via the pg driver adapter (not a stub).
    const second = await convertReservationToTenancy(SESSION, {
      reservationId: RES_TENANCY_CODE_DUP,
      tenantPartyId: TENANT_PARTY_B,
      tenancyCode: "TEN-T7-DUPTEST",
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
    expect(second.code).toBe("TENANCY_CODE_TAKEN");

    const count = await getDb().tenancy.count({ where: { reservationId: RES_TENANCY_CODE_DUP } });
    expect(count).toBe(0);
  });

  // ── T7 review Finding 1: overwrite endDate clamp ──────────────────────────

  it("overwrite clamps incumbent endDate to its own start when move-in is backdated -- a tenancy can never end before it began", async () => {
    const { tenancyId: t1Id } = await seedBackdatedIncumbentTenancy();

    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_OVERWRITE_BACKDATED,
      tenantPartyId: TENANT_PARTY_B,
      overwrite: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDb();
    const t1 = await db.tenancy.findUniqueOrThrow({ where: { id: t1Id } });
    expect(t1.status).toBe("ended");
    // Clamped to T1's OWN start (2026-06-01), NOT the backdated
    // proposedMoveIn (2026-01-01).
    expect(t1.endDate?.toISOString()).toBe(new Date("2026-06-01T00:00:00Z").toISOString());
    expect(t1.endDate!.getTime()).toBeGreaterThanOrEqual(t1.startDate.getTime());

    // T2 itself is unaffected by the clamp -- its own dates still derive
    // straight from the reservation.
    const t2 = await db.tenancy.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(t2.startDate.toISOString()).toBe(new Date("2026-01-01T00:00:00Z").toISOString());
  });

  // ── T14: reservation-tenant-match guard (defense-in-depth) ────────────────

  it("422s RESERVATION_TENANT_MISMATCH when the reservation is linked to a DIFFERENT tenant than the one being assigned, and creates NO tenancy row (fails closed)", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_TENANT_LINKED, // linked to TENANT_PARTY
      tenantPartyId: TENANT_PARTY_B, // a different, valid tenant-role party
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.code).toBe("RESERVATION_TENANT_MISMATCH");

    const count = await getDb().tenancy.count({ where: { reservationId: RES_TENANT_LINKED } });
    expect(count).toBe(0);
  });

  it("201s when the reservation's linked tenant MATCHES the tenant being assigned (the normal created-from-then-assign flow)", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_TENANT_LINKED,
      tenantPartyId: TENANT_PARTY, // matches the reservation's linked tenant
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    const tenancy = await getDb().tenancy.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(tenancy.tenantPartyId).toBe(TENANT_PARTY);
    expect(tenancy.reservationId).toBe(RES_TENANT_LINKED);
  });

  it("201s backward-compat: a reservation with NO tenant link (tenantPartyId null) allows convert with ANY valid tenant-role party", async () => {
    const result = await convertReservationToTenancy(SESSION, {
      reservationId: RES_HAPPY, // seeded with tenantPartyId omitted (null) -- never created-from
      tenantPartyId: TENANT_PARTY_B,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    const tenancy = await getDb().tenancy.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(tenancy.tenantPartyId).toBe(TENANT_PARTY_B);
  });
});
