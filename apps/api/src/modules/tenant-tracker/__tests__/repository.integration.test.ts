/**
 * Integration tests for the tenant-tracker repository. Hits a real Postgres.
 *
 * Skipped by default. Run explicitly (LOCAL DB ONLY — never remote/supabase):
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://...localhost:5432/kason_hub_dev..." \
 *     npx vitest run src/modules/tenant-tracker/__tests__/repository.integration.test.ts
 *
 * Seeds TWO orgs (org B is the leak canary) with fixed UUIDs and removes
 * exactly those rows in afterAll — never touches rows it didn't create.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "@kason/db";
import {
  findApartmentsForTracker,
  findListingForInCharge,
  findPartyInOrg,
  getTrackerSummary,
  listAgentLabels,
  lookupByPhone,
} from "../repository";
import type { TrackerFilters } from "../types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// ─── Fixed fixture ids (unique to this suite) ───────────────────────────────
const ORG_A = "aa100000-0000-4000-8000-000000000001";
const ORG_B = "bb100000-0000-4000-8000-000000000001";

const PROP_A = "aa100000-0000-4000-8000-000000000010";
const APT_A1 = "aa100000-0000-4000-8000-000000000021"; // 2 rooms + 1 carpark
const APT_A2 = "aa100000-0000-4000-8000-000000000022"; // vacant
const L_MASTER = "aa100000-0000-4000-8000-000000000031";
const L_STUDIO = "aa100000-0000-4000-8000-000000000032";
const L_CARPARK = "aa100000-0000-4000-8000-000000000033";
const L_VACANT = "aa100000-0000-4000-8000-000000000034";
const P_ALICE = "aa100000-0000-4000-8000-000000000041"; // 60123456789
const P_BOB = "aa100000-0000-4000-8000-000000000042"; // 60198765432
const T_PREV = "aa100000-0000-4000-8000-000000000051"; // ended    (Master, Alice)
const T_ACTIVE = "aa100000-0000-4000-8000-000000000052"; // active   (Master, Alice, renews T_PREV)
const T_TERM = "aa100000-0000-4000-8000-000000000053"; // terminated (Studio, Bob)
const T_CARPARK = "aa100000-0000-4000-8000-000000000054"; // active  (Carpark, Alice)

const PROP_B = "bb100000-0000-4000-8000-000000000010";
const APT_B = "bb100000-0000-4000-8000-000000000021";
const L_B = "bb100000-0000-4000-8000-000000000031";
const P_BELLA = "bb100000-0000-4000-8000-000000000041"; // 60177778888
const T_B = "bb100000-0000-4000-8000-000000000051";

const ALL: TrackerFilters = { status: "all" };
const ACTIVE: TrackerFilters = { status: "active" };
const ENDED: TrackerFilters = { status: "ended" };

async function cleanup() {
  const db = getDb();
  const orgs = { organizationId: { in: [ORG_A, ORG_B] } };
  await db.tenancy.deleteMany({ where: orgs });
  await db.listing.deleteMany({ where: orgs });
  await db.apartment.deleteMany({ where: orgs });
  await db.property.deleteMany({ where: orgs });
  await db.party.deleteMany({ where: orgs });
  await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
}

async function seed() {
  const db = getDb();
  const orgBase = {
    status: "active",
    defaultCurrency: "MYR",
    timezone: "Asia/Kuala_Lumpur",
    locale: "en-MY",
    subscriptionPlan: "free",
  };
  await db.organization.create({
    data: { id: ORG_A, name: "Tracker Test Org A", slug: "trk-test-a", ...orgBase },
  });
  await db.organization.create({
    data: { id: ORG_B, name: "Tracker Test Org B", slug: "trk-test-b", ...orgBase },
  });

  // ── Org A ──
  await db.property.create({
    data: {
      id: PROP_A, organizationId: ORG_A, name: "Tracker Test Property A",
      propertyCode: "TRK-P-A", propertyType: "residential", addressLine1: "1 Test St",
      city: "Kuala Lumpur", country: "MY", status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: {
      id: APT_A1, organizationId: ORG_A, propertyId: PROP_A,
      unitCode: "A-10-1", listingMode: "PARTITIONED", floor: 10, bedrooms: 3,
    },
  });
  await db.apartment.create({
    data: {
      id: APT_A2, organizationId: ORG_A, propertyId: PROP_A,
      unitCode: "A-10-2", listingMode: "WHOLE",
    },
  });
  const listingBase = { organizationId: ORG_A, listingStatus: "active", currency: "MYR" };
  await db.listing.create({
    data: {
      id: L_MASTER, apartmentId: APT_A1, listingType: "Master",
      occupancyStatus: "occupied", baseRentAmount: "1300.00", rentalRate: "1250.00",
      accessCardQuantity: 2, parkingNumbers: ["B2-12"], ...listingBase,
    },
  });
  await db.listing.create({
    data: {
      id: L_STUDIO, apartmentId: APT_A1, listingType: "Studio",
      occupancyStatus: "vacant", ...listingBase,
    },
  });
  await db.listing.create({
    data: {
      id: L_CARPARK, apartmentId: APT_A1, listingType: "Carpark",
      occupancyStatus: "occupied", ...listingBase,
    },
  });
  await db.listing.create({
    data: {
      id: L_VACANT, apartmentId: APT_A2, listingType: "Master",
      occupancyStatus: "vacant", ...listingBase,
    },
  });
  await db.party.create({
    data: {
      id: P_ALICE, organizationId: ORG_A, partyType: "tenant", displayName: "Alice Tan",
      status: "active", primaryPhone: "60123456789", primaryEmail: "alice@test.local",
      gender: "F", idType: "NRIC", idNumber: "990101-14-1234",
    },
  });
  await db.party.create({
    data: {
      id: P_BOB, organizationId: ORG_A, partyType: "tenant", displayName: "Bob Lim",
      status: "active", primaryPhone: "60198765432",
    },
  });
  const tenancyBase = { organizationId: ORG_A, propertyId: PROP_A, billingStatus: "active" };
  await db.tenancy.create({
    data: {
      id: T_PREV, unitId: L_MASTER, tenantPartyId: P_ALICE, tenancyCode: "TRK-A-001",
      status: "ended", startDate: new Date("2024-01-01"), endDate: new Date("2025-01-01"),
      monthlyRentAmount: "1100.00", termMonths: 12, ...tenancyBase,
    },
  });
  await db.tenancy.create({
    data: {
      id: T_ACTIVE, unitId: L_MASTER, tenantPartyId: P_ALICE, tenancyCode: "TRK-A-002",
      status: "active", startDate: new Date("2025-01-01"), endDate: new Date("2026-01-01"),
      monthlyRentAmount: "1200.50", termMonths: 12, previousTenancyId: T_PREV,
      agentLabel: "KENDRA", numberOfPax: 2, accessCardNo: "AC-7788", ...tenancyBase,
    },
  });
  await db.tenancy.create({
    data: {
      id: T_TERM, unitId: L_STUDIO, tenantPartyId: P_BOB, tenancyCode: "TRK-A-003",
      status: "terminated", startDate: new Date("2025-03-01"), endDate: new Date("2025-09-01"),
      monthlyRentAmount: "800.00", agentLabel: "Kendra", ...tenancyBase,
    },
  });
  await db.tenancy.create({
    data: {
      id: T_CARPARK, unitId: L_CARPARK, tenantPartyId: P_ALICE, tenancyCode: "TRK-A-004",
      status: "active", startDate: new Date("2025-01-01"),
      monthlyRentAmount: "100.00", ...tenancyBase,
    },
  });

  // ── Org B (leak canary) ──
  await db.property.create({
    data: {
      id: PROP_B, organizationId: ORG_B, name: "Tracker Test Property B",
      propertyCode: "TRK-P-B", propertyType: "residential", addressLine1: "2 Test St",
      city: "Kuala Lumpur", country: "MY", status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: {
      id: APT_B, organizationId: ORG_B, propertyId: PROP_B,
      unitCode: "B-1-1", listingMode: "WHOLE",
    },
  });
  await db.listing.create({
    data: {
      id: L_B, organizationId: ORG_B, apartmentId: APT_B, listingType: "Master",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR",
    },
  });
  await db.party.create({
    data: {
      id: P_BELLA, organizationId: ORG_B, partyType: "tenant", displayName: "Bella Org-B",
      status: "active", primaryPhone: "60177778888",
    },
  });
  await db.tenancy.create({
    data: {
      id: T_B, organizationId: ORG_B, propertyId: PROP_B, unitId: L_B,
      tenantPartyId: P_BELLA, tenancyCode: "TRK-B-001", status: "active",
      billingStatus: "active", startDate: new Date("2025-01-01"),
      monthlyRentAmount: "900.00", agentLabel: "ORGB-AGENT",
    },
  });
}

dn("tenant-tracker repository (integration)", () => {
  beforeAll(async () => {
    await cleanup(); // defensively clear residue from a crashed prior run
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("findApartmentsForTracker — org scoping", () => {
    it("returns ONLY org-A apartments for an org-A query", async () => {
      const { apartments } = await findApartmentsForTracker(ORG_A, ALL, null, 50);
      expect(apartments.map((a) => a.id).sort()).toEqual([APT_A1, APT_A2].sort());
    });

    it("org-B query never sees org-A rows", async () => {
      const { apartments } = await findApartmentsForTracker(ORG_B, ALL, null, 50);
      expect(apartments.map((a) => a.id)).toEqual([APT_B]);
    });
  });

  describe("status scoping of the included tenancies", () => {
    it('"active" excludes ended AND terminated', async () => {
      const { apartments } = await findApartmentsForTracker(ORG_A, ACTIVE, null, 50);
      const a1 = apartments.find((a) => a.id === APT_A1);
      expect(a1).toBeDefined();
      const master = a1?.listings.find((l) => l.id === L_MASTER);
      expect(master?.tenancies.map((t) => t.id)).toEqual([T_ACTIVE]);
      const studio = a1?.listings.find((l) => l.id === L_STUDIO);
      expect(studio?.tenancies).toEqual([]);
      const carpark = a1?.listings.find((l) => l.id === L_CARPARK);
      expect(carpark?.tenancies.map((t) => t.id)).toEqual([T_CARPARK]);
    });

    it('"ended" INCLUDES "terminated"', async () => {
      const { apartments } = await findApartmentsForTracker(ORG_A, ENDED, null, 50);
      const a1 = apartments.find((a) => a.id === APT_A1);
      const master = a1?.listings.find((l) => l.id === L_MASTER);
      expect(master?.tenancies.map((t) => t.id)).toEqual([T_PREV]);
      const studio = a1?.listings.find((l) => l.id === L_STUDIO);
      expect(studio?.tenancies.map((t) => t.id)).toEqual([T_TERM]);
    });

    it('"all" includes everything', async () => {
      const { apartments } = await findApartmentsForTracker(ORG_A, ALL, null, 50);
      const a1 = apartments.find((a) => a.id === APT_A1);
      const ids = a1?.listings.flatMap((l) => l.tenancies.map((t) => t.id)).sort();
      expect(ids).toEqual([T_PREV, T_ACTIVE, T_TERM, T_CARPARK].sort());
    });
  });

  describe("filters", () => {
    it("roomType filters on listingType", async () => {
      const { apartments } = await findApartmentsForTracker(
        ORG_A, { ...ALL, roomType: "Studio" }, null, 50,
      );
      expect(apartments.map((a) => a.id)).toEqual([APT_A1]);
    });

    it('agent="KENDRA" matches only apartments with a matching tenancy (vacant absent)', async () => {
      const { apartments } = await findApartmentsForTracker(
        ORG_A, { ...ALL, agent: "KENDRA" }, null, 50,
      );
      expect(apartments.map((a) => a.id)).toEqual([APT_A1]); // no vacant APT_A2
    });

    it('agent="Kendra" within active scope matches nothing (exact, case-sensitive)', async () => {
      const { apartments } = await findApartmentsForTracker(
        ORG_A, { ...ACTIVE, agent: "Kendra" }, null, 50,
      );
      expect(apartments).toEqual([]);
    });

    it('agent="Kendra" within ended scope finds the terminated tenancy\'s apartment', async () => {
      const { apartments } = await findApartmentsForTracker(
        ORG_A, { ...ENDED, agent: "Kendra" }, null, 50,
      );
      expect(apartments.map((a) => a.id)).toEqual([APT_A1]);
    });

    it("included tenancies are scoped by status only — NOT narrowed by agent", async () => {
      const { apartments } = await findApartmentsForTracker(
        ORG_A, { ...ALL, agent: "KENDRA" }, null, 50,
      );
      const a1 = apartments.find((a) => a.id === APT_A1);
      const ids = a1?.listings.flatMap((l) => l.tenancies.map((t) => t.id)).sort();
      // The whole unit's rooms/tenancies, not just the KENDRA one.
      expect(ids).toEqual([T_PREV, T_ACTIVE, T_TERM, T_CARPARK].sort());
    });

    it("q matches tenant displayName, case-insensitively", async () => {
      const hit = await findApartmentsForTracker(ORG_A, { ...ALL, q: "alice" }, null, 50);
      expect(hit.apartments.map((a) => a.id)).toEqual([APT_A1]);
      const upper = await findApartmentsForTracker(ORG_A, { ...ALL, q: "ALICE" }, null, 50);
      expect(upper.apartments.map((a) => a.id)).toEqual([APT_A1]);
      const miss = await findApartmentsForTracker(ORG_A, { ...ALL, q: "zzz-nobody" }, null, 50);
      expect(miss.apartments).toEqual([]);
    });

    it("phone last-4 suffix returns the right apartment; unrelated digits → empty, not throw", async () => {
      const hit = await findApartmentsForTracker(ORG_A, { ...ALL, phone: "6789" }, null, 50);
      expect(hit.apartments.map((a) => a.id)).toEqual([APT_A1]);
      const formatted = await findApartmentsForTracker(
        ORG_A, { ...ALL, phone: "012-345 6789" }, null, 50,
      );
      expect(formatted.apartments.map((a) => a.id)).toEqual([APT_A1]);
      const miss = await findApartmentsForTracker(ORG_A, { ...ALL, phone: "0000" }, null, 50);
      expect(miss.apartments).toEqual([]);
      const noDigits = await findApartmentsForTracker(ORG_A, { ...ALL, phone: "abc" }, null, 50);
      expect(noDigits.apartments).toEqual([]);
    });

    it("vacant apartment present without tenancy filters, absent with one", async () => {
      const all = await findApartmentsForTracker(ORG_A, ACTIVE, null, 50);
      expect(all.apartments.map((a) => a.id)).toContain(APT_A2);
      const filtered = await findApartmentsForTracker(
        ORG_A, { ...ACTIVE, agent: "KENDRA" }, null, 50,
      );
      expect(filtered.apartments.map((a) => a.id)).not.toContain(APT_A2);
    });
  });

  describe("row shape", () => {
    it("carpark Listings appear as plain rows in the tracker (Task 5.3b)", async () => {
      // After Task 5.3b, unitKind was removed from TRACKER_LISTING_SELECT.
      // Carpark data now comes from CarparkAssignment via findCarparkAssignmentsForApartments.
      // Any carpark-type Listing in the DB still appears in listings[] as a plain row.
      const { apartments } = await findApartmentsForTracker(ORG_A, ALL, null, 50);
      const a1 = apartments.find((a) => a.id === APT_A1);
      const carparkListing = a1?.listings.find((l) => l.id === L_CARPARK);
      // The listing is still present as a regular row (no special carpark treatment).
      expect(carparkListing).toBeDefined();
    });

    it("converts Decimals to numbers at the repo edge", async () => {
      const { apartments } = await findApartmentsForTracker(ORG_A, ALL, null, 50);
      const a1 = apartments.find((a) => a.id === APT_A1);
      const master = a1?.listings.find((l) => l.id === L_MASTER);
      expect(master?.baseRentAmount).toBe(1300);
      expect(master?.rentalRate).toBe(1250);
      const active = master?.tenancies.find((t) => t.id === T_ACTIVE);
      expect(active?.monthlyRentAmount).toBe(1200.5);
    });

    it("carries the renewal chain + foundation columns on the active tenancy", async () => {
      const { apartments } = await findApartmentsForTracker(ORG_A, ACTIVE, null, 50);
      const a1 = apartments.find((a) => a.id === APT_A1);
      const active = a1?.listings
        .find((l) => l.id === L_MASTER)
        ?.tenancies.find((t) => t.id === T_ACTIVE);
      expect(active?.previousTenancy).toEqual({ id: T_PREV, termMonths: 12 });
      expect(active?.numberOfPax).toBe(2);
      expect(active?.accessCardNo).toBe("AC-7788");
      expect(active?.agentLabel).toBe("KENDRA");
      // idNumber IS selected raw here — the service masks it.
      expect(active?.tenantParty.idNumber).toBe("990101-14-1234");
    });
  });

  describe("cursor pagination", () => {
    it("limit=1 page-walk visits every org-A apartment exactly once, then nextCursor=null", async () => {
      const visited: string[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const page = await findApartmentsForTracker(ORG_A, ALL, cursor, 1);
        expect(page.apartments.length).toBeLessThanOrEqual(1);
        visited.push(...page.apartments.map((a) => a.id));
        cursor = page.nextCursor;
        guard += 1;
      } while (cursor !== null && guard < 10);
      expect(visited).toEqual([APT_A1, APT_A2]); // ordered, no overlap, complete
    });
  });

  describe("lookupByPhone", () => {
    it("returns the seeded tenant's tenancies (any status) incl. apartmentId + unitCode", async () => {
      const hits = await lookupByPhone(ORG_A, "6789");
      // Alice holds T_PREV (ended), T_ACTIVE, T_CARPARK — all statuses returned.
      expect(hits.map((h) => h.tenancyId).sort()).toEqual([T_PREV, T_ACTIVE, T_CARPARK].sort());
      const active = hits.find((h) => h.tenancyId === T_ACTIVE);
      expect(active).toEqual({
        tenancyId: T_ACTIVE,
        unitId: L_MASTER,
        apartmentId: APT_A1,
        propertyId: PROP_A,
        displayName: "Alice Tan",
        unitCode: "A-10-1",
      });
    });

    it("returns [] on miss and never leaks org-B numbers", async () => {
      expect(await lookupByPhone(ORG_A, "0000")).toEqual([]);
      expect(await lookupByPhone(ORG_A, "8888")).toEqual([]); // Bella is org B
      expect(await lookupByPhone(ORG_A, "abc")).toEqual([]);
    });
  });

  describe("phone contains-match (v2 spec §3.1)", () => {
    it("list filter matches a national PREFIX (was the endsWith bug)", async () => {
      const page = await findApartmentsForTracker(ORG_A, { ...ALL, phone: "0123" }, null, 25);
      expect(page.apartments.map((a) => a.id)).toContain(APT_A1);
    });

    it("list filter matches a MIDDLE fragment", async () => {
      const page = await findApartmentsForTracker(ORG_A, { ...ALL, phone: "2345" }, null, 25);
      expect(page.apartments.map((a) => a.id)).toContain(APT_A1);
    });

    it("list filter still matches the last-4 habit (regression)", async () => {
      const page = await findApartmentsForTracker(ORG_A, { ...ALL, phone: "6789" }, null, 25);
      expect(page.apartments.map((a) => a.id)).toContain(APT_A1);
    });

    it("stays org-scoped", async () => {
      const page = await findApartmentsForTracker(ORG_A, { ...ALL, phone: "7777" }, null, 25);
      expect(page.apartments).toHaveLength(0);
    });

    it("lookup matches a prefix", async () => {
      const hits = await lookupByPhone(ORG_A, "0123");
      expect(hits.map((h) => h.tenancyId)).toContain(T_ACTIVE);
    });

    it("lookup ranks true SUFFIX matches before contains-noise (carrier-prefix last-4)", async () => {
      // Seed 11 noise parties whose phones CONTAIN "6789" mid-string but do not
      // end with it, each with a tenancy newer than Alice's (status "ended" —
      // lookupByPhone ranks by startDate desc regardless of status, and only
      // one ACTIVE tenancy per unit is allowed) — under plain contains+take(10)
      // they would evict the true suffix match.
      const db = getDb();
      const noiseIds: string[] = [];
      const noiseTenancyIds: string[] = [];
      for (let i = 0; i < 11; i++) {
        const pid = `aa100000-0000-4000-8000-0000000009${String(i).padStart(2, "0")}`;
        const tid = `aa100000-0000-4000-8000-0000000008${String(i).padStart(2, "0")}`;
        noiseIds.push(pid);
        noiseTenancyIds.push(tid);
        await db.party.create({
          data: {
            id: pid, organizationId: ORG_A, partyType: "tenant",
            displayName: `Noise ${i}`, status: "active",
            primaryPhone: `60116789${String(100 + i)}`, // contains "6789", ends "1xx"
          },
        });
        await db.tenancy.create({
          data: {
            id: tid, organizationId: ORG_A, propertyId: PROP_A,
            billingStatus: "active", unitId: L_MASTER, tenantPartyId: pid,
            tenancyCode: `TRK-NOISE-${String(i).padStart(2, "0")}`,
            status: "ended", startDate: new Date("2030-01-01"), endDate: new Date("2030-06-01"),
            monthlyRentAmount: "1200.00",
          },
        });
      }
      try {
        const hits = await lookupByPhone(ORG_A, "6789");
        expect(hits.map((h) => h.tenancyId)).toContain(T_ACTIVE);
        expect(hits.length).toBeLessThanOrEqual(10);
      } finally {
        await db.tenancy.deleteMany({ where: { id: { in: noiseTenancyIds } } });
        await db.party.deleteMany({ where: { id: { in: noiseIds } } });
      }
    });
  });

  describe("occupiedOnly (v2 spec §3.3)", () => {
    it("true hides units with zero ACTIVE-tenancy rooms", async () => {
      const page = await findApartmentsForTracker(ORG_A, { ...ACTIVE, occupiedOnly: true }, null, 25);
      const ids = page.apartments.map((a) => a.id);
      expect(ids).toContain(APT_A1);
      expect(ids).not.toContain(APT_A2);
    });

    it("is status-independent: status=ended still hides currently-VACANT units", async () => {
      const page = await findApartmentsForTracker(ORG_A, { ...ENDED, occupiedOnly: true }, null, 25);
      const ids = page.apartments.map((a) => a.id);
      expect(ids).not.toContain(APT_A2);
      // Occupied unit stays visible — APT_A1's Master room has an ACTIVE tenancy.
      expect(ids).toContain(APT_A1);
    });

    it("status=ended + occupiedOnly hides a unit whose only room tenancy is ENDED (no active)", async () => {
      // Discriminating fixture (mutation-test finding): APT_A2 has ZERO
      // tenancies, so it is hidden under BOTH the correct always-active impl
      // AND the regression `tenancies.some(tenancyStatusWhere(filters.status))`.
      // This unit's ENDED room tenancy matches `{status:{not:"active"}}`, so
      // the regression would SHOW it; the correct impl HIDES it.
      const db = getDb();
      const APT_ENDED_ONLY = "aa100000-0000-4000-8000-000000000081";
      const L_END_ROOM = "aa100000-0000-4000-8000-000000000082";
      const T_END = "aa100000-0000-4000-8000-000000000083";
      await db.apartment.create({
        data: { id: APT_ENDED_ONLY, organizationId: ORG_A, propertyId: PROP_A, unitCode: "A-98-8", listingMode: "WHOLE" },
      });
      await db.listing.create({
        data: {
          id: L_END_ROOM, apartmentId: APT_ENDED_ONLY, listingType: "Master",
          occupancyStatus: "vacant", organizationId: ORG_A, listingStatus: "active", currency: "MYR",
        },
      });
      await db.tenancy.create({
        data: {
          id: T_END, unitId: L_END_ROOM, tenantPartyId: P_BOB, tenancyCode: "TRK-END-001",
          status: "ended", startDate: new Date("2024-02-01"), endDate: new Date("2025-02-01"),
          monthlyRentAmount: "900.00", organizationId: ORG_A, propertyId: PROP_A, billingStatus: "active",
        },
      });
      try {
        const page = await findApartmentsForTracker(ORG_A, { ...ENDED, occupiedOnly: true }, null, 25);
        expect(page.apartments.map((a) => a.id)).not.toContain(APT_ENDED_ONLY);
      } finally {
        await db.tenancy.delete({ where: { id: T_END } });
        await db.listing.delete({ where: { id: L_END_ROOM } });
        await db.apartment.delete({ where: { id: APT_ENDED_ONLY } });
      }
    });

    // NOTE: The old test "a unit whose ONLY active tenancy is a carpark counts as vacant"
    // was removed in Task 5.4b. In the new model, carparks are first-class Carpark entities
    // (not Listing rows with unitKind="carpark"), so all Listings are rooms. An apartment
    // with an active tenancy on any listing is considered occupied — the carpark-exclusion
    // logic is no longer needed.
  });

  describe("listAgentLabels", () => {
    it("returns exactly org A's distinct raw labels — no normalization, no org-B leak", async () => {
      const labels = await listAgentLabels(ORG_A);
      expect([...labels].sort()).toEqual(["KENDRA", "Kendra"]); // distinct raw values
      expect(labels).not.toContain("ORGB-AGENT");
    });
  });

  describe("findListingForInCharge / findPartyInOrg", () => {
    it("returns the listing snapshot for an in-org unit", async () => {
      const row = await findListingForInCharge(getDb(), ORG_A, L_MASTER);
      expect(row).toMatchObject({ id: L_MASTER, inChargePartyId: null, inChargeName: null });
      expect(row?.updatedAt).toBeInstanceOf(Date);
    });

    it("returns null for an org-B listing queried with org-A orgId", async () => {
      expect(await findListingForInCharge(getDb(), ORG_A, L_B)).toBeNull();
    });

    it("findPartyInOrg: {id, displayName} in-org, null cross-org", async () => {
      expect(await findPartyInOrg(getDb(), ORG_A, P_ALICE)).toEqual({
        id: P_ALICE,
        displayName: "Alice Tan",
      });
      expect(await findPartyInOrg(getDb(), ORG_A, P_BELLA)).toBeNull();
    });
  });

  describe("activeTenancyCount (v2 spec §3.4)", () => {
    it("is populated independent of the status scope", async () => {
      // Under status=ended, Alice's ACTIVE tenancy is filtered out of
      // `tenancies` — but the count must still say the Master room is occupied.
      const page = await findApartmentsForTracker(ORG_A, ENDED, null, 25);
      const apt = page.apartments.find((a) => a.id === APT_A1)!;
      const master = apt.listings.find((l) => l.id === L_MASTER)!;
      expect(master.activeTenancyCount).toBe(1);
      const studio = apt.listings.find((l) => l.id === L_STUDIO)!;
      expect(studio.activeTenancyCount).toBe(0);
    });
  });

  describe("getTrackerSummary (v2 spec §3.2)", () => {
    it("counts rooms/active/vacant per property, org-scoped", async () => {
      const summary = await getTrackerSummary(ORG_A);
      const propA = summary.properties.find((p) => p.propertyId === PROP_A)!;
      expect(propA.apartments).toBe(2);
      // All Listings are rooms post-carpark-redesign: Master, Studio, L_CARPARK, A2-Master
      expect(propA.rooms).toBe(4);
      // T_ACTIVE (Master) + T_CARPARK (L_CARPARK) — both active
      expect(propA.activeTenancies).toBe(2);
      // Studio (no active tenancy) + A2-Master (no tenancy)
      expect(propA.vacantRooms).toBe(2);
      expect(summary.properties.some((p) => p.propertyId === PROP_B)).toBe(false);
      expect(summary.totals).toEqual({ apartments: 2, rooms: 4, activeTenancies: 2, vacantRooms: 2 });
    });
  });
});
