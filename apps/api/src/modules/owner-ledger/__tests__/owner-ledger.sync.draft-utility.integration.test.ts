/**
 * M-1 — Source 3 books FULL per-category bills ONLY for CHARGED UnitUtilityBills.
 *
 * A DRAFT bill's tenant carve-out charges (Source 4) do not exist yet, so booking
 * the FULL supplier bill as an owner expense would debit the owner the whole bill
 * prematurely (the carve-out income that nets it down is missing). Only
 * status:"charged" bills may produce Source-3 expense rows; draft/void produce none.
 * Flipping draft→charged + re-sync then books the rows that were withheld.
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (0f..).
 */
import { describe, it, expect, afterAll } from "vitest";
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

const ORG = "0f000000-0000-4000-8000-0000000000b1";
const USER = "0f000000-0000-4000-8000-0000000000b2";
const PARTY = "0f000000-0000-4000-8000-0000000000b3";
const OWNER = "0f000000-0000-4000-8000-0000000000b4";
const PROPERTY = "0f000000-0000-4000-8000-0000000000b6";
const APARTMENT = "0f000000-0000-4000-8000-0000000000b7";
const UNIT = "0f000000-0000-4000-8000-0000000000b8";

const MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1));

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
  await db.unitUtilityBill.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** Seed an owner with one apartment+listing and a UnitUtilityBill of the given status. */
async function seedBill(status: string): Promise<string> {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "Draft Util Org", slug: "draft-util-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Draft Util Operator", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "draft-util-op@example.com", fullName: "Draft Util Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Draft Util Owner", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: PROPERTY, organizationId: ORG, name: "Draft Util Property", propertyCode: "DU-P1", propertyType: "apartment", addressLine1: "1 Draft St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "DU-1", listingMode: "PARTITIONED" } });
  await db.listing.create({ data: { id: UNIT, organizationId: ORG, apartmentId: APARTMENT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  const bill = await db.unitUtilityBill.create({
    data: { organizationId: ORG, apartmentId: APARTMENT, periodMonth: MONTH_START, billingMode: "subsidy", tnbTotal: "188.70", airSelangor: "35.74", indahWater: "0.00", cleaning: "0.00", wifi: "200.00", ownerBorneUtilitiesTotal: "424.44", status, createdBy: USER },
  });
  return bill.id;
}

dn("owner-ledger.sync — Source 3 charged-only (M-1)", () => {
  afterAll(async () => {
    await cleanup();
  });

  it("a DRAFT UnitUtilityBill produces NO Source-3 expense rows", async () => {
    await cleanup();
    await seedBill("draft");

    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);

    const utilRows = await getDb().ownerLedgerEntry.findMany({
      where: { organizationId: ORG, sourceType: { startsWith: "utility_" } },
    });
    expect(utilRows).toHaveLength(0);
  });

  it("a CHARGED UnitUtilityBill produces Source-3 expense rows", async () => {
    await cleanup();
    await seedBill("charged");

    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);

    const tnb = await getDb().ownerLedgerEntry.findFirst({
      where: { organizationId: ORG, sourceType: "utility_tnb" },
    });
    expect(tnb).not.toBeNull();
    expect(tnb!.direction).toBe("expense");
    expect(tnb!.category).toBe("utilities_tnb");
    expect(tnb!.amount.toString()).toBe("188.7");
    // tnb + water + wifi → 3 gross rows (indah/cleaning are zero).
    const utilRows = await getDb().ownerLedgerEntry.findMany({
      where: { organizationId: ORG, sourceType: { startsWith: "utility_" } },
    });
    expect(utilRows).toHaveLength(3);
  });

  it("flipping a draft bill to charged + re-sync books the withheld Source-3 rows", async () => {
    await cleanup();
    const billId = await seedBill("draft");

    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(
      await getDb().ownerLedgerEntry.count({ where: { organizationId: ORG, sourceType: { startsWith: "utility_" } } }),
    ).toBe(0);

    // Admin charges the bill (carve-out charges now exist).
    await getDb().unitUtilityBill.update({ where: { id: billId }, data: { status: "charged" } });
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });

    expect(
      await getDb().ownerLedgerEntry.count({ where: { organizationId: ORG, sourceType: "utility_tnb" } }),
    ).toBe(1);
  });
});
