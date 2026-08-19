/**
 * P4 Task 2: listEntries apartmentId filter — integration (real local Postgres).
 * Opt-in via RUN_INTEGRATION=1. Fixed UUIDs prefix f6 (disjoint from other suites).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { listEntries } from "../owner-ledger.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG      = "f6000000-0000-4000-8000-000000000001";
const OWNER    = "f6000000-0000-4000-8000-000000000002";
const PROPERTY = "f6000000-0000-4000-8000-000000000003";
const ACTOR    = "f6000000-0000-4000-8000-000000000004";
const APT_A    = "f6000000-0000-4000-8000-0000000000a1";
const APT_B    = "f6000000-0000-4000-8000-0000000000b1";

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

function entry(apartmentId: string | null, amount: string) {
  return {
    organizationId: ORG,
    ownerPartyId: OWNER,
    propertyId: PROPERTY,
    apartmentId,
    statementMonth: new Date(Date.UTC(2026, 6, 1)), // 2026-07-01
    transactionDate: new Date(Date.UTC(2026, 6, 15)),
    direction: "income",
    category: "rental_income",
    amount,
    sstAmount: null,
    paidBy: "kaen",
    paymentStatus: "paid",
    taxCategory: "not_applicable",
    includeInPayout: false,
    status: "active",
    createdById: ACTOR,
    updatedById: ACTOR,
  };
}

dn("listEntries — apartmentId filter (P4)", () => {
  beforeAll(async () => {
    await cleanup();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG, name: "Apt Filter Org", slug: "apt-filter-org",
        status: "active", defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
    await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Filter Owner", partyType: "individual", status: "active" } });
    await db.property.create({
      data: {
        id: PROPERTY, organizationId: ORG, name: "Filter Residences",
        propertyCode: "FI1", propertyType: "apartment",
        addressLine1: "6 Filter St", city: "KL", country: "MY",
        status: "active", publishStatus: "draft",
      },
    });
    await db.apartment.create({ data: { id: APT_A, organizationId: ORG, propertyId: PROPERTY, unitCode: "F-06-01", listingMode: "WHOLE" } });
    await db.apartment.create({ data: { id: APT_B, organizationId: ORG, propertyId: PROPERTY, unitCode: "F-06-02", listingMode: "WHOLE" } });
    await db.ownerLedgerEntry.create({ data: entry(APT_A, "1000.00") });
    await db.ownerLedgerEntry.create({ data: entry(APT_B, "2000.00") });
    await db.ownerLedgerEntry.create({ data: entry(null, "50.00") });
  });

  afterAll(cleanup);

  it("returns only the requested apartment's rows", async () => {
    const { rows, total } = await listEntries(ORG, { apartmentId: APT_A }, { limit: 50, offset: 0 });
    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.apartmentId).toBe(APT_A);
    expect(rows[0]!.amount.toString()).toBe("1000");
  });

  it("without apartmentId returns everything (unchanged behavior)", async () => {
    const { total } = await listEntries(ORG, {}, { limit: 50, offset: 0 });
    expect(total).toBe(3);
  });

  it("combines with the month filter", async () => {
    const { total } = await listEntries(ORG, { apartmentId: APT_B, month: "2026-07" }, { limit: 50, offset: 0 });
    expect(total).toBe(1);
    const none = await listEntries(ORG, { apartmentId: APT_B, month: "2026-06" }, { limit: 50, offset: 0 });
    expect(none.total).toBe(0);
  });
});
