/**
 * What a RE-SYNC can and cannot repair — the contract any owner-ledger backfill
 * depends on.
 *
 * When a money defect is fixed in the sync's arithmetic, rows already written at
 * the wrong figure do NOT correct themselves. The remedy is to re-run
 * `syncMonthService` for the affected (owner, month) pairs. That works only for
 * rows the sync still owns:
 *
 *   sync.ts:42-45 — per existing row:
 *     not found                       → create
 *     found, updatedById == SENTINEL  → update   (sync-owned, re-syncable)
 *     found, updatedById != SENTINEL  → SKIP     (an admin edited it)
 *
 * So a backfill silently leaves every admin-touched row wrong, and a FROZEN
 * month is not re-syncable at all (syncMonthService returns skipped:1 — frozen
 * rows are immutable and corrections must flow forward instead).
 *
 * These three facts decide the shape of any backfill plan, so they are pinned
 * here rather than rediscovered. Deliberately defect-agnostic: the row is
 * corrupted by hand, so this suite does not depend on which arithmetic bug
 * produced the wrong number.
 *
 * Scoping companion: scripts/owner-ledger-primary-note-inflation.sql
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (0d1…a*).
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

const ORG = "0d100000-0000-4000-8000-0000000000a1";
const USER = "0d100000-0000-4000-8000-0000000000a2";
const OWNER = "0d100000-0000-4000-8000-0000000000a3";
const TENANT = "0d100000-0000-4000-8000-0000000000a4";
const PROPERTY = "0d100000-0000-4000-8000-0000000000a5";
const APARTMENT = "0d100000-0000-4000-8000-0000000000a6";
const UNIT = "0d100000-0000-4000-8000-0000000000a7";
const TENANCY = "0d100000-0000-4000-8000-0000000000a8";
const CH_RENT = "0d100000-0000-4000-8000-0000000000a9";

const MONTH = "2026-07";
const MONTH_START = new Date(Date.UTC(2026, 6, 1));

const ctx: OwnerLedgerActorCtx = {
  orgId: ORG, actorUserId: USER, actorRole: "admin", ip: "127.0.0.1", userAgent: "vitest",
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

/** One owner, one occupied unit, one fully-paid RM 100 rent charge for the month. */
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "Resync Org", slug: "resync-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "resync@example.com", fullName: "Resync Operator", status: "active", role: "admin", userType: "operator" },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Resync Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Resync Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "Resync Property", propertyCode: "RESYNC-P1", propertyType: "apartment", addressLine1: "1 Resync St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "R-01", listingMode: "WHOLE" } });
  await db.listing.create({
    data: { id: UNIT, organizationId: ORG, apartmentId: APARTMENT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER },
  });
  await db.tenancy.create({
    data: { id: TENANCY, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "RESYNC-T1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "100" },
  });
  await db.charge.create({
    data: {
      organizationId: ORG, tenancyId: TENANCY, unitId: UNIT, partyId: TENANT, currency: "MYR",
      id: CH_RENT, chargeNumber: "RESYNC-RENT", chargeType: "rent", status: "paid",
      dueDate: new Date(Date.UTC(2026, 6, 5)), amount: "100.00", outstandingAmount: "0.00",
      description: "Rent 202607",
    },
  });
}

/** Overwrite the synced row's amount, choosing who "last touched" it. */
async function corruptRentRow(amount: string, updatedById: string) {
  const db = getDb();
  await db.ownerLedgerEntry.updateMany({
    where: { organizationId: ORG, sourceChargeId: CH_RENT, status: "active" },
    data: { amount, updatedById },
  });
}

async function rentRowAmount(): Promise<string | undefined> {
  const row = await getDb().ownerLedgerEntry.findFirst({
    where: { organizationId: ORG, sourceChargeId: CH_RENT, status: "active" },
  });
  return row?.amount.toString();
}

dn("owner-ledger re-sync — what a backfill repairs", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
    // Establish the sync-owned row the backfill would later revisit.
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    expect(await rentRowAmount()).toBe("100");
  });
  afterAll(async () => { await cleanup(); });

  it("repairs a SYNC-OWNED row in place — no duplicate row is created", async () => {
    await corruptRentRow("200.00", SYNC_ACTOR_ID);
    expect(await rentRowAmount()).toBe("200");

    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);

    const db = getDb();
    const rows = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, sourceChargeId: CH_RENT, status: "active" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount.toString()).toBe("100");
  });

  it("SKIPS an admin-edited row — the wrong figure survives the backfill", async () => {
    // The operational trap: a backfill that reports success has still left
    // every admin-touched row at its old value. These need a human.
    await corruptRentRow("200.00", USER);

    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.skipped).toBeGreaterThan(0);

    expect(await rentRowAmount()).toBe("200");
  });

  it("is idempotent — a second re-sync over correct rows changes nothing", async () => {
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const db = getDb();
    const rows = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, sourceChargeId: CH_RENT, status: "active" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount.toString()).toBe("100");
  });
});
