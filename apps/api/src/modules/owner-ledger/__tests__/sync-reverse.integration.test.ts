/**
 * syncMonthService reverse pass (integration, RUN_INTEGRATION=1).
 *
 * Proves: a sync-owned ACTIVE row whose source charge is now void/credited is
 * flipped to status "void" + audited (owner_ledger.entry.reverse_synced); an
 * ADMIN-EDITED row (updatedById !== SYNC_ACTOR_ID) with a dead source is NEVER
 * touched; a voided owner_statement Invoice voids its statement rows even when
 * the child charges keep their own status; and credited charges are EXCLUDED
 * from fresh planning (no new active row is created for them).
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     npx vitest run src/modules/owner-ledger/__tests__/sync-reverse.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { syncMonthService, SYNC_ACTOR_ID } from "../owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed disjoint UUIDs (prefix 9c34)
const ORG = "9c340000-0000-4000-8000-000000000001";
const USER = "9c340000-0000-4000-8000-000000000002";
const OWNER = "9c340000-0000-4000-8000-000000000003";
const TENANT = "9c340000-0000-4000-8000-000000000004";
const PROP = "9c340000-0000-4000-8000-000000000005";
const APT = "9c340000-0000-4000-8000-000000000006";
const UNIT = "9c340000-0000-4000-8000-000000000007";
const TEN = "9c340000-0000-4000-8000-000000000008";
const C_RENT = "9c340000-0000-4000-8000-000000000009";
const INV = "9c340000-0000-4000-8000-00000000000a";
const C_FEE = "9c340000-0000-4000-8000-00000000000b";
const MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1));

const ctx: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "P3 Reverse Sync Org",
      slug: "p3-reverse-sync-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "p3rs@test.local", passwordHash: "x", role: "admin", status: "active", fullName: "P3 Admin" },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Rev Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Rev Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROP, organizationId: ORG, name: "Rev Tower", propertyCode: "RV-P1", propertyType: "apartment", addressLine1: "1 Rev St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "RV-01-01", listingMode: "WHOLE" } });
  await db.listing.create({
    data: {
      id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "Whole Unit",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER,
    },
  });
  await db.tenancy.create({
    data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "RV-T1", status: "active", billingStatus: "current", startDate: new Date(Date.UTC(2026, 0, 1)), monthlyRentAmount: "100" },
  });
  // Source 1: a rent charge, PAID (collected 100).
  await db.charge.create({
    data: {
      id: C_RENT, organizationId: ORG, chargeNumber: "RENT-REV-1", partyId: TENANT,
      tenancyId: TEN, unitId: UNIT, chargeType: "rent", status: "paid", postedAt: new Date(),
      dueDate: new Date(Date.UTC(2026, 5, 5)), amount: "100.00", currency: "MYR",
      outstandingAmount: "0.00", billingMonth: MONTH_START,
    },
  });
  // Source 2: an owner statement with one fee line.
  await db.invoice.create({
    data: {
      id: INV, organizationId: ORG, invoiceNumber: "OS-202606-REV", partyId: OWNER,
      ownerPartyId: OWNER, invoiceType: "owner_statement", status: "approved",
      invoiceDate: new Date(), periodMonth: MONTH_START, totalAmount: "10.00",
      sstAmount: "0.80", currency: "MYR", idempotencyKey: `owner:${OWNER}:${MONTH}`,
    },
  });
  await db.charge.create({
    data: {
      id: C_FEE, organizationId: ORG, chargeNumber: "OSC-202606-REV", partyId: OWNER,
      invoiceId: INV, chargeType: "management_fee", status: "posted", postedAt: new Date(),
      dueDate: new Date(Date.UTC(2026, 5, 30)), amount: "10.00", currency: "MYR",
      outstandingAmount: "10.00", billingMonth: MONTH_START,
    },
  });
}

dn("syncMonthService reverse pass (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it("credited source charge → sync-owned row flipped to void + reverse_synced audit", async () => {
    const db = getDb();
    // First sync materialises the rent row (active, sync-owned).
    const r1 = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(r1.ok && r1.data.created).toBeGreaterThan(0);
    const row = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT },
    });
    expect(row.status).toBe("active");

    // The charge is credited (Task 2 path ran) → next sync must void the row.
    await db.charge.update({ where: { id: C_RENT }, data: { status: "credited", outstandingAmount: 0 } });
    const r2 = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(r2.ok && r2.data.reversed).toBe(1);

    const after = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("void");
    const marker = await db.auditLog.findFirst({
      where: { organizationId: ORG, action: "owner_ledger.entry.reverse_synced", entityId: row.id },
    });
    expect(marker).not.toBeNull();
  });

  it("admin-edited row with a dead source is NEVER touched", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const row = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT },
    });
    // Admin edit: updatedById becomes a REAL user id → sync must skip forever.
    await db.ownerLedgerEntry.update({ where: { id: row.id }, data: { updatedById: USER } });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });

    const r = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(r.ok && r.data.reversed).toBe(0);
    const after = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("active"); // untouched
  });

  it("voided statement Invoice voids its statement rows even with live child charges", async () => {
    const db = getDb();
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const stmtRow = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "statement", sourceChargeId: C_FEE },
    });
    expect(stmtRow.status).toBe("active");

    await db.invoice.update({ where: { id: INV }, data: { status: "void" } });
    const r = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(r.ok && r.data.reversed).toBeGreaterThanOrEqual(1);
    const after = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: stmtRow.id } });
    expect(after.status).toBe("void");
  });

  it("credited charge never plans a fresh active row", async () => {
    const db = getDb();
    await db.charge.update({ where: { id: C_RENT }, data: { status: "credited", outstandingAmount: 0 } });
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH }); // first sync AFTER credit
    const row = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT, status: "active" },
    });
    expect(row).toBeNull();
  });
});
