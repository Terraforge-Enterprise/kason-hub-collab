/**
 * Integration tests for findCurrentPeriodElectricity.
 * Hits a real Postgres (local kason_hub_dev).
 *
 * Run explicitly (LOCAL DB ONLY — never remote/supabase):
 *   RUN_INTEGRATION=1 npx vitest run src/modules/tenant-tracker/__tests__/electricity.test.ts
 *
 * Seeds a fresh org + 4 listings each with a different meter reading state
 * and removes exactly those rows in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";
import { findCurrentPeriodElectricity } from "../repository";
import { listTrackerService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// ─── Fixed fixture ids (unique to this suite, cc-prefix) ───────────────────
const ORG_E = "cc200000-0000-4000-8000-000000000001";
const PROP_E = "cc200000-0000-4000-8000-000000000010";
const APT_E = "cc200000-0000-4000-8000-000000000020";

// Four listing/unit ids: A=submitted, B=charged, C=void, D=no reading
const L_A = "cc200000-0000-4000-8000-000000000031";
const L_B = "cc200000-0000-4000-8000-000000000032";
const L_C = "cc200000-0000-4000-8000-000000000033";
const L_D = "cc200000-0000-4000-8000-000000000034";

// AircondMeter ids (one per listing, required by MeterReading FK)
const METER_A = "cc200000-0000-4000-8000-000000000041";
const METER_B = "cc200000-0000-4000-8000-000000000042";
const METER_C = "cc200000-0000-4000-8000-000000000043";

// MeterReading ids
const READ_A = "cc200000-0000-4000-8000-000000000051";
const READ_B = "cc200000-0000-4000-8000-000000000052";
const READ_C = "cc200000-0000-4000-8000-000000000053";

// A dummy user id for submittedBy (required non-nullable FK)
const USER_E = "cc200000-0000-4000-8000-000000000099";

const PERIOD = new Date("2026-06-01T00:00:00.000Z");

async function cleanup() {
  const db = getDb();
  await db.meterReading.deleteMany({
    where: { id: { in: [READ_A, READ_B, READ_C] } },
  });
  await db.aircondMeter.deleteMany({
    where: { id: { in: [METER_A, METER_B, METER_C] } },
  });
  await db.listing.deleteMany({
    where: { organizationId: ORG_E },
  });
  await db.apartment.deleteMany({
    where: { organizationId: ORG_E },
  });
  await db.property.deleteMany({
    where: { organizationId: ORG_E },
  });
  await db.user.deleteMany({
    where: { id: USER_E },
  });
  await db.organization.deleteMany({
    where: { id: ORG_E },
  });
}

async function seed() {
  const db = getDb();

  await db.organization.create({
    data: {
      id: ORG_E,
      name: "Electricity Test Org",
      slug: "elec-test",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });

  // User required for MeterReading.submittedBy FK
  await db.user.create({
    data: {
      id: USER_E,
      email: "elec-test-user@test.local",
      fullName: "Electricity Test User",
      organizationId: ORG_E,
      role: "manager",
      status: "active",
    },
  });

  await db.property.create({
    data: {
      id: PROP_E,
      organizationId: ORG_E,
      name: "Electricity Test Property",
      propertyCode: "ELEC-P",
      propertyType: "residential",
      addressLine1: "99 Elec St",
      city: "Kuala Lumpur",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });

  await db.apartment.create({
    data: {
      id: APT_E,
      organizationId: ORG_E,
      propertyId: PROP_E,
      unitCode: "E-1-1",
      listingMode: "PARTITIONED",
    },
  });

  const listingBase = {
    organizationId: ORG_E,
    apartmentId: APT_E,
    listingType: "Master",
    occupancyStatus: "occupied",
    listingStatus: "active",
    currency: "MYR",
  };
  await db.listing.create({ data: { id: L_A, ...listingBase, listingType: "Master" } });
  await db.listing.create({ data: { id: L_B, ...listingBase, listingType: "Studio" } });
  await db.listing.create({ data: { id: L_C, ...listingBase, listingType: "Room1" } });
  await db.listing.create({ data: { id: L_D, ...listingBase, listingType: "Room2" } });

  // Create AircondMeters (required FK for MeterReading)
  const meterBase = { organizationId: ORG_E };
  await db.aircondMeter.create({
    data: { id: METER_A, unitId: L_A, meterNumber: "MTR-E-A", ...meterBase },
  });
  await db.aircondMeter.create({
    data: { id: METER_B, unitId: L_B, meterNumber: "MTR-E-B", ...meterBase },
  });
  await db.aircondMeter.create({
    data: { id: METER_C, unitId: L_C, meterNumber: "MTR-E-C", ...meterBase },
  });

  // Reading A — submitted, 412 kWh, RM247.20
  await db.meterReading.create({
    data: {
      id: READ_A,
      organizationId: ORG_E,
      meterId: METER_A,
      unitId: L_A,
      periodMonth: PERIOD,
      previousReading: "0",
      currentReading: "412",
      consumption: "412",
      ratePerKwh: "0.6",
      computedAmount: "247.20",
      status: "submitted",
      submittedBy: USER_E,
    },
  });

  // Reading B — charged
  await db.meterReading.create({
    data: {
      id: READ_B,
      organizationId: ORG_E,
      meterId: METER_B,
      unitId: L_B,
      periodMonth: PERIOD,
      previousReading: "100",
      currentReading: "250",
      consumption: "150",
      ratePerKwh: "0.6",
      computedAmount: "90.00",
      status: "charged",
      submittedBy: USER_E,
    },
  });

  // Reading C — void (must be excluded)
  await db.meterReading.create({
    data: {
      id: READ_C,
      organizationId: ORG_E,
      meterId: METER_C,
      unitId: L_C,
      periodMonth: PERIOD,
      previousReading: "50",
      currentReading: "50",
      consumption: "0",
      ratePerKwh: "0.6",
      computedAmount: "0.00",
      status: "void",
      submittedBy: USER_E,
    },
  });
  // Unit D has no reading at all
}

dn("findCurrentPeriodElectricity (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("returns submitted + charged, excludes void, omits units with no reading", async () => {
    const map = await findCurrentPeriodElectricity(ORG_E, [L_A, L_B, L_C, L_D], PERIOD);

    expect(map.get(L_A)).toMatchObject({ status: "submitted", kwh: 412, amount: 247.2 });
    expect(map.get(L_A)?.readingId).toBe(READ_A);
    expect(map.get(L_B)?.status).toBe("charged");
    expect(map.has(L_C)).toBe(false); // void excluded
    expect(map.has(L_D)).toBe(false); // no reading
    expect(map.size).toBe(2);
  });

  it("returns empty Map for empty unitIds", async () => {
    const map = await findCurrentPeriodElectricity(ORG_E, [], PERIOD);
    expect(map.size).toBe(0);
  });

  it("is org-scoped — does not return readings from another org even with same unitId", async () => {
    // L_A belongs to ORG_E; querying with a fake orgId yields nothing
    const FAKE_ORG = "ff000000-0000-4000-8000-000000000001";
    const map = await findCurrentPeriodElectricity(FAKE_ORG, [L_A], PERIOD);
    expect(map.size).toBe(0);
  });

  it("does not return readings from a different periodMonth", async () => {
    const DIFFERENT_PERIOD = new Date("2026-05-01T00:00:00.000Z");
    const map = await findCurrentPeriodElectricity(ORG_E, [L_A, L_B], DIFFERENT_PERIOD);
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Service-level: listTrackerService electricity integration
// ---------------------------------------------------------------------------

const session: SessionPayload = { userId: USER_E, orgId: ORG_E, role: "manager" };

dn("listTrackerService electricity (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("attaches electricity per room when ENABLE_PHASE2_METER is on", async () => {
    const prev = process.env.ENABLE_PHASE2_METER;
    process.env.ENABLE_PHASE2_METER = "1";
    try {
      const res = await listTrackerService(session, { status: "all", limit: 25, period: "2026-06" } as any);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(`expected ok, got: ${res.error}`);
      const room = res.data.groups[0]?.rooms.find((r) => r.unit.id === L_A);
      expect(room).toBeDefined();
      expect(room?.electricity).toMatchObject({ status: "submitted", amount: 247.2 });
    } finally {
      if (prev === undefined) delete process.env.ENABLE_PHASE2_METER;
      else process.env.ENABLE_PHASE2_METER = prev;
    }
  });

  it("electricity is null when ENABLE_PHASE2_METER is off", async () => {
    const prev = process.env.ENABLE_PHASE2_METER;
    delete process.env.ENABLE_PHASE2_METER;
    try {
      const res = await listTrackerService(session, { status: "all", limit: 25 } as any);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(`expected ok, got: ${res.error}`);
      const room = res.data.groups[0]?.rooms[0];
      expect(room).toBeDefined();
      expect(room?.electricity).toBeNull();
    } finally {
      if (prev !== undefined) process.env.ENABLE_PHASE2_METER = prev;
    }
  });
});
