/**
 * C2 concurrency-safety tests for owner-ledger.sync.ts.
 *
 * Proves:
 *   1. Two sequential syncMonthService calls for the same (owner, month) with
 *      one owner-borne utility bill produce EXACTLY ONE utility OwnerLedgerEntry.
 *   2. No Prisma P2002 (unique-violation) escapes to the caller — both calls
 *      return { ok: true }.
 *   3. The DB-level unique index
 *      OwnerLedgerEntry_org_sourceType_sourceUtilityBillId_key rejects a
 *      raw duplicate insert, proving the constraint is installed.
 *
 * "RED before C2" means: before the @@unique and advisory lock were added, a
 * race (two concurrent tx each doing findFirst→found-nothing→create) would
 * produce 2 rows or surface a P2002. The sequential proof below is the
 * minimal reproducible shape; the DB-level assertion in test (c) confirms the
 * index is the last line of defence.
 *
 * Run:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *     npx vitest run src/modules/owner-ledger/__tests__/owner-ledger.sync.concurrency.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { syncMonthService } from "../owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration tests must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint from all other integration test suites
// (0c = sync.test, 0b = balance.test, 0f = carpark.test, bb/cc/aa = others).
const ORG  = "0d000000-0000-4000-8000-0000000000a1";
const USER = "0d000000-0000-4000-8000-0000000000a2";
const PARTY = "0d000000-0000-4000-8000-0000000000a3";
const OWNER = "0d000000-0000-4000-8000-0000000000a4";
const PROPERTY = "0d000000-0000-4000-8000-0000000000a6";
const APARTMENT = "0d000000-0000-4000-8000-0000000000a7";

const MONTH = "2026-07";
const MONTH_START = new Date(Date.UTC(2026, 6, 1));

const ctx: OwnerLedgerActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
  ip: "127.0.0.1",
  userAgent: "vitest-concurrency",
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

/** Minimal seed: owner → apartment (no rooms/tenants needed for utility rows). */
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "C2 Concurrency Org",
      slug: "c2-concurrency-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "C2 Operator", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "c2-operator@example.com",
      fullName: "C2 Operator",
      status: "active",
      role: "admin",
      userType: "operator",
      partyId: PARTY,
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "C2 Owner", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "C2 Property",
      propertyCode: "C2-P1",
      propertyType: "apartment",
      addressLine1: "1 C2 St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: {
      id: APARTMENT,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitCode: "C2-A-1",
      listingMode: "WHOLE",
    },
  });
  // ONE listing so the sync can resolve the owner → apartment mapping.
  // ownerPartyId set on the listing so syncMonthService finds the owner's units.
  await db.listing.create({
    data: {
      organizationId: ORG,
      apartmentId: APARTMENT,
      listingType: "whole_unit",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
      ownerPartyId: OWNER,
    },
  });

  // ONE utility bill with a positive owner-borne total. Must be CHARGED — M-1 only
  // gross-sources Source-3 rows for charged bills, and this suite exercises the
  // concurrency idempotency of that booking (one row from two syncs).
  const bill = await db.unitUtilityBill.create({
    data: {
      organizationId: ORG,
      apartmentId: APARTMENT,
      periodMonth: MONTH_START,
      billingMode: "whole",
      tnbTotal: "200.00",
      ownerBorneUtilitiesTotal: "50.00",
      status: "charged",
      createdBy: USER,
    },
  });
  return { billId: bill.id };
}

dn("owner-ledger.sync — C2: concurrency safety + unique-index enforcement", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("(C2-a) two sequential syncs for the same owner+month produce exactly ONE utility OwnerLedgerEntry", async () => {
    const db = getDb();

    // First sync: should create 1 utility entry.
    const first = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.created).toBe(1);

    // Second sync for the SAME (owner, month): MUST NOT create a second row.
    // With the C2 advisory lock + unique index, this MUST update (not create).
    const second = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(second.ok).toBe(true); // no P2002 must escape to the caller
    if (!second.ok) return;
    expect(second.data.created).toBe(0); // no new row inserted

    // The DB must have exactly ONE utility entry — not two. The seed bill carries
    // only tnbTotal (200), so Source 3 books a single utility_tnb row.
    const utilRows = await db.ownerLedgerEntry.count({
      where: { organizationId: ORG, sourceType: "utility_tnb" },
    });
    expect(utilRows).toBe(1);
  });

  it("(C2-b) both sync calls return { ok: true } — P2002 does not escape", async () => {
    // Explicitly assert both return values rather than just the first.
    const [first, second] = await Promise.all([
      syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH }),
      syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH }),
    ]);
    // Both must succeed.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // Total utility rows must be exactly ONE, regardless of race outcome.
    const db = getDb();
    const utilRows = await db.ownerLedgerEntry.count({
      where: { organizationId: ORG, sourceType: "utility_tnb" },
    });
    expect(utilRows).toBe(1);
  });

  it("(C2-c) DB-level unique index rejects a raw duplicate insert on (org, sourceType, sourceUtilityBillId)", async () => {
    const db = getDb();
    const bill = await db.unitUtilityBill.findFirstOrThrow({ where: { organizationId: ORG } });

    // Seed one row manually.
    const baseData = {
      organizationId: ORG,
      ownerPartyId: OWNER,
      propertyId: PROPERTY,
      statementMonth: MONTH_START,
      transactionDate: MONTH_START,
      direction: "expense" as const,
      category: "utilities_tnb",
      amount: "50.00",
      paidBy: "kaen",
      sourceType: "utility",
      sourceUtilityBillId: bill.id,
      status: "active",
      createdById: "00000000-0000-4000-8000-00000000a0a0",
      updatedById: "00000000-0000-4000-8000-00000000a0a0",
    };
    await db.ownerLedgerEntry.create({ data: baseData });

    // A second insert with the SAME (org, sourceType, sourceUtilityBillId) must
    // be rejected by the unique index — the DB is the last line of defence.
    await expect(
      db.ownerLedgerEntry.create({ data: baseData }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
