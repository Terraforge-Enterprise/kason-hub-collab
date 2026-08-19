/**
 * LIVE statement sections — GET /owner-billing/statements/live (NO Invoice).
 *
 * The admin can VIEW the full 5-section statement computed straight from the
 * posted ledger WITHOUT first issuing a statement Invoice ("Issue" now only
 * produces the formal PDF, it is no longer a prerequisite to viewing).
 *
 * Seeds one owner+unit with a single PAID rent charge, runs the REAL owner-ledger
 * sync, then requests the LIVE endpoint through the real ownerBillingRoutes (no
 * service mock) and asserts the 5 sections + real ledger figures — with NO
 * owner_statement Invoice anywhere in the DB (before OR after the read). Also
 * asserts the flag gate (404 while ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER dark).
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (0f..).
 */
import { describe, it, expect, afterAll } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";
import { syncMonthService } from "../../owner-ledger/owner-ledger.sync";
import { ownerBillingRoutes } from "../owner-billing.routes";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "0f000000-0000-4000-8000-0000000000a1";
const USER = "0f000000-0000-4000-8000-0000000000a2";
const PARTY = "0f000000-0000-4000-8000-0000000000a3";
const OWNER = "0f000000-0000-4000-8000-0000000000a4";
const TENANT = "0f000000-0000-4000-8000-0000000000a5";
const PROPERTY = "0f000000-0000-4000-8000-0000000000a6";
const APT = "0f000000-0000-4000-8000-0000000000d1";
const ROOM = "0f000000-0000-4000-8000-0000000000b1";
const TENANCY = "0f000000-0000-4000-8000-0000000000c1";

const MONTH = "2026-06";

const ledgerCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin" as const,
  ip: "127.0.0.1",
  userAgent: "vitest",
};

const managerSession: SessionPayload = {
  userId: USER,
  orgId: ORG,
  role: "manager",
  userType: "operator",
};

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerBillingRoutes);
  return app;
}

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.landlordTenancy.deleteMany({ where: org });
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
    data: { id: ORG, name: "Live Org", slug: "live-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Live Operator", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "live-op@example.com", fullName: "Live Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Live Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Live Tenant", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: PROPERTY, organizationId: ORG, name: "Live Residences", propertyCode: "LVR", propertyType: "apartment", addressLine1: "1 Live St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROPERTY, unitCode: "L-01-01", listingMode: "PARTITIONED" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROPERTY, unitId: ROOM, tenantPartyId: TENANT, tenancyCode: "LVR-T1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "2000.00" } });
  // Single PAID rent charge → collected income 2000.00 after the sync.
  await db.charge.create({ data: { organizationId: ORG, chargeNumber: "LVR-RENT-1", tenancyId: TENANCY, unitId: ROOM, partyId: TENANT, chargeType: "rent", status: "paid", dueDate: new Date(Date.UTC(2026, 5, 5)), amount: "2000.00", currency: "MYR", outstandingAmount: "0.00" } });
}

dn("GET /owner-billing/statements/live — live sections without an Invoice", () => {
  afterAll(async () => {
    await cleanup();
  });

  it("returns the 5 sections computed from the posted ledger with NO owner_statement Invoice", async () => {
    await cleanup();
    await seed();
    const sync = await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: MONTH });
    expect(sync.ok).toBe(true);

    const db = getDb();
    // Precondition: NO owner_statement Invoice exists for this owner/month.
    const before = await db.invoice.count({ where: { organizationId: ORG, invoiceType: "owner_statement" } });
    expect(before).toBe(0);

    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = "1";

    const res = await makeApp(managerSession).request(
      `/statements/live?ownerPartyId=${OWNER}&billingMonth=${MONTH}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // All 5 sections present.
    expect(body.data).toHaveProperty("header");
    expect(body.data).toHaveProperty("occupancy");
    expect(body.data).toHaveProperty("payoutSummary");
    expect(body.data).toHaveProperty("incomeBreakdown");
    expect(body.data).toHaveProperty("expenseBreakdown");

    // Real ledger figures — collected rent 2000.00, no fee, no expenses.
    expect(body.data.incomeBreakdown.totalIncome).toBe("2000.00");
    expect(body.data.incomeBreakdown.totalMgmtFee).toBe("0.00");
    expect(body.data.expenseBreakdown.totalExpenses).toBe("0.00");
    expect(body.data.occupancy.rows).toHaveLength(1);
    expect(body.data.occupancy.rows[0].unitCode).toBe("L-01-01");
    const totalPayout = body.data.payoutSummary.lines.find(
      (l: { label: string }) => l.label === "Total Payout to Owner",
    );
    expect(totalPayout.amount).toBe("2000.00");

    // The live READ never materializes an Invoice.
    const after = await db.invoice.count({ where: { organizationId: ORG, invoiceType: "owner_statement" } });
    expect(after).toBe(0);
  });

  it("404s while ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER is dark (no shape leak)", async () => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = "0";
    const res = await makeApp(managerSession).request(
      `/statements/live?ownerPartyId=${OWNER}&billingMonth=${MONTH}`,
    );
    expect(res.status).toBe(404);
    process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = "1";
  });
});
