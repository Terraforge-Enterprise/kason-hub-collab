/**
 * Integration tests for resolveOwnersSummary + getOwnersSummaryService +
 * GET /api/owner-ledger/owners-summary.
 *
 * Requires a real local Postgres with all Phase-2 migrations applied.
 *
 * Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     npx vitest run apps/api/src/modules/owner-ledger
 *
 * Setup: creates two owners with mixed entries (income + kaen-paid expense +
 * owner-paid expense) to verify:
 *   - per-owner gross/expenses/netPayout
 *   - owner-paid expense IS in totalExpenses but NOT deducted from netPayout
 *   - pendingCount
 *   - empty range → owners:[]
 *   - cross-org entries are excluded
 *   - auth gates (401 unauth, 403 non-manager)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";
import { resolveOwnersSummary } from "../owner-ledger.repository";
import { ownerLedgerRoutes } from "../owner-ledger.routes";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// ─── Stable fixture UUIDs ─────────────────────────────────────────────────────
// Prefix "cccc" to avoid colliding with other test suites.

const ORG = "cccccccc-0000-4000-8000-000000000001";
const OTHER_ORG = "cccccccc-0000-4000-8000-000000000002";

const OWNER_A = "cccccccc-0000-4000-8000-000000000010";
const OWNER_B = "cccccccc-0000-4000-8000-000000000011";
const OWNER_C = "cccccccc-0000-4000-8000-000000000012"; // No LandlordTenancy — unitCodes should be []

const PROPERTY_A = "cccccccc-0000-4000-8000-000000000020";
const PROPERTY_B = "cccccccc-0000-4000-8000-000000000021";
const PROPERTY_OTHER = "cccccccc-0000-4000-8000-000000000022";

const APT_A1 = "cccccccc-0000-4000-8000-000000000030";
const APT_A2 = "cccccccc-0000-4000-8000-000000000031";
const APT_B1 = "cccccccc-0000-4000-8000-000000000032";

// Owned listings (owner→units now resolves per-unit via Listing.ownerPartyId).
const LISTING_A1 = "cccccccc-0000-4000-8000-000000000060";
const LISTING_A2 = "cccccccc-0000-4000-8000-000000000061";
const LISTING_B1 = "cccccccc-0000-4000-8000-000000000062";

const LT_A = "cccccccc-0000-4000-8000-000000000040";
const LT_B = "cccccccc-0000-4000-8000-000000000041";

const ACTOR = "cccccccc-0000-4000-8000-000000000050";

// ─── HTTP test harness ────────────────────────────────────────────────────────

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerLedgerRoutes);
  return app;
}

const adminSession: SessionPayload = { userId: ACTOR, orgId: ORG, role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: ACTOR, orgId: ORG, role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: ACTOR, orgId: ORG, role: "editor", userType: "operator" };

// ─── Seed / teardown ──────────────────────────────────────────────────────────

async function seedAll() {
  const db = getDb();

  // Orgs
  for (const [id, name, slug] of [
    [ORG, "OwnSummary Test Org", `own-sum-${ORG.slice(0, 6)}`],
    [OTHER_ORG, "OwnSummary Other Org", `own-sum-other-${OTHER_ORG.slice(0, 6)}`],
  ] as [string, string, string][]) {
    await db.organization.upsert({
      where: { id },
      create: { id, name, slug, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
      update: {},
    });
  }

  // Parties (owners)
  for (const [id, orgId, displayName] of [
    [OWNER_A, ORG, "Alice Owner"],
    [OWNER_B, ORG, "Bob Owner"],
    [OWNER_C, ORG, "Carol Owner"], // No LandlordTenancy seeded — unitCodes should be []
    // A cross-org owner (should never appear in results for ORG)
    [OWNER_A, OTHER_ORG, "Alice Other Org"], // same UUID, different org — Prisma Party id is unique, use distinct ids
  ] as [string, string, string][]) {
    // Each party id must be unique; cross-org tests add entries directly
    try {
      await db.party.upsert({
        where: { id },
        create: { id, organizationId: orgId, partyType: "owner", displayName, status: "active" },
        update: {},
      });
    } catch {
      // ignore if already exists with different org
    }
  }

  // Properties — use full last 8 chars of UUID tail to guarantee unique propertyCodes
  for (const [id, orgId, name, code] of [
    [PROPERTY_A, ORG, "Property A", "PC-SUMMPA1"],
    [PROPERTY_B, ORG, "Property B", "PC-SUMMPB1"],
    [PROPERTY_OTHER, OTHER_ORG, "Other Org Property", "PC-SUMMOT1"],
  ] as [string, string, string, string][]) {
    await db.property.upsert({
      where: { id },
      create: { id, organizationId: orgId, name, propertyCode: code, propertyType: "residential", addressLine1: "1 Test St", city: "KL", country: "MY", status: "active", publishStatus: "published" },
      update: {},
    });
  }

  // Apartments — Owner A has 2 distinct apartments, Owner B has 1
  for (const [id, orgId, propId, code] of [
    [APT_A1, ORG, PROPERTY_A, "A-01"],
    [APT_A2, ORG, PROPERTY_A, "A-02"],
    [APT_B1, ORG, PROPERTY_B, "B-01"],
  ] as [string, string, string, string][]) {
    await db.apartment.upsert({
      where: { id },
      create: { id, organizationId: orgId, propertyId: propId, unitCode: code, listingMode: "WHOLE" },
      update: {},
    });
  }

  // LandlordTenancies — link owners to properties (gives unitCount)
  await db.landlordTenancy.upsert({
    where: { id: LT_A },
    create: { id: LT_A, organizationId: ORG, propertyId: PROPERTY_A, landlordId: OWNER_A, startDate: new Date("2024-01-01"), monthlyRent: "0", status: "active" },
    update: {},
  });
  await db.landlordTenancy.upsert({
    where: { id: LT_B },
    create: { id: LT_B, organizationId: ORG, propertyId: PROPERTY_B, landlordId: OWNER_B, startDate: new Date("2024-01-01"), monthlyRent: "0", status: "active" },
    update: {},
  });

  // Owned listings — owner→units/unitCodes now resolves per-unit via
  // Listing.ownerPartyId. OWNER_A owns A-01 + A-02; OWNER_B owns B-01.
  for (const [id, aptId, owner, type] of [
    [LISTING_A1, APT_A1, OWNER_A, "master"],
    [LISTING_A2, APT_A2, OWNER_A, "master"],
    [LISTING_B1, APT_B1, OWNER_B, "master"],
  ] as [string, string, string, string][]) {
    await db.listing.upsert({
      where: { id },
      create: {
        id,
        organizationId: ORG,
        apartmentId: aptId,
        listingType: type,
        occupancyStatus: "vacant",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: owner,
      },
      update: {},
    });
  }
}

async function teardownAll() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: OTHER_ORG } });
  await db.landlordTenancy.deleteMany({ where: { id: { in: [LT_A, LT_B] } } });
  await db.listing.deleteMany({ where: { id: { in: [LISTING_A1, LISTING_A2, LISTING_B1] } } });
  await db.apartment.deleteMany({ where: { id: { in: [APT_A1, APT_A2, APT_B1] } } });
  await db.property.deleteMany({ where: { id: { in: [PROPERTY_A, PROPERTY_B, PROPERTY_OTHER] } } });
  await db.party.deleteMany({ where: { id: { in: [OWNER_A, OWNER_B, OWNER_C] } } });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
}

async function wipeEntries() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: OTHER_ORG } });
}

// ─── Entry factory helper ─────────────────────────────────────────────────────

function entryData(
  orgId: string,
  ownerPartyId: string,
  propertyId: string,
  monthYM: string,
  direction: string,
  amount: string,
  paidBy: string,
  includeInPayout: boolean,
  paymentStatus = "paid",
  sstAmount?: string,
) {
  const [y, m] = monthYM.split("-").map(Number);
  return {
    organizationId: orgId,
    ownerPartyId,
    propertyId,
    statementMonth: new Date(Date.UTC(y!, m! - 1, 1)),
    transactionDate: new Date(Date.UTC(y!, m! - 1, 15)),
    direction,
    category: direction === "income" ? "rental_income" : "management_fee",
    amount,
    sstAmount: sstAmount ?? null,
    paidBy,
    paymentStatus,
    taxCategory: "check_with_tax_agent",
    includeInPayout,
    status: "active",
    createdById: ACTOR,
    updatedById: ACTOR,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

dn("owners-summary — integration", () => {
  beforeAll(async () => {
    await teardownAll();
    await seedAll();
  });

  afterAll(async () => {
    await teardownAll();
  });

  beforeEach(async () => {
    await wipeEntries();
  });

  // ─── Repository unit ────────────────────────────────────────────────────────

  it("(a) empty range → owners:[]", async () => {
    // No entries seeded
    const result = await resolveOwnersSummary(ORG, "2026-01", "2026-01");
    expect(result.owners).toHaveLength(0);
  });

  it("(b) per-owner gross/expenses correct; netPayout EXCLUDES owner-paid expense", async () => {
    const db = getDb();

    /**
     * Owner A in 2026-06:
     *   income  RM2000 kaen  includeInPayout=true
     *   expense RM 200 kaen  includeInPayout=true  (mgmt fee — deducted from netPayout)
     *   expense RM 100 owner includeInPayout=false (owner-paid assessment — NOT deducted)
     *
     * Expected:
     *   grossRental      = 2000.00
     *   totalExpenses    = 300.00   (200 + 100)
     *   netPayoutToOwner = 1800.00  (2000 - 200; the 100 owner-paid is NOT deducted)
     */
    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income",  "2000.00", "kaen",  true,  "paid"),
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "expense",  "200.00", "kaen",  true,  "paid"),
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "expense",  "100.00", "owner", false, "paid"),
      ],
    });

    const result = await resolveOwnersSummary(ORG, "2026-06", "2026-06");
    expect(result.owners).toHaveLength(1);
    const a = result.owners[0]!;
    expect(a.ownerPartyId).toBe(OWNER_A);
    expect(a.ownerName).toBe("Alice Owner");
    expect(a.grossRental).toBe("2000.00");
    expect(a.totalExpenses).toBe("300.00");
    expect(a.netPayoutToOwner).toBe("1800.00");
    expect(a.pendingCount).toBe(0);
    expect(a.lastEntryMonth).toBe("2026-06");
    expect(a.unitCount).toBe(2); // APT_A1 + APT_A2 via LandlordTenancy for OWNER_A→PROPERTY_A
  });

  it("(c) pendingCount counts only paymentStatus=pending entries", async () => {
    const db = getDb();

    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income", "1000.00", "kaen", true, "pending"),
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income",  "500.00", "kaen", true, "paid"),
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "expense", "100.00", "kaen", true, "pending"),
      ],
    });

    const result = await resolveOwnersSummary(ORG, "2026-06", "2026-06");
    const a = result.owners[0]!;
    expect(a.pendingCount).toBe(2); // 1 income-pending + 1 expense-pending
  });

  it("(d) two owners appear separately; sorted by ownerName asc", async () => {
    const db = getDb();

    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income", "1500.00", "kaen", true),
        entryData(ORG, OWNER_B, PROPERTY_B, "2026-06", "income", "1200.00", "kaen", true),
      ],
    });

    const result = await resolveOwnersSummary(ORG, "2026-06", "2026-06");
    expect(result.owners).toHaveLength(2);
    // Alice < Bob — sorted ascending
    expect(result.owners[0]!.ownerName).toBe("Alice Owner");
    expect(result.owners[1]!.ownerName).toBe("Bob Owner");
    // Bob has 1 apartment (APT_B1 via LandlordTenancy LT_B→PROPERTY_B)
    expect(result.owners[1]!.unitCount).toBe(1);
  });

  it("(e) cross-org entries are excluded", async () => {
    const db = getDb();

    // Cross-org entry: same ownerPartyId as OWNER_A but in OTHER_ORG
    // We need a Party in OTHER_ORG and an entry in OTHER_ORG
    const CROSS_PARTY = "cccccccc-0000-4000-8000-000000000099";
    await db.party.upsert({
      where: { id: CROSS_PARTY },
      create: { id: CROSS_PARTY, organizationId: OTHER_ORG, partyType: "owner", displayName: "Cross Org Owner", status: "active" },
      update: {},
    });

    await db.ownerLedgerEntry.create({
      data: {
        ...entryData(OTHER_ORG, CROSS_PARTY, PROPERTY_OTHER, "2026-06", "income", "9999.00", "kaen", true),
      },
    });

    // Only OWNER_A in ORG
    await db.ownerLedgerEntry.create({
      data: { ...entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income", "500.00", "kaen", true) },
    });

    const result = await resolveOwnersSummary(ORG, "2026-06", "2026-06");
    expect(result.owners).toHaveLength(1);
    expect(result.owners[0]!.ownerPartyId).toBe(OWNER_A);
    expect(result.owners[0]!.grossRental).toBe("500.00");

    // Cleanup cross-party
    await db.ownerLedgerEntry.deleteMany({ where: { organizationId: OTHER_ORG } });
    await db.party.delete({ where: { id: CROSS_PARTY } });
  });

  it("(f) void entries are excluded from aggregation", async () => {
    const db = getDb();

    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income", "2000.00", "kaen", true, "paid"),
        // This void entry should be excluded
        {
          ...entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income", "9999.00", "kaen", true, "paid"),
          status: "void",
        },
      ],
    });

    const result = await resolveOwnersSummary(ORG, "2026-06", "2026-06");
    const a = result.owners[0]!;
    expect(a.grossRental).toBe("2000.00");
  });

  it("(g) lastEntryMonth is max statementMonth across the range", async () => {
    const db = getDb();

    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-04", "income", "1000.00", "kaen", true),
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-05", "income",  "900.00", "kaen", true),
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income",  "800.00", "kaen", true),
      ],
    });

    const result = await resolveOwnersSummary(ORG, "2026-04", "2026-06");
    const a = result.owners[0]!;
    expect(a.lastEntryMonth).toBe("2026-06");
    // Gross = sum of all three months
    expect(a.grossRental).toBe("2700.00");
  });

  // ─── HTTP route gates ───────────────────────────────────────────────────────

  it("(h) 401 for unauthenticated request", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(null).request("/owners-summary");
    expect(res.status).toBe(401);
  });

  it("(i) 403 for editor (below manager threshold)", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(editorSession).request("/owners-summary");
    expect(res.status).toBe(403);
  });

  it("(j) manager gets 200 with owners array", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const db = getDb();
    await db.ownerLedgerEntry.create({
      data: { ...entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income", "1000.00", "kaen", true) },
    });

    const res = await makeApp(managerSession).request("/owners-summary?fromMonth=2026-06&toMonth=2026-06");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { owners: { ownerPartyId: string }[] } };
    expect(Array.isArray(body.data.owners)).toBe(true);
    expect(body.data.owners.length).toBeGreaterThan(0);
    expect(body.data.owners[0]!.ownerPartyId).toBe(OWNER_A);
  });

  it("(k) admin (>= manager) also gets 200", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(adminSession).request("/owners-summary?fromMonth=2026-06&toMonth=2026-06");
    expect(res.status).toBe(200);
  });

  it("(l) 400 for invalid fromMonth format", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const res = await makeApp(managerSession).request("/owners-summary?fromMonth=2026-6&toMonth=2026-06");
    expect(res.status).toBe(400);
  });

  it("(m) 404 while ENABLE_PHASE2_OWNER_BILLING is dark", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await makeApp(managerSession).request("/owners-summary");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });

  it("(n) omitting both params = all-time, returns 200 with any matching entries", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    const db = getDb();

    // Seed entries in two different months — all-time should aggregate both
    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(ORG, OWNER_A, PROPERTY_A, "2025-01", "income", "800.00", "kaen", true),
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income", "700.00", "kaen", true),
      ],
    });

    const res = await makeApp(managerSession).request("/owners-summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { owners: { grossRental: string }[] } };
    expect(Array.isArray(body.data.owners)).toBe(true);
    // All-time: both months aggregated → grossRental = 1500.00
    expect(body.data.owners[0]!.grossRental).toBe("1500.00");
  });

  // ─── All-time (no date range) ───────────────────────────────────────────────

  it("(o) all-time (no range) aggregates across all months", async () => {
    const db = getDb();

    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(ORG, OWNER_A, PROPERTY_A, "2024-12", "income",  "500.00", "kaen", true),
        entryData(ORG, OWNER_A, PROPERTY_A, "2025-06", "income",  "600.00", "kaen", true),
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income",  "700.00", "kaen", true),
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "expense", "100.00", "kaen", true),
      ],
    });

    const result = await resolveOwnersSummary(ORG);
    expect(result.owners).toHaveLength(1);
    const a = result.owners[0]!;
    expect(a.grossRental).toBe("1800.00");    // 500+600+700
    expect(a.totalExpenses).toBe("100.00");
    expect(a.netPayoutToOwner).toBe("1700.00"); // 1800 - 100
  });

  it("(p) fromMonth only = lower-bound-open above that month", async () => {
    const db = getDb();

    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(ORG, OWNER_A, PROPERTY_A, "2025-12", "income", "999.00", "kaen", true), // before cutoff
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-01", "income", "100.00", "kaen", true), // at cutoff
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income", "200.00", "kaen", true), // after cutoff
      ],
    });

    const result = await resolveOwnersSummary(ORG, "2026-01");
    const a = result.owners[0]!;
    expect(a.grossRental).toBe("300.00"); // 100 + 200 only (2025-12 excluded)
  });

  it("(q) toMonth only = upper-bound-open up to that month", async () => {
    const db = getDb();

    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(ORG, OWNER_A, PROPERTY_A, "2025-06", "income", "400.00", "kaen", true),
        entryData(ORG, OWNER_A, PROPERTY_A, "2025-12", "income", "400.00", "kaen", true),
        entryData(ORG, OWNER_A, PROPERTY_A, "2026-01", "income", "999.00", "kaen", true), // after ceiling
      ],
    });

    const result = await resolveOwnersSummary(ORG, undefined, "2025-12");
    const a = result.owners[0]!;
    expect(a.grossRental).toBe("800.00"); // 400+400 only (2026-01 excluded)
  });

  it("(r) unitCodes lists distinct unit codes from the owner's owned listings", async () => {
    const db = getDb();

    // Owner A owns LISTING_A1 (apt code "A-01") + LISTING_A2 (apt code "A-02").
    await db.ownerLedgerEntry.create({
      data: { ...entryData(ORG, OWNER_A, PROPERTY_A, "2026-06", "income", "1000.00", "kaen", true) },
    });

    const result = await resolveOwnersSummary(ORG, "2026-06", "2026-06");
    const a = result.owners[0]!;
    expect(a.unitCodes).toEqual(["A-01", "A-02"]); // sorted ascending
  });

  it("(s) unitCodes is [] for owner who owns no listings", async () => {
    const db = getDb();

    // OWNER_C has a Party record in ORG but owns NO Listing → unitCodes must be [].
    await db.ownerLedgerEntry.create({
      data: { ...entryData(ORG, OWNER_C, PROPERTY_A, "2026-06", "income", "500.00", "kaen", true) },
    });

    const result = await resolveOwnersSummary(ORG, "2026-06", "2026-06");
    const c = result.owners.find((o) => o.ownerPartyId === OWNER_C)!;
    expect(c).toBeDefined();
    expect(c.unitCodes).toEqual([]);
  });

  it("(t) MULTI-OWNER: two owners owning DIFFERENT listings under the SAME property resolve to ONLY their own units", async () => {
    // The exact bug the per-unit re-point fixes. Under the OLD property-level
    // LandlordTenancy join, an owner with ANY active LandlordTenancy on a property
    // would resolve EVERY apartment of that property — so two owners sharing a
    // building would each see the other's units. Keyed by Listing.ownerPartyId,
    // each owner now resolves ONLY the listings they actually own.
    const db = getDb();
    const SHARED_PROP = "cccccccc-0000-4000-8000-0000000000d0";
    const SHARED_APT_X = "cccccccc-0000-4000-8000-0000000000d1"; // owned by OWNER_A
    const SHARED_APT_Y = "cccccccc-0000-4000-8000-0000000000d2"; // owned by OWNER_B
    const SHARED_LISTING_X = "cccccccc-0000-4000-8000-0000000000d3";
    const SHARED_LISTING_Y = "cccccccc-0000-4000-8000-0000000000d4";

    await db.property.upsert({
      where: { id: SHARED_PROP },
      create: { id: SHARED_PROP, organizationId: ORG, name: "Shared Building", propertyCode: "PC-SHARED1", propertyType: "residential", addressLine1: "1 Shared St", city: "KL", country: "MY", status: "active", publishStatus: "published" },
      update: {},
    });
    for (const [aptId, code] of [
      [SHARED_APT_X, "X-01"],
      [SHARED_APT_Y, "Y-01"],
    ] as [string, string][]) {
      await db.apartment.upsert({
        where: { id: aptId },
        create: { id: aptId, organizationId: ORG, propertyId: SHARED_PROP, unitCode: code, listingMode: "WHOLE" },
        update: {},
      });
    }
    // OWNER_A owns the X listing; OWNER_B owns the Y listing — SAME property.
    for (const [id, aptId, owner] of [
      [SHARED_LISTING_X, SHARED_APT_X, OWNER_A],
      [SHARED_LISTING_Y, SHARED_APT_Y, OWNER_B],
    ] as [string, string, string][]) {
      await db.listing.upsert({
        where: { id },
        create: { id, organizationId: ORG, apartmentId: aptId, listingType: "master", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: owner },
        update: {},
      });
    }

    // Ledger entries so BOTH owners appear in the summary.
    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(ORG, OWNER_A, SHARED_PROP, "2026-06", "income", "1000.00", "kaen", true),
        entryData(ORG, OWNER_B, SHARED_PROP, "2026-06", "income", "1000.00", "kaen", true),
      ],
    });

    const result = await resolveOwnersSummary(ORG, "2026-06", "2026-06");
    const a = result.owners.find((o) => o.ownerPartyId === OWNER_A)!;
    const b = result.owners.find((o) => o.ownerPartyId === OWNER_B)!;

    // OWNER_A sees X-01 (its OWN shared-building unit) + its A-01/A-02 from PROPERTY_A,
    // but NEVER Y-01 (OWNER_B's unit in the same building).
    expect(a.unitCodes).toContain("X-01");
    expect(a.unitCodes).not.toContain("Y-01");
    // OWNER_B sees Y-01 + its B-01, but NEVER X-01 (OWNER_A's unit in the same building).
    expect(b.unitCodes).toContain("Y-01");
    expect(b.unitCodes).not.toContain("X-01");

    // Cleanup this test's extra rows (FK-safe order).
    await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
    await db.listing.deleteMany({ where: { id: { in: [SHARED_LISTING_X, SHARED_LISTING_Y] } } });
    await db.apartment.deleteMany({ where: { id: { in: [SHARED_APT_X, SHARED_APT_Y] } } });
    await db.property.deleteMany({ where: { id: SHARED_PROP } });
  });
});
