/**
 * Task T12 — LOCAL reconciliation test for the "Jacky" incident
 * (docs/superpowers/specs/2026-07-07-tenancy-onboarding-reservation-optional-design.md).
 *
 * The original incident: tenant "Jacky" (Unit A-11-22) had an active tenancy
 * with `reservationId = NULL`, a hand-typed mid-month start, and a rent
 * charge that was wrong because `computeProratedRent` ignored the move-out
 * date. That per-function bug is already fixed + unit-tested (see
 * `post-monthly-rent.test.ts` — "same-month move-out prorates start->end
 * inclusive (2800 x 20/31)" = 1806.45 vs the old "2348.39" month-end-only
 * shortcut). What is NOT covered anywhere else is the END-TO-END path that
 * actually produced Jacky's row shape: a tenant assigned with NO reservation
 * via the real service entrypoint (`createTenancyService`'s manual path, not
 * a hand-rolled `db.tenancy.create`), whose first month's rent is then
 * resolved + posted by the real billing entrypoint
 * (`postMonthlyRentForTenancy`). This file closes that gap by chaining the
 * two real services together, gated on RUN_INTEGRATION against local
 * Postgres only.
 *
 * `tenancy.service.overwrite.integration.test.ts`'s "manual create no gate"
 * test already proves `createTenancyService` accepts no `reservationId` and
 * writes `reservationId: null` — but it seeds startDate on the 1st of the
 * month and never bills. `post-monthly-rent.test.ts`'s "same-month move-out
 * prorates start->end inclusive (2800 x 20/31 = 1806.45)" already proves the
 * pure `computeProratedRent` returns the move-out-aware figure — but it seeds
 * the Tenancy row directly (bypassing `createTenancyService`) and calls the
 * pure function, not the posting service. Neither test chains reservation-less
 * onboarding through the real billing entrypoint. This test is a
 * characterization pin (RE: evidence rules) — it did not fail before being
 * written; both halves were already individually correct. It proves the
 * reconciled promise ("a tenant can be onboarded + billed with NO reservation,
 * and Jacky's same-month move-out is billed the move-out-aware RM1806.45 — the
 * plan/runbook's correct value — not the pre-fix month-end RM2348.39 bug")
 * end-to-end through the real services, as the constraint-respecting
 * substitute for the staging reproduction in the incident report.
 *
 * Run explicitly:
 *   cd apps/api && RUN_INTEGRATION=1 \
 *     DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *     npx vitest run reservation-less-onboarding-billing
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { createTenancyService } from "../../tenancy/tenancy.service";
import { computeProratedRent, postMonthlyRentForTenancy } from "../post-monthly-rent";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  // Real Tenancy + Charge rows written here (money-critical write path) --
  // refuse to run against anything but the local dev DB, even by accident.
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`reservation-less-onboarding-billing.integration.test.ts: refusing non-local DB host "${host}"`);
  }
}

const ORG = "99990012-0012-4012-8012-000000000001";
const ADMIN_USER = "99990012-0012-4012-8012-000000000002";
const OWNER_PARTY = "99990012-0012-4012-8012-000000000003";
const PROPERTY = "99990012-0012-4012-8012-000000000004";
const APARTMENT = "99990012-0012-4012-8012-000000000005";
const UNIT = "99990012-0012-4012-8012-000000000006";
const TENANT_PARTY = "99990012-0012-4012-8012-000000000007";
const TENANT_ROLE = "99990012-0012-4012-8012-000000000008";

const SESSION = { orgId: ORG, userId: ADMIN_USER, role: "admin" };

async function cleanup() {
  const db = getDb();
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.partyRole.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

// Seeds org + owner + property + apartment + unit(listing, owned, vacant) +
// a tenant party WITH a "tenant" partyRole (required by createTenancyService's
// findTenantRole guard) -- but deliberately NO UnitReservation row anywhere.
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "T12 Reservation-less Org", slug: "t12-reservationless-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: OWNER_PARTY, organizationId: ORG, displayName: "T12 Owner", partyType: "agent", status: "active" },
  });
  await db.party.create({
    data: { id: TENANT_PARTY, organizationId: ORG, displayName: "T12 Tenant (no reservation)", partyType: "individual", status: "active" },
  });
  await db.partyRole.create({
    data: { id: TENANT_ROLE, organizationId: ORG, partyId: TENANT_PARTY, roleType: "tenant", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY, organizationId: ORG, name: "T12 Property", propertyCode: "T12-P1", propertyType: "residential",
      addressLine1: "1 T12 St", city: "Kuala Lumpur", country: "MY", status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "T12-A1", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT, organizationId: ORG, apartmentId: APARTMENT, listingType: "apartment",
      occupancyStatus: "vacant", listingStatus: "active", readyNow: true, currency: "MYR", ownerPartyId: OWNER_PARTY,
    },
  });
}

dn("reservation-less onboarding -> billing reconciliation (T12, integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  it("a tenant with NO reservation can be assigned via createTenancyService's manual path AND billed a full-month rent charge", async () => {
    // Move-in on the 1st -- no proration expected, isolates the "reservation
    // is optional but the tenant is still onboardable + billable" assertion
    // from the day-count math (covered separately below).
    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY,
      tenancyCode: "TEN-T12-FULL",
      startDate: "2026-01-01",
      monthlyRentAmount: "2800",
      // reservationId deliberately omitted -- the reservation-OPTIONAL guarantee.
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    const db = getDb();
    const tenancy = await db.tenancy.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(tenancy.reservationId).toBeNull();
    expect(Number(tenancy.monthlyRentAmount)).toBe(2800);

    const january = new Date(Date.UTC(2026, 0, 1));
    const post = await db.$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, tenancy.id, january, ADMIN_USER));
    expect(post.created).toBe(true);

    const charge = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, tenancyId: tenancy.id, chargeType: "rent" } });
    expect(charge.status).toBe("posted");
    expect(Number(charge.amount)).toBe(2800); // full month, no proration for a 1st-of-month start
  });

  it("THE INCIDENT: Jacky's same-month move-out (Jul-6 -> Jul-25), reservation-less, bills RM1806.45 (move-out-aware) NOT RM2348.39 (the pre-fix month-end bug)", async () => {
    // Jacky's actual dates: move IN 2026-07-06 AND move OUT 2026-07-25, both
    // inside July -- the exact incident. The bug was that the old
    // computeProratedRent ignored the move-out date and prorated a mid-month
    // START to month-end (26/31 = RM2348.39), over-billing a ~20-day stay.
    // The fix clamps to the occupancy window [start, end] inclusive
    // (20/31 = RM1806.45). This drives the FULL reservation-less chain --
    // createTenancyService (manual, NO reservationId) -> postMonthlyRentForTenancy
    // -- so the incident is proven fixed end-to-end with no reservation in the loop.
    const result = await createTenancyService(SESSION, {
      propertyId: PROPERTY,
      unitId: UNIT,
      tenantPartyId: TENANT_PARTY,
      tenancyCode: "TEN-T12-MOVEOUT",
      startDate: "2026-07-06",
      endDate: "2026-07-25", // same-month move-out -- the load-bearing part of the incident
      monthlyRentAmount: "2800",
      // reservationId deliberately omitted -- the reservation-OPTIONAL guarantee.
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDb();
    const tenancy = await db.tenancy.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(tenancy.reservationId).toBeNull();

    const july = new Date(Date.UTC(2026, 6, 1));
    const post = await db.$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, tenancy.id, july, ADMIN_USER));
    expect(post.created).toBe(true);

    const charge = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, tenancyId: tenancy.id, chargeType: "rent" } });
    const billed = Number(charge.amount);

    // Never bill the full month for a mid-month move-in.
    expect(billed).toBeLessThan(2800);
    // Matches the billing service's OWN day-count formula exactly (no drift
    // between what's billed and what the pure function computes) -- the
    // occupancy window is clamped to [Jul-6, Jul-25] inclusive => 20/31.
    expect(billed).toBe(computeProratedRent(2800, tenancy.startDate, tenancy.endDate, july));
    // THE incident figure: move-out-aware RM1806.45 (2800 x 20/31), the value
    // the plan + runbook call correct -- NOT RM2348.39 (2800 x 26/31), which is
    // the pre-fix bug that ignored the move-out date. (The pure-function test
    // post-monthly-rent.test.ts:28-35 pins both figures directly.)
    expect(billed).toBe(1806.45);
  });
});
