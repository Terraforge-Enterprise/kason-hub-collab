/**
 * Portal owner-statements route — owner-scoped 5-section endpoint (Task 2c-4).
 *
 * SECURITY-CRITICAL integration test (real DB). Proves the owner-privacy
 * boundary: the logged-in portal owner can read ONLY their own POSTED statement.
 *
 *   (a) flag OFF → 404 (no shape leak)
 *   (b) owner A's session on owner A's POSTED statement → 200 + the 5-section shape
 *   (b2) owner A's own DRAFT statement → 404 (post-only gate; identical shape — no data leak)
 *   (c) owner B's session on owner A's statement → 404  ← the point of the task
 *   (d) unknown statement id → 404 (identical shape — no existence leak)
 *   (e) userType guard blocks a non-owner (agent) → 403
 *   (f) owner C (org 2) on owner A's statement (org 1) → 404 (cross-org isolation)
 *
 * Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *   DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *   npx vitest run src/modules/portal/owner-statements/__tests__/portal.owner-statements.routes.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { PortalEnv, PortalSessionPayload } from "../../auth/portal.auth.types";
import { portalUserTypeGuard } from "../../portal.middleware";
import { portalOwnerStatementsRoutes } from "../portal.owner-statements.routes";

const RUN = process.env.RUN_INTEGRATION === "1";

// Disjoint fixed UUIDs (prefix 2c4… — unique to this suite).
const ORG = "2c400000-0000-4000-8000-0000000000a1";
const OWNER_A = "2c400000-0000-4000-8000-0000000000a2";
const OWNER_B = "2c400000-0000-4000-8000-0000000000a3";
const STMT_A = "2c400000-0000-4000-8000-0000000000a4"; // owner_statement Invoice for A (POSTED: "approved")
const STMT_A_DRAFT = "2c400000-0000-4000-8000-0000000000a5"; // owner_statement Invoice for A (DRAFT — post-only gate test)
const UNKNOWN = "2c400000-0000-4000-8000-0000000000ff";
// Cross-org test: org 2 with its own owner C.
const ORG2 = "2c400000-0000-4000-8000-0000000000b1";
const OWNER_C = "2c400000-0000-4000-8000-0000000000b2";

function ownerSession(partyId: string): PortalSessionPayload {
  return {
    userId: `user-${partyId.slice(0, 8)}`,
    orgId: ORG,
    role: "viewer",
    userType: "owner",
    partyId,
    iat: 0,
    absoluteExp: 0,
  };
}

/** Session for an owner that belongs to a DIFFERENT org (cross-org isolation tests). */
function ownerSessionInOrg(partyId: string, orgId: string): PortalSessionPayload {
  return {
    userId: `user-${partyId.slice(0, 8)}`,
    orgId,
    role: "viewer",
    userType: "owner",
    partyId,
    iat: 0,
    absoluteExp: 0,
  };
}

const agentSession: PortalSessionPayload = {
  userId: "user-agent",
  orgId: ORG,
  role: "viewer",
  userType: "agent",
  partyId: "2c400000-0000-4000-8000-0000000000ae",
  iat: 0,
  absoluteExp: 0,
};

/** Build the app exactly as portal/index.ts mounts it: owner-guard + router at /owner. */
function makeApp(session: PortalSessionPayload | null) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.use("/owner/*", portalUserTypeGuard("owner"));
  app.route("/owner", portalOwnerStatementsRoutes);
  return app;
}

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org }); // web-visibility tests (g)/(h) seed these
  await db.unitUtilityBill.deleteMany({ where: org }); // (h) — before apartment (Restrict FK)
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
  // org 2 (cross-org test — no invoices, only party + org)
  await db.party.deleteMany({ where: { organizationId: ORG2 } });
  await db.organization.deleteMany({ where: { id: ORG2 } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Owner Statement Portal Org",
      slug: "owner-statement-portal-org-2c4",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  for (const [id, name] of [
    [OWNER_A, "Owner A"],
    [OWNER_B, "Owner B"],
  ] as const) {
    await db.party.create({
      data: { id, organizationId: ORG, displayName: name, partyType: "individual", status: "active" },
    });
  }
  // Seed org 2 + owner C for cross-org isolation test (f).
  await db.organization.create({
    data: {
      id: ORG2,
      name: "Owner Statement Portal Org 2",
      slug: "owner-statement-portal-org-2c4-2",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: OWNER_C, organizationId: ORG2, displayName: "Owner C", partyType: "individual", status: "active" },
  });

  // owner_statement Invoice belonging to OWNER_A — POSTED ("approved") for happy-path test.
  await db.invoice.create({
    data: {
      id: STMT_A,
      organizationId: ORG,
      invoiceNumber: "OS-2C4-0001",
      partyId: OWNER_A, // bill-to = owner
      ownerPartyId: OWNER_A,
      invoiceType: "owner_statement",
      status: "approved",
      invoiceDate: new Date(Date.UTC(2026, 5, 1)),
      periodMonth: new Date(Date.UTC(2026, 5, 1)),
      totalAmount: "0.00",
      currency: "MYR",
    },
  });
  // DRAFT statement for OWNER_A — post-only gate should block this (case b2).
  await db.invoice.create({
    data: {
      id: STMT_A_DRAFT,
      organizationId: ORG,
      invoiceNumber: "OS-2C4-0002",
      partyId: OWNER_A,
      ownerPartyId: OWNER_A,
      invoiceType: "owner_statement",
      status: "draft",
      invoiceDate: new Date(Date.UTC(2026, 6, 1)),
      periodMonth: new Date(Date.UTC(2026, 6, 1)),
      totalAmount: "0.00",
      currency: "MYR",
    },
  });
}

describe.skipIf(!RUN)("portal GET /owner/statements/:id/sections (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  beforeEach(() => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
  });

  it("(a) flag OFF → 404 (no shape leak)", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    const res = await makeApp(ownerSession(OWNER_A)).request(`/owner/statements/${STMT_A}/sections`);
    expect(res.status).toBe(404);
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
  });

  it("(b) owner A reads owner A's POSTED statement → 200 with the 5-section shape", async () => {
    const res = await makeApp(ownerSession(OWNER_A)).request(`/owner/statements/${STMT_A}/sections`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveProperty("header");
    expect(body.data).toHaveProperty("occupancy");
    expect(body.data).toHaveProperty("payoutSummary");
    expect(body.data).toHaveProperty("incomeBreakdown");
    expect(body.data).toHaveProperty("expenseBreakdown");
    // Owner name resolved from the session owner's Party row.
    expect(body.data.header.ownerName).toBe("Owner A");
  });

  it("(b2) owner A's own DRAFT statement → 404 (post-only gate — no data leak)", async () => {
    // Defense-in-depth: even though owner A owns this draft, the post-only gate
    // blocks access. Identical { error: "not_found" } shape — does not reveal
    // that a draft exists for this owner/month.
    const res = await makeApp(ownerSession(OWNER_A)).request(`/owner/statements/${STMT_A_DRAFT}/sections`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
    expect(body.data).toBeUndefined();
  });

  it("(c) owner B reads owner A's statement → 404 (no data leak)", async () => {
    const res = await makeApp(ownerSession(OWNER_B)).request(`/owner/statements/${STMT_A}/sections`);
    expect(res.status).toBe(404);
    const body = await res.json();
    // Must NOT leak owner A's statement payload.
    expect(body.data).toBeUndefined();
    expect(body.error).toBe("not_found");
  });

  it("(d) unknown statement id → 404 (identical shape — no existence leak)", async () => {
    const res = await makeApp(ownerSession(OWNER_A)).request(`/owner/statements/${UNKNOWN}/sections`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("(e) userType guard blocks an agent → 403", async () => {
    const res = await makeApp(agentSession).request(`/owner/statements/${STMT_A}/sections`);
    expect(res.status).toBe(403);
  });

  it("(g) ENABLE_OWNER_WEB_EXPENSE_HIDE: web shows ONLY tenant-recharge utilities the tenant fully paid; hides owner-borne + unpaid (PDF path unaffected)", async () => {
    const db = getDb();
    const monthStart = new Date(Date.UTC(2026, 5, 1)); // STMT_A.periodMonth (June 2026)
    const base = {
      organizationId: ORG,
      ownerPartyId: OWNER_A,
      statementMonth: monthStart,
      transactionDate: monthStart,
      direction: "expense",
      paidBy: "kaen",
      includeInPayout: true,
      status: "active",
      createdById: OWNER_A, // plain columns (no FK) — any uuid
      updatedById: OWNER_A,
    } as const;
    await db.ownerLedgerEntry.createMany({
      data: [
        { ...base, id: "2c400000-0000-4000-8000-0000000000c1", category: "utilities_tnb", sourceType: "utility_tnb", amount: "400.00", paymentStatus: "paid" }, // SHOW
        { ...base, id: "2c400000-0000-4000-8000-0000000000c2", category: "utilities_tnb", sourceType: "utility_tnb", amount: "300.00", paymentStatus: "pending" }, // hide — tenant unpaid
        { ...base, id: "2c400000-0000-4000-8000-0000000000c3", category: "other_expense", sourceType: "owner_borne_expense", amount: "150.00", paymentStatus: "paid" }, // hide — owner-borne, even PAID
      ],
    });

    try {
      // Flag OFF → owner sees ALL three expenses (byte-identical to before).
      delete process.env.ENABLE_OWNER_WEB_EXPENSE_HIDE;
      const off = await (await makeApp(ownerSession(OWNER_A)).request(`/owner/statements/${STMT_A}/sections`)).json();
      expect(off.data.expenseBreakdown.rows.map((r: { sourceType: string }) => r.sourceType).sort()).toEqual(
        ["owner_borne_expense", "utility_tnb", "utility_tnb"].sort(),
      );

      // Flag ON → only the PAID tenant-recharge utility survives; total recomputed.
      process.env.ENABLE_OWNER_WEB_EXPENSE_HIDE = "1";
      const on = await (await makeApp(ownerSession(OWNER_A)).request(`/owner/statements/${STMT_A}/sections`)).json();
      expect(
        on.data.expenseBreakdown.rows.map((r: { sourceType: string; amount: string; paymentStatus: string }) => ({
          sourceType: r.sourceType,
          amount: r.amount,
          paymentStatus: r.paymentStatus,
        })),
      ).toEqual([{ sourceType: "utility_tnb", amount: "400.00", paymentStatus: "paid" }]);
      expect(on.data.expenseBreakdown.totalExpenses).toBe("400.00");
    } finally {
      delete process.env.ENABLE_OWNER_WEB_EXPENSE_HIDE;
      await db.ownerLedgerEntry.deleteMany({
        where: { id: { in: ["2c400000-0000-4000-8000-0000000000c1", "2c400000-0000-4000-8000-0000000000c2", "2c400000-0000-4000-8000-0000000000c3"] } },
      });
    }
  });

  it("(h) LEAK FIX: an owner-absorbed utility (wifiBearer 'owner') stays hidden on the web even on a 'paid' bill; a recharged one (wifiBearer 'tenant') shows", async () => {
    const db = getDb();
    const monthStart = new Date(Date.UTC(2026, 5, 1));
    const PROP = "2c400000-0000-4000-8000-0000000000d1";
    const APT = "2c400000-0000-4000-8000-0000000000d2";
    const BILL_OWNER = "2c400000-0000-4000-8000-0000000000d3";
    const BILL_TENANT = "2c400000-0000-4000-8000-0000000000d4";
    const L = ["2c400000-0000-4000-8000-0000000000d5", "2c400000-0000-4000-8000-0000000000d6", "2c400000-0000-4000-8000-0000000000d7"];
    await db.property.create({
      data: {
        id: PROP, organizationId: ORG, name: "P-h", propertyCode: "PH-1", propertyType: "condo",
        addressLine1: "1 Jln", city: "KL", country: "MY", status: "active", publishStatus: "draft",
      },
    });
    await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "H-1", listingMode: "WHOLE" } });
    await db.unitUtilityBill.createMany({
      data: [
        { id: BILL_OWNER, organizationId: ORG, apartmentId: APT, billingMode: "whole", tnbTotal: "0.00", wifi: "90.00", wifiBearer: "owner", periodMonth: monthStart, status: "charged", createdBy: OWNER_A },
        { id: BILL_TENANT, organizationId: ORG, apartmentId: APT, billingMode: "whole", tnbTotal: "0.00", wifi: "60.00", wifiBearer: "tenant", periodMonth: new Date(Date.UTC(2026, 4, 1)), status: "charged", createdBy: OWNER_A },
      ],
    });
    const base = {
      organizationId: ORG, ownerPartyId: OWNER_A, statementMonth: monthStart, transactionDate: monthStart,
      direction: "expense", paidBy: "kaen", includeInPayout: true, status: "active", createdById: OWNER_A, updatedById: OWNER_A,
    } as const;
    await db.ownerLedgerEntry.createMany({
      data: [
        { ...base, id: L[0], category: "utilities_tnb", sourceType: "utility_tnb", amount: "400.00", paymentStatus: "paid" }, // always tenant → show
        { ...base, id: L[1], category: "wifi", sourceType: "utility_wifi", amount: "90.00", paymentStatus: "paid", sourceUtilityBillId: BILL_OWNER }, // owner absorbs → HIDE
        { ...base, id: L[2], category: "wifi", sourceType: "utility_wifi", amount: "60.00", paymentStatus: "paid", sourceUtilityBillId: BILL_TENANT }, // recharged → show
      ],
    });

    try {
      process.env.ENABLE_OWNER_WEB_EXPENSE_HIDE = "1";
      const on = await (await makeApp(ownerSession(OWNER_A)).request(`/owner/statements/${STMT_A}/sections`)).json();
      const shown = on.data.expenseBreakdown.rows.map((r: { sourceType: string; amount: string }) => `${r.sourceType}:${r.amount}`).sort();
      expect(shown).toEqual(["utility_tnb:400.00", "utility_wifi:60.00"]); // owner-absorbed wifi 90 hidden
      expect(on.data.expenseBreakdown.totalExpenses).toBe("460.00");
    } finally {
      delete process.env.ENABLE_OWNER_WEB_EXPENSE_HIDE;
      await db.ownerLedgerEntry.deleteMany({ where: { id: { in: L } } });
      await db.unitUtilityBill.deleteMany({ where: { id: { in: [BILL_OWNER, BILL_TENANT] } } });
      await db.apartment.deleteMany({ where: { id: APT } });
      await db.property.deleteMany({ where: { id: PROP } });
    }
  });

  it("(f) owner C (org 2) on owner A's statement (org 1) → 404 (cross-org isolation)", async () => {
    // Proves organizationId: session.orgId filter works independently of ownerPartyId.
    // Owner C is a valid owner in org 2; STMT_A lives in org 1 — should be invisible.
    const res = await makeApp(ownerSessionInOrg(OWNER_C, ORG2)).request(`/owner/statements/${STMT_A}/sections`);
    expect(res.status).toBe(404);
    const body = await res.json();
    // Must NOT leak org 1 statement payload or confirm its existence.
    expect(body.data).toBeUndefined();
    expect(body.error).toBe("not_found");
  });
});
