/**
 * Task 5 — Integration test for findOwnerLedgerRowsForMonth (refactor extraction).
 *
 * Seeds active + voided ledger rows for one owner across TWO apartments, then
 * asserts:
 *   (a) returns only status:"active" rows for the owner+month (voided excluded)
 *   (b) passing an apartmentId returns only that apartment's rows
 *   (c) passing null returns all the owner's active rows for the month
 *
 * Disjoint fixed UUIDs (09..). Real LOCAL postgres; opt-in via RUN_INTEGRATION=1.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { findOwnerLedgerRowsForMonth } from "../owner-statement-sections";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed UUIDs (09 prefix — disjoint from all other integration suites) ──────
const ORG     = "09000000-0000-4000-8000-0000000000a1";
const USER    = "09000000-0000-4000-8000-0000000000a2";
const PARTY   = "09000000-0000-4000-8000-0000000000a3"; // operator party
const OWNER   = "09000000-0000-4000-8000-0000000000a4"; // owner party
const PROP    = "09000000-0000-4000-8000-0000000000a5";
const APT_1   = "09000000-0000-4000-8000-0000000000b1"; // apartment 1
const APT_2   = "09000000-0000-4000-8000-0000000000b2"; // apartment 2

const MONTH_START = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01
const OTHER_MONTH = new Date(Date.UTC(2026, 4, 1)); // 2026-05-01 — different month

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "T5 Org", slug: "t5-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "T5 Operator", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "t5-op@example.com", fullName: "T5 Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "T5 Owner", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "T5 Property", propertyCode: "T5P", propertyType: "apartment", addressLine1: "1 T5 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT_1, organizationId: ORG, propertyId: PROP, unitCode: "T5-01", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APT_2, organizationId: ORG, propertyId: PROP, unitCode: "T5-02", listingMode: "WHOLE" } });

  // Ledger rows for the target month (June 2026):
  //   APT_1: 2 active rows + 1 voided row
  //   APT_2: 1 active row
  // Also 1 active row for a different month (should be excluded by monthStart filter)

  await db.ownerLedgerEntry.createMany({
    data: [
      // APT_1 — active income
      {
        organizationId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROP,
        apartmentId: APT_1,
        statementMonth: MONTH_START,
        transactionDate: MONTH_START,
        direction: "income",
        category: "rental_income",
        amount: "1000.00",
        paidBy: "tenant",
        status: "active",
        createdById: USER,
        updatedById: USER,
      },
      // APT_1 — active expense
      {
        organizationId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROP,
        apartmentId: APT_1,
        statementMonth: MONTH_START,
        transactionDate: MONTH_START,
        direction: "expense",
        category: "utilities_tnb",
        amount: "100.00",
        paidBy: "kaen",
        status: "active",
        createdById: USER,
        updatedById: USER,
      },
      // APT_1 — VOIDED row (must be excluded)
      {
        organizationId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROP,
        apartmentId: APT_1,
        statementMonth: MONTH_START,
        transactionDate: MONTH_START,
        direction: "income",
        category: "rental_income",
        amount: "999.00",
        paidBy: "tenant",
        status: "void",
        createdById: USER,
        updatedById: USER,
      },
      // APT_2 — active income
      {
        organizationId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROP,
        apartmentId: APT_2,
        statementMonth: MONTH_START,
        transactionDate: MONTH_START,
        direction: "income",
        category: "rental_income",
        amount: "800.00",
        paidBy: "tenant",
        status: "active",
        createdById: USER,
        updatedById: USER,
      },
      // Different month — active income (must be excluded by monthStart filter)
      {
        organizationId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROP,
        apartmentId: APT_1,
        statementMonth: OTHER_MONTH,
        transactionDate: OTHER_MONTH,
        direction: "income",
        category: "rental_income",
        amount: "500.00",
        paidBy: "tenant",
        status: "active",
        createdById: USER,
        updatedById: USER,
      },
    ],
  });
}

dn("findOwnerLedgerRowsForMonth", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("(a) returns only status:active rows for the owner+month (voided excluded)", async () => {
    const rows = await findOwnerLedgerRowsForMonth(ctx, OWNER, MONTH_START, null);
    // 3 active June rows (APT_1 income + APT_1 expense + APT_2 income), NOT the void or May
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "active")).toBe(true);
    expect(rows.every((r) => r.ownerPartyId === OWNER)).toBe(true);
    const months = rows.map((r) => r.statementMonth.toISOString().slice(0, 7));
    expect(months.every((m) => m === "2026-06")).toBe(true);
  });

  it("(b) passing an apartmentId returns only that apartment's active rows", async () => {
    const rows = await findOwnerLedgerRowsForMonth(ctx, OWNER, MONTH_START, APT_1);
    // APT_1 has 2 active rows (income 1000 + expense 100); void excluded
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.apartmentId === APT_1)).toBe(true);
    expect(rows.every((r) => r.status === "active")).toBe(true);
  });

  it("(c) passing null returns all the owner's active rows for the month (both apartments)", async () => {
    const rows = await findOwnerLedgerRowsForMonth(ctx, OWNER, MONTH_START, null);
    // 3 active June rows across both apartments
    expect(rows).toHaveLength(3);
    const apartmentIds = new Set(rows.map((r) => r.apartmentId));
    expect(apartmentIds.has(APT_1)).toBe(true);
    expect(apartmentIds.has(APT_2)).toBe(true);
  });
});
