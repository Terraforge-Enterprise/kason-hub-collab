/**
 * Finding C — Source-4 owner/tenant discriminator.
 *
 * Source 4 ("tenant-borne income", owner-ledger.sync.ts) books utility/aircond
 * Charges on the owner's units as owner INCOME (sourceType tenant_utility /
 * tenant_aircond, direction income). Its query filters
 *   { organizationId, unitId:{in: owner listings}, chargeType:{in:["utility","aircond"]}, dueDate, status }
 * with NO owner/tenant discriminator, so OWNER-billed grid utility charges
 * (partyId == ownerPartyId) are mis-booked as tenant income:
 *   • GRIDOWN-*   — bills-grid owner-borne utility (chargeType "utility")
 *   • GRIDRECUR-* — bills-grid OWNER-borne recurring (chargeType "utility"),
 *                   a prefix SHARED with tenant-borne recurring, so only a
 *                   partyId discriminator (not a chargeNumber prefix) can
 *                   separate the two.
 *
 * The fix adds `partyId: { not: ownerPartyId }` — "a tenant carve-out is a
 * charge NOT billed to the owner". Charge.partyId is NON-NULLABLE (schema), and
 * every legitimate tenant carve-out mint (GRIDUTIL / GRIDRECUR-tenant / meter
 * UTIL / meter AC) sets partyId to the TENANT party, so the discriminator
 * provably cannot drop a real carve-out.
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (0d..cN).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { syncMonthService } from "../owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "0d000000-0000-4000-8000-0000000000c1";
const USER = "0d000000-0000-4000-8000-0000000000c2";
const OP_PARTY = "0d000000-0000-4000-8000-0000000000c3";
const OWNER = "0d000000-0000-4000-8000-0000000000c4";
const TENANT = "0d000000-0000-4000-8000-0000000000c5";
const PROPERTY = "0d000000-0000-4000-8000-0000000000c6";
const APARTMENT = "0d000000-0000-4000-8000-0000000000c7";
const UNIT = "0d000000-0000-4000-8000-0000000000c8";
const TENANCY = "0d000000-0000-4000-8000-0000000000c9";

// Charge ids — queried by sourceChargeId on the resulting owner-ledger rows.
const CH_GRIDOWN = "0d000000-0000-4000-8000-0000000000d1"; // owner utility (must NOT book)
const CH_GRIDRECUR_OWNER = "0d000000-0000-4000-8000-0000000000d2"; // owner recurring (must NOT book)
const CH_TENANT_CARVEOUT = "0d000000-0000-4000-8000-0000000000d3"; // tenant utility (MUST book)

const MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1));
const DUE = new Date(Date.UTC(2026, 5, 5));

const ctx: OwnerLedgerActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
  ip: "127.0.0.1",
  userAgent: "vitest",
};

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/**
 * Seed one owner-month with THREE utility charges on the owner's own listing,
 * all fully paid (outstanding 0 → collected == amount, so a booked Source-4 row
 * would carry a NON-ZERO income amount, not a latent $0):
 *   • GRIDOWN owner utility  50.00  partyId=OWNER            → must NOT book
 *   • GRIDRECUR owner recur  30.00  partyId=OWNER, no tenancy → must NOT book
 *   • GRIDUTIL tenant carve  12.00  partyId=TENANT           → MUST book (income)
 */
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "OL S4 Org", slug: "ol-s4-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: OP_PARTY, organizationId: ORG, displayName: "OL S4 Operator", partyType: "individual", status: "active" } });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "ol-s4-operator@example.com", fullName: "OL S4 Operator", status: "active", role: "admin", userType: "operator", partyId: OP_PARTY },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "OL S4 Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "OL S4 Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "OL S4 Property", propertyCode: "OL-S4-P1", propertyType: "apartment", addressLine1: "1 S4 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-1", listingMode: "PARTITIONED" } });
  await db.listing.create({
    data: { id: UNIT, organizationId: ORG, apartmentId: APARTMENT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER },
  });
  await db.tenancy.create({
    data: { id: TENANCY, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "OL-S4-T1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "1000" },
  });

  // Owner-billed grid utility (GRIDOWN) — partyId = OWNER. MUST NOT book as tenant income.
  await db.charge.create({
    data: { id: CH_GRIDOWN, organizationId: ORG, chargeNumber: `GRIDOWN-${MONTH}-${APARTMENT}-ELECTRICITY`, unitId: UNIT, partyId: OWNER, chargeType: "utility", status: "paid", dueDate: DUE, amount: "50.00", currency: "MYR", outstandingAmount: "0.00", billingMonth: MONTH_START },
  });
  // Owner-borne recurring (GRIDRECUR) — partyId = OWNER, tenancyId null, chargeType "utility".
  // Shares the GRIDRECUR- prefix with tenant recurring, so only partyId can separate them.
  await db.charge.create({
    data: { id: CH_GRIDRECUR_OWNER, organizationId: ORG, chargeNumber: `GRIDRECUR-${MONTH}-owner-line`, unitId: UNIT, partyId: OWNER, chargeType: "utility", status: "paid", dueDate: DUE, amount: "30.00", currency: "MYR", outstandingAmount: "0.00", billingMonth: MONTH_START },
  });
  // Legitimate tenant utility carve-out (GRIDUTIL) — partyId = TENANT. MUST book as income.
  await db.charge.create({
    data: { id: CH_TENANT_CARVEOUT, organizationId: ORG, chargeNumber: `GRIDUTIL-${MONTH}-${UNIT}-ELECTRICITY`, tenancyId: TENANCY, unitId: UNIT, partyId: TENANT, chargeType: "utility", status: "paid", dueDate: DUE, amount: "12.00", currency: "MYR", outstandingAmount: "0.00", billingMonth: MONTH_START },
  });
}

dn("owner-ledger.sync — Source-4 owner/tenant discriminator (Finding C)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("C1: excludes the GRIDOWN owner utility charge from Source-4 tenant income", async () => {
    const db = getDb();
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);

    // The owner-billed GRIDOWN charge must produce NO owner-ledger row.
    const row = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG, sourceChargeId: CH_GRIDOWN },
    });
    expect(row, "GRIDOWN owner charge must NOT be booked as Source-4 income").toBeNull();

    // And no tenant_utility income row may carry the owner's party.
    const ownerIncome = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG, sourceType: "tenant_utility", direction: "income", listingId: UNIT, amount: "50" },
    });
    expect(ownerIncome, "no owner-amount (50) tenant_utility income row").toBeNull();
  });

  it("C2: still books a legitimate tenant utility carve-out as Source-4 income (regression guard)", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });

    const row = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG, sourceChargeId: CH_TENANT_CARVEOUT },
    });
    expect(row, "tenant utility carve-out MUST still book").not.toBeNull();
    expect(row!.sourceType).toBe("tenant_utility");
    expect(row!.direction).toBe("income");
    expect(row!.category).toBe("utility_income");
    expect(row!.amount.toString()).toBe("12");
    expect(row!.includeInPayout).toBe(true);
    expect(row!.tenancyId).toBe(TENANCY);
  });

  it("C3: excludes the GRIDRECUR owner-borne recurring charge from Source-4 income", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });

    // GRIDRECUR- prefix is shared with tenant recurring; only the partyId
    // discriminator excludes the owner-borne one — proves a chargeNumber-prefix
    // fix (Option B) would be insufficient here.
    const row = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG, sourceChargeId: CH_GRIDRECUR_OWNER },
    });
    expect(row, "GRIDRECUR owner-borne recurring charge must NOT be booked as income").toBeNull();
  });
});
