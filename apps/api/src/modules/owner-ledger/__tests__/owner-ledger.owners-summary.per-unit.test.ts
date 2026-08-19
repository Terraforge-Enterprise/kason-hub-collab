/**
 * Integration tests for the per-unit (per-apartment) sub-rows added to
 * resolveOwnersSummary (Task 7).
 *
 * The owner-row scalar fields (grossRental / totalExpenses / netPayoutToOwner)
 * are FROZEN — this suite asserts they equal the combined (apt-1 + apt-2 +
 * null-apartment) values, and the brand-new `units` array splits the
 * apartment-anchored entries per apartment WITHOUT touching the owner totals.
 *
 * Requires a real local Postgres with all Phase-2 migrations applied.
 * Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     ../../node_modules/.bin/vitest run \
 *     src/modules/owner-ledger/__tests__/owner-ledger.owners-summary.per-unit.test.ts
 *
 * Mirrors the seed/teardown shape of owner-ledger.owners-summary.test.ts but uses
 * an ISOLATED org/fixture prefix ("7e51", Task 7) so the shared-Postgres serial
 * integration run never collides with that suite's "cccc" fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { resolveOwnersSummary } from "../owner-ledger.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// ─── Stable fixture UUIDs (isolated "7e51" prefix) ────────────────────────────

const ORG = "7e510000-0000-4000-8000-000000000001";

const OWNER_A = "7e510000-0000-4000-8000-000000000010"; // 2-apartment owner

const PROPERTY_A = "7e510000-0000-4000-8000-000000000020";

const APT_1 = "7e510000-0000-4000-8000-000000000030"; // unitCode "S-01"
const APT_2 = "7e510000-0000-4000-8000-000000000031"; // unitCode "S-02"

const LISTING_1 = "7e510000-0000-4000-8000-000000000040"; // owned by OWNER_A, in APT_1
const LISTING_2 = "7e510000-0000-4000-8000-000000000041"; // owned by OWNER_A, in APT_2

const ACTOR = "7e510000-0000-4000-8000-000000000050";

// ─── Seed / teardown ──────────────────────────────────────────────────────────

async function seedAll() {
  const db = getDb();

  await db.organization.upsert({
    where: { id: ORG },
    create: {
      id: ORG,
      name: "PerUnit Test Org",
      slug: `per-unit-${ORG.slice(0, 8)}`,
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
    update: {},
  });

  await db.party.upsert({
    where: { id: OWNER_A },
    create: { id: OWNER_A, organizationId: ORG, partyType: "owner", displayName: "Alice Seven", status: "active" },
    update: {},
  });

  await db.property.upsert({
    where: { id: PROPERTY_A },
    create: {
      id: PROPERTY_A,
      organizationId: ORG,
      name: "Property Seven",
      propertyCode: "PC-PERUNIT7",
      propertyType: "residential",
      addressLine1: "7 Test St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "published",
    },
    update: {},
  });

  for (const [id, code] of [
    [APT_1, "S-01"],
    [APT_2, "S-02"],
  ] as [string, string][]) {
    await db.apartment.upsert({
      where: { id },
      create: { id, organizationId: ORG, propertyId: PROPERTY_A, unitCode: code, listingMode: "WHOLE" },
      update: {},
    });
  }

  // OWNER_A owns one listing in each apartment (per-unit owner keying).
  for (const [id, aptId] of [
    [LISTING_1, APT_1],
    [LISTING_2, APT_2],
  ] as [string, string][]) {
    await db.listing.upsert({
      where: { id },
      create: {
        id,
        organizationId: ORG,
        apartmentId: aptId,
        listingType: "master",
        occupancyStatus: "vacant",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: OWNER_A,
      },
      update: {},
    });
  }
}

async function teardownAll() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { id: { in: [LISTING_1, LISTING_2] } } });
  await db.apartment.deleteMany({ where: { id: { in: [APT_1, APT_2] } } });
  await db.property.deleteMany({ where: { id: PROPERTY_A } });
  await db.party.deleteMany({ where: { id: OWNER_A } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function wipeEntries() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
}

// ─── Entry factory (apartmentId-aware) ────────────────────────────────────────

function entryData(
  ownerPartyId: string,
  apartmentId: string | null,
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
    organizationId: ORG,
    ownerPartyId,
    propertyId: PROPERTY_A,
    apartmentId,
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

// Sum a 2dp money field across the per-apartment sub-rows → integer cents.
function sumUnitCents(
  units: { grossRental: string; totalExpenses: string; netPayoutToOwner: string }[],
  field: "grossRental" | "totalExpenses" | "netPayoutToOwner",
): number {
  return units.reduce((acc, u) => acc + Math.round(Number(u[field]) * 100), 0);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

dn("owners-summary per-unit sub-rows — integration", () => {
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

  it("(a)+(b) owner row is FROZEN to combined; units splits per apartment (excludes null-apartment); SST folds into gross + gross/expense/net reconcile", async () => {
    const db = getDb();

    /**
     * OWNER_A in 2026-06. The apt-1 income carries SST 80.00 so the sub-row pass
     * MUST fold sstAmount into gross exactly as the owner loop does — a regression
     * that dropped the sstAmount block in the second pass would yield 2000.00 (not
     * 2080.00) for S-01 and turn this suite RED.
     *   APT_1 (S-01): income 2000 + SST 80 kaen incl=true ; expense 200 kaen incl=true
     *   APT_2 (S-02): income 1000 kaen incl=true ; expense 100 owner incl=false (owner-paid, NOT deducted)
     *   null apt   : income 500 kaen incl=true (property-level / owner-combined)
     *
     * FROZEN owner row (combined incl. the null-apartment row + SST):
     *   grossRental      = (2000+80) + 1000 + 500 = 3580.00
     *   totalExpenses    = 200 + 100              = 300.00
     *   netPayoutToOwner = 3580 - 200             = 3380.00   (only the kaen mgmt fee deducts)
     *
     * units (apartment-anchored entries only; null-apartment row EXCLUDED):
     *   S-01: gross 2080 (incl SST) / exp 200 / net 1880.00
     *   S-02: gross 1000 / exp 100 / net 1000.00   (owner-paid expense not deducted)
     *   Σ unit gross = 3080.00 (owner 3580 − 500 null-income); Σ unit exp = 300.00 (== owner, no null exp);
     *   Σ unit net   = 2880.00 (owner 3380 − 500 null-income).
     */
    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(OWNER_A, APT_1, "2026-06", "income", "2000.00", "kaen", true, "paid", "80.00"),
        entryData(OWNER_A, APT_1, "2026-06", "expense", "200.00", "kaen", true),
        entryData(OWNER_A, APT_2, "2026-06", "income", "1000.00", "kaen", true),
        entryData(OWNER_A, APT_2, "2026-06", "expense", "100.00", "owner", false),
        entryData(OWNER_A, null, "2026-06", "income", "500.00", "kaen", true),
      ],
    });

    const result = await resolveOwnersSummary(ORG, "2026-06", "2026-06");
    expect(result.owners).toHaveLength(1);
    const a = result.owners[0]!;

    // (a) FROZEN owner-row scalars — combined values incl. the null-apartment row + SST.
    expect(a.grossRental).toBe("3580.00");
    expect(a.totalExpenses).toBe("300.00");
    expect(a.netPayoutToOwner).toBe("3380.00");

    // (b) units: exactly 2 (one per apartment), sorted by unitCode, null-apt excluded.
    expect(a.units).toHaveLength(2);
    expect(a.units.map((u) => u.unitCode)).toEqual(["S-01", "S-02"]);

    const s01 = a.units.find((u) => u.unitCode === "S-01")!;
    const s02 = a.units.find((u) => u.unitCode === "S-02")!;

    // S-01 gross MUST include the 80.00 SST (2080, not 2000) — proves the sub-row
    // pass uses the IDENTICAL amount+sstAmount formula as the owner loop.
    expect(s01.apartmentId).toBe(APT_1);
    expect(s01.grossRental).toBe("2080.00");
    expect(s01.totalExpenses).toBe("200.00");
    expect(s01.netPayoutToOwner).toBe("1880.00");

    expect(s02.apartmentId).toBe(APT_2);
    expect(s02.grossRental).toBe("1000.00");
    expect(s02.totalExpenses).toBe("100.00");
    expect(s02.netPayoutToOwner).toBe("1000.00");

    // (c) reconciliation across ALL THREE money buckets: Σ unit field + null-apartment
    // remainder == owner field. The only null-apartment row is +500 income (0 expense,
    // 0 payout-expense) → gross/net gap 500.00, expense gap 0.00. Catches a
    // direction/bucket mix-up that happens to net out.
    const sumGrossC = sumUnitCents(a.units, "grossRental");
    const sumExpenseC = sumUnitCents(a.units, "totalExpenses");
    const sumNetC = sumUnitCents(a.units, "netPayoutToOwner");
    const ownerGrossC = Math.round(Number(a.grossRental) * 100);
    const ownerExpenseC = Math.round(Number(a.totalExpenses) * 100);
    const ownerNetC = Math.round(Number(a.netPayoutToOwner) * 100);

    expect(sumGrossC).toBe(308000); // 2080 + 1000
    expect(sumExpenseC).toBe(30000); // 200 + 100
    expect(sumNetC).toBe(288000); // 1880 + 1000
    expect(ownerGrossC - sumGrossC).toBe(50000); // null-apartment income
    expect(ownerExpenseC - sumExpenseC).toBe(0); // no null-apartment expense
    expect(ownerNetC - sumNetC).toBe(50000); // null-apartment income
  });

  it("(c) with NO null-apartment rows, the unit gross/expense/net sum EXACTLY to the owner row", async () => {
    const db = getDb();

    // Same apartment activity (apt-1 income still carries SST 80), but WITHOUT any
    // null-apartment row → perfect close-out on EVERY money bucket.
    await db.ownerLedgerEntry.createMany({
      data: [
        entryData(OWNER_A, APT_1, "2026-06", "income", "2000.00", "kaen", true, "paid", "80.00"),
        entryData(OWNER_A, APT_1, "2026-06", "expense", "200.00", "kaen", true),
        entryData(OWNER_A, APT_2, "2026-06", "income", "1000.00", "kaen", true),
        entryData(OWNER_A, APT_2, "2026-06", "expense", "100.00", "owner", false),
      ],
    });

    const result = await resolveOwnersSummary(ORG, "2026-06", "2026-06");
    const a = result.owners[0]!;

    expect(a.grossRental).toBe("3080.00"); // 2080 (incl SST) + 1000
    expect(a.totalExpenses).toBe("300.00"); // 200 + 100
    expect(a.netPayoutToOwner).toBe("2880.00"); // 1880 + 1000
    expect(a.units).toHaveLength(2);

    // Exact close-out — Σ unit field == owner field for gross, expense AND net.
    expect(sumUnitCents(a.units, "grossRental")).toBe(Math.round(Number(a.grossRental) * 100));
    expect(sumUnitCents(a.units, "totalExpenses")).toBe(Math.round(Number(a.totalExpenses) * 100));
    expect(sumUnitCents(a.units, "netPayoutToOwner")).toBe(Math.round(Number(a.netPayoutToOwner) * 100));
  });
});
