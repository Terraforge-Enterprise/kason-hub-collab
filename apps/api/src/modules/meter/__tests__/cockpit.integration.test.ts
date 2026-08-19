/**
 * Integration test for the Month cockpit aggregation (spec §4.1/§4.6).
 *
 * Read-only portfolio-wide per-period summary: readings X/Y · bills drafted X/Y
 * · charged X/Y, plus the occupancy⋈billing reconciliation worklist. Hits a
 * real Postgres so the count semantics (occupied/vacant, void exclusion,
 * carpark exclusion, per-apartment bill status) are proven against the DB, not
 * mocked.
 *
 * Skipped by default. Run explicitly (LOCAL DB ONLY):
 *   cd apps/api && RUN_INTEGRATION=1 \
 *     DATABASE_URL='postgresql://yonghongtan@localhost:5432/kason_hub_test?schema=public' \
 *     npx vitest run src/modules/meter/__tests__/cockpit.integration.test.ts
 *
 * Fixture (one Property, two Apartments) exercises every metric at once:
 *   APT1 — ROOM1 occupied + valid reading; ROOM2 occupied + VOID reading
 *          (→ unread). A DRAFT UnitUtilityBill for the period.
 *   APT2 — ROOM3 occupied + valid reading; ROOM4 vacant + valid reading
 *          (→ anomaly); ROOM5 vacant + no reading.
 *          A CHARGED UnitUtilityBill for the period.
 *
 * Expected (period 2026-06-01):
 *   readings = { done: 2, total: 3 }   (occupied rooms: 1,2,3; valid reads: 1,3)
 *   bills    = { drafted: 2, total: 2 } (billable apts: APT1, APT2; both have a bill)
 *   charged  = { done: 1, total: 2 }   (only APT2's bill is charged)
 *   worklist.occupiedUnreadCount    = 1  (ROOM2)
 *   worklist.vacantWithReadingCount = 1  (ROOM4)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";
import { getCockpitService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Fixed UUIDs unique to this suite (cf namespace).
const ORG = "cf300000-0000-4000-8000-000000000001";
const OTHER_ORG = "cf300000-0000-4000-8000-0000000000ff"; // leak canary
const USER = "cf300000-0000-4000-8000-000000000002";
const PROP = "cf300000-0000-4000-8000-000000000003";
const APT1 = "cf300000-0000-4000-8000-000000000011";
const APT2 = "cf300000-0000-4000-8000-000000000012";
const ROOM1 = "cf300000-0000-4000-8000-000000000021"; // APT1, occupied, valid reading
const ROOM2 = "cf300000-0000-4000-8000-000000000022"; // APT1, occupied, VOID reading
const ROOM3 = "cf300000-0000-4000-8000-000000000024"; // APT2, occupied, valid reading
const ROOM4 = "cf300000-0000-4000-8000-000000000025"; // APT2, vacant, valid reading (anomaly)
const ROOM5 = "cf300000-0000-4000-8000-000000000026"; // APT2, vacant, no reading
const PARTY1 = "cf300000-0000-4000-8000-000000000031";
const PARTY2 = "cf300000-0000-4000-8000-000000000032";
const PARTY3 = "cf300000-0000-4000-8000-000000000034";

const PERIOD = new Date("2026-06-01T00:00:00.000Z");

const session: SessionPayload = { userId: USER, orgId: ORG, role: "manager" };
const db = () => getDb();

async function cleanup() {
  const orgs = { organizationId: { in: [ORG, OTHER_ORG] } };
  await db().utilityAllocation.deleteMany({ where: orgs });
  await db().chargeEvent.deleteMany({ where: orgs });
  await db().charge.deleteMany({ where: orgs });
  await db().meterReading.deleteMany({ where: orgs });
  await db().aircondMeter.deleteMany({ where: orgs });
  await db().unitUtilityBill.deleteMany({ where: orgs });
  await db().tenancy.deleteMany({ where: orgs });
  await db().listing.deleteMany({ where: orgs });
  await db().apartment.deleteMany({ where: orgs });
  await db().property.deleteMany({ where: orgs });
  await db().auditLog.deleteMany({ where: orgs });
  await db().user.deleteMany({ where: orgs });
  await db().party.deleteMany({ where: orgs });
  await db().organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
}

async function seed() {
  const orgBase = { status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" };
  await db().organization.create({ data: { id: ORG, name: "Cockpit Org", slug: "cockpit", ...orgBase } });
  await db().organization.create({ data: { id: OTHER_ORG, name: "Cockpit Other", slug: "cockpit-other", ...orgBase } });
  await db().user.create({ data: { id: USER, organizationId: ORG, email: "cockpit@example.test", fullName: "Cockpit Op", status: "active", role: "manager" } });
  await db().property.create({ data: { id: PROP, organizationId: ORG, name: "Cockpit Property", propertyCode: "CKP", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db().apartment.create({ data: { id: APT1, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "PARTITIONED" } });
  await db().apartment.create({ data: { id: APT2, organizationId: ORG, propertyId: PROP, unitCode: "A-2", listingMode: "PARTITIONED" } });

  const lb = { organizationId: ORG, listingStatus: "active", currency: "MYR" };
  await db().listing.create({ data: { id: ROOM1, apartmentId: APT1, listingType: "Master", occupancyStatus: "occupied", ...lb } });
  await db().listing.create({ data: { id: ROOM2, apartmentId: APT1, listingType: "Medium", occupancyStatus: "occupied", ...lb } });
  await db().listing.create({ data: { id: ROOM3, apartmentId: APT2, listingType: "Master", occupancyStatus: "occupied", ...lb } });
  await db().listing.create({ data: { id: ROOM4, apartmentId: APT2, listingType: "Medium", occupancyStatus: "vacant", ...lb } });
  await db().listing.create({ data: { id: ROOM5, apartmentId: APT2, listingType: "Single", occupancyStatus: "vacant", ...lb } });

  const pb = { organizationId: ORG, partyType: "individual", status: "active" };
  await db().party.create({ data: { id: PARTY1, displayName: "Tenant One", ...pb } });
  await db().party.create({ data: { id: PARTY2, displayName: "Tenant Two", ...pb } });
  await db().party.create({ data: { id: PARTY3, displayName: "Tenant Three", ...pb } });

  const tb = { organizationId: ORG, propertyId: PROP, status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 };
  // Occupied rooms = an ACTIVE tenancy on the room.
  await db().tenancy.create({ data: { id: "cf300000-0000-4000-8000-000000000041", unitId: ROOM1, tenantPartyId: PARTY1, tenancyCode: "T-1", ...tb } });
  await db().tenancy.create({ data: { id: "cf300000-0000-4000-8000-000000000042", unitId: ROOM2, tenantPartyId: PARTY2, tenancyCode: "T-2", ...tb } });
  await db().tenancy.create({ data: { id: "cf300000-0000-4000-8000-000000000044", unitId: ROOM3, tenantPartyId: PARTY3, tenancyCode: "T-3", ...tb } });
  // ROOM4 + ROOM5 stay vacant (no active tenancy).

  // Meters + readings. A reading needs a meterId (FK). status: submitted | void.
  const mk = async (id: string, unitId: string) => db().aircondMeter.create({ data: { id, organizationId: ORG, unitId, ratePerKwh: "0.6000", isActive: true } });
  const M1 = "cf300000-0000-4000-8000-000000000051";
  const M2 = "cf300000-0000-4000-8000-000000000052";
  const M3 = "cf300000-0000-4000-8000-000000000054";
  const M4 = "cf300000-0000-4000-8000-000000000055";
  await mk(M1, ROOM1);
  await mk(M2, ROOM2);
  await mk(M3, ROOM3);
  await mk(M4, ROOM4);

  const rb = { organizationId: ORG, periodMonth: PERIOD, previousReading: "0.00", ratePerKwh: "0.6000", submittedBy: USER };
  // ROOM1: valid (submitted) reading → counts as read.
  await db().meterReading.create({ data: { id: "cf300000-0000-4000-8000-000000000061", meterId: M1, unitId: ROOM1, currentReading: "10.00", consumption: "10.00", computedAmount: "6.00", status: "submitted", ...rb } });
  // ROOM2: VOID reading → does NOT count as read; room stays unread.
  await db().meterReading.create({ data: { id: "cf300000-0000-4000-8000-000000000062", meterId: M2, unitId: ROOM2, currentReading: "20.00", consumption: "20.00", computedAmount: "12.00", status: "void", ...rb } });
  // ROOM3: valid (charged) reading → counts as read (non-void).
  await db().meterReading.create({ data: { id: "cf300000-0000-4000-8000-000000000064", meterId: M3, unitId: ROOM3, currentReading: "30.00", consumption: "30.00", computedAmount: "18.00", status: "charged", ...rb } });
  // ROOM4 (VACANT): valid reading → anomaly (vacantWithReading).
  await db().meterReading.create({ data: { id: "cf300000-0000-4000-8000-000000000065", meterId: M4, unitId: ROOM4, currentReading: "40.00", consumption: "40.00", computedAmount: "24.00", status: "submitted", ...rb } });

  // Bills: APT1 draft, APT2 charged (one per apartment for the period).
  const bb = { organizationId: ORG, periodMonth: PERIOD, billingMode: "no_subsidy", tnbTotal: "0.00", createdBy: USER };
  await db().unitUtilityBill.create({ data: { id: "cf300000-0000-4000-8000-000000000071", apartmentId: APT1, status: "draft", ...bb } });
  await db().unitUtilityBill.create({ data: { id: "cf300000-0000-4000-8000-000000000072", apartmentId: APT2, status: "charged", ...bb } });

  // ── Leak canary: a fully-populated OTHER_ORG that must never bleed in ──
  await db().property.create({ data: { id: "cf300000-0000-4000-8000-0000000000a1", organizationId: OTHER_ORG, name: "Other Prop", propertyCode: "OTH", propertyType: "residential", addressLine1: "9", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db().apartment.create({ data: { id: "cf300000-0000-4000-8000-0000000000a2", organizationId: OTHER_ORG, propertyId: "cf300000-0000-4000-8000-0000000000a1", unitCode: "O-1", listingMode: "PARTITIONED" } });
  await db().listing.create({ data: { id: "cf300000-0000-4000-8000-0000000000a3", organizationId: OTHER_ORG, apartmentId: "cf300000-0000-4000-8000-0000000000a2", listingType: "Master", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });
  await db().party.create({ data: { id: "cf300000-0000-4000-8000-0000000000a4", organizationId: OTHER_ORG, displayName: "Other Tenant", partyType: "individual", status: "active" } });
  await db().tenancy.create({ data: { id: "cf300000-0000-4000-8000-0000000000a5", organizationId: OTHER_ORG, propertyId: "cf300000-0000-4000-8000-0000000000a1", unitId: "cf300000-0000-4000-8000-0000000000a3", tenantPartyId: "cf300000-0000-4000-8000-0000000000a4", tenancyCode: "OT-1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db().unitUtilityBill.create({ data: { id: "cf300000-0000-4000-8000-0000000000a6", organizationId: OTHER_ORG, apartmentId: "cf300000-0000-4000-8000-0000000000a2", periodMonth: PERIOD, billingMode: "no_subsidy", tnbTotal: "0.00", status: "charged", createdBy: "cf300000-0000-4000-8000-0000000000a4" } });
}

dn("meter cockpit aggregation (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("aggregates readings/bills/charged + the reconciliation worklist for the period", async () => {
    const res = await getCockpitService(session, "2026-06-01");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const data = res.data;

    expect(data.period).toBe("2026-06-01");
    expect(data.readings).toEqual({ done: 2, total: 3 });
    expect(data.bills).toEqual({ drafted: 2, total: 2 });
    expect(data.charged).toEqual({ done: 1, total: 2 });

    // ROOM2 is the only occupied unread room (its reading is void).
    expect(data.worklist.occupiedUnreadCount).toBe(1);
    expect(data.worklist.occupiedUnread).toEqual([
      { unitId: ROOM2, unitCode: "A-1", apartmentId: APT1 },
    ]);

    // ROOM4 is the only vacant room carrying a (non-void) reading.
    expect(data.worklist.vacantWithReadingCount).toBe(1);
    expect(data.worklist.vacantWithReading).toEqual([
      { unitId: ROOM4, unitCode: "A-2" },
    ]);
  });

  it("defaults to the current month (UTC first-of-month) when no period is supplied", async () => {
    // No period ⇒ the service resolves "now" to its UTC first-of-month. We don't
    // hard-code the month (it depends on the wall clock); instead we assert the
    // shape of the default and that an explicit query for THAT month matches —
    // which proves the default-resolution rule without a date-dependent fixture.
    const res = await getCockpitService(session);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const now = new Date();
    const expectedDefault = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    expect(res.data.period).toBe(expectedDefault);

    // Occupancy-based denominators are period-independent, so they hold in any month.
    expect(res.data.readings.total).toBe(3);
    expect(res.data.bills.total).toBe(2);
    expect(res.data.charged.total).toBe(2);

    // The default must equal an EXPLICIT query for the same resolved month.
    const explicit = await getCockpitService(session, expectedDefault);
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) throw new Error("expected ok");
    expect(res.data).toEqual(explicit.data);
  });

  it("is org-scoped — the OTHER_ORG fixture never bleeds into the counts", async () => {
    const res = await getCockpitService(session, "2026-06-01");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // OTHER_ORG has 1 occupied room + 1 charged bill; if it leaked, totals would
    // jump. The §1 assertions above already pin the exact numbers — this is the
    // explicit cross-org guard.
    expect(res.data.readings.total).toBe(3);
    expect(res.data.bills.total).toBe(2);
    expect(res.data.charged.done).toBe(1);
  });
});
