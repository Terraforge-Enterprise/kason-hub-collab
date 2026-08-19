/**
 * Tenant Home "Needs your attention" + un-capped overdue (integration, RUN_INTEGRATION=1).
 *
 * The reported bug (2026-08-16): Home's merged Billing Activity feed rendered
 * `min(5, charges) + min(5, payments)` rows against server-side `take: 5` caps,
 * so a tenant with 6 charges + 1 payment was shown 6 of their 7 rows with no
 * indication anything was missing — while the Balance headline above it (a
 * separate, UN-capped aggregate) stayed correct. The feed was also a truncated
 * copy of the Billing tab, which shows the same lists paginated at 20.
 *
 * Home now renders EXCEPTIONS, not a ledger. That only works if the figures
 * behind those exceptions are authoritative — which is what this pins:
 *
 *   1. balance.overdueAmount / overdueCount are server-side aggregates over
 *      EVERY tenant-visible charge, never a page of them. The Billing page's
 *      Overdue card previously derived this client-side from `/charges?limit=20`,
 *      so a tenant with >20 charges was shown a short overdue total.
 *   2. attention.pendingVerificationPayments surfaces self-submitted transfer
 *      slips awaiting the office. Home previously rendered EVERY payment with a
 *      hardcoded emerald "Paid" badge regardless of status — an unverified slip
 *      and a REJECTED one both read as money received.
 *   3. attention.rejectedPayments carries the refusal reason.
 *
 * Real local Postgres only.
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/portal/__tests__/dashboard-attention.integration.test.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { getDashboardData } from "../dashboard/portal.dashboard.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Dedicated fixture namespace (a77e) — cleanup is org-scoped and total.
const ORG = "a77e0000-0000-4000-8000-000000000001";
const TENANT = "a77e0000-0000-4000-8000-000000000003";
const scope = { partyId: TENANT, orgId: ORG };

const PAST = new Date("2020-01-15T00:00:00.000Z"); // unambiguously overdue
const FUTURE = new Date("2099-01-15T00:00:00.000Z"); // unambiguously not

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.paymentAllocation.deleteMany({ where: { payment: org } }).catch(() => {});
  await db.payment.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedOrg() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "A77E", slug: "a77e-attention", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Attention Tenant", partyType: "individual", status: "active" } });
}

async function addCharge(n: number, dueDate: Date, amount = "100.00") {
  const db = getDb();
  await db.charge.create({
    data: {
      organizationId: ORG, partyId: TENANT, currency: "MYR",
      chargeNumber: `A77E-C${n}`, chargeType: "rent", status: "posted",
      amount, outstandingAmount: amount, dueDate, description: `Charge ${n}`,
    },
  });
}

async function addPayment(n: number, status: string, rejectionReason: string | null = null) {
  const db = getDb();
  await db.payment.create({
    data: {
      organizationId: ORG, partyId: TENANT, currency: "MYR",
      paymentNumber: `A77E-P${n}`, amount: "800.00", status,
      paymentMethod: "bank_transfer", paymentType: "full",
      receivedAt: new Date(Date.UTC(2026, 5, n)), rejectionReason,
    },
  });
}

dn("tenant Home: authoritative overdue + attention items", () => {
  afterEach(cleanup);

  it("overdue is a server-side aggregate over ALL charges, not a page of them", async () => {
    await cleanup();
    await seedOrg();
    // 25 overdue > the 20-row page the Billing card used to sum client-side,
    // and > the 5-row cap the Home feed used to render.
    for (let i = 1; i <= 25; i++) await addCharge(i, PAST);
    for (let i = 26; i <= 28; i++) await addCharge(i, FUTURE);

    const d = await getDashboardData(scope);

    expect(d.balance.overdueCount).toBe(25);
    expect(d.balance.overdueAmount).toBe(2500);
    // The un-capped invariants that already held must keep holding.
    expect(d.balance.unpaidCount).toBe(28);
    expect(d.balance.netBalance).toBe(2800);
  });

  it("a fully-settled past-due charge is not overdue", async () => {
    await cleanup();
    await seedOrg();
    await addCharge(1, PAST);
    const db = getDb();
    await db.charge.update({
      where: { id: (await db.charge.findFirstOrThrow({ where: { chargeNumber: "A77E-C1" } })).id },
      data: { outstandingAmount: "0.00", status: "paid" },
    });

    const d = await getDashboardData(scope);
    expect(d.balance.overdueCount).toBe(0);
    expect(d.balance.overdueAmount).toBe(0);
  });

  it("a self-submitted slip awaiting the office surfaces as pending verification, never as paid", async () => {
    await cleanup();
    await seedOrg();
    await addPayment(1, "pending_approval");
    await addPayment(2, "posted");

    const d = await getDashboardData(scope);

    expect(d.attention.pendingVerificationPayments).toHaveLength(1);
    expect(d.attention.pendingVerificationPayments[0]).toMatchObject({
      paymentNumber: "A77E-P1",
      amount: 800,
    });
    // The settled one is NOT an attention item — nothing is asked of the tenant.
    expect(d.attention.pendingVerificationPayments.map((p) => p.paymentNumber)).not.toContain("A77E-P2");
  });

  it("a refused slip surfaces with the office's reason", async () => {
    await cleanup();
    await seedOrg();
    await addPayment(1, "rejected", "Slip is unreadable — please re-upload");

    const d = await getDashboardData(scope);

    expect(d.attention.rejectedPayments).toHaveLength(1);
    expect(d.attention.rejectedPayments[0]).toMatchObject({
      paymentNumber: "A77E-P1",
      amount: 800,
      rejectionReason: "Slip is unreadable — please re-upload",
    });
  });

  // Rejected payments are never cleaned up and deliberately never block a retry
  // (portal.payments.repository.ts), so this list grows without bound. An
  // unbounded findMany feeding an unbounded render is precisely the bug this
  // whole section replaced — the cap must hold, and it must ANNOUNCE itself.
  it("caps the rejected list and flags the overflow instead of dropping rows silently", async () => {
    await cleanup();
    await seedOrg();
    for (let i = 1; i <= 9; i++) await addPayment(i, "rejected", `Bad slip ${i}`);

    const d = await getDashboardData(scope);

    expect(d.attention.rejectedPayments).toHaveLength(3);
    expect(d.attention.hasMoreUnresolvedPayments).toBe(true);
    // Newest first — an eight-month-old refusal must not displace today's.
    expect(d.attention.rejectedPayments.map((p) => p.paymentNumber)).toEqual([
      "A77E-P9", "A77E-P8", "A77E-P7",
    ]);
  });

  it("does not flag overflow when everything fits", async () => {
    await cleanup();
    await seedOrg();
    for (let i = 1; i <= 3; i++) await addPayment(i, "rejected", `Bad slip ${i}`);

    const d = await getDashboardData(scope);

    expect(d.attention.rejectedPayments).toHaveLength(3);
    expect(d.attention.hasMoreUnresolvedPayments).toBe(false);
  });

  // A shared cap across both kinds would let nine refusals hide a pending slip.
  it("caps each kind independently — refusals never crowd out a pending slip", async () => {
    await cleanup();
    await seedOrg();
    for (let i = 1; i <= 9; i++) await addPayment(i, "rejected", `Bad slip ${i}`);
    await addPayment(20, "pending_approval");

    const d = await getDashboardData(scope);

    expect(d.attention.pendingVerificationPayments).toHaveLength(1);
    expect(d.attention.pendingVerificationPayments[0].paymentNumber).toBe("A77E-P20");
    expect(d.attention.rejectedPayments).toHaveLength(3);
  });

  it("nothing outstanding, nothing pending → attention lists are empty", async () => {
    await cleanup();
    await seedOrg();
    await addCharge(1, FUTURE);
    await addPayment(1, "posted");

    const d = await getDashboardData(scope);

    expect(d.attention.pendingVerificationPayments).toHaveLength(0);
    expect(d.attention.rejectedPayments).toHaveLength(0);
    expect(d.attention.hasMoreUnresolvedPayments).toBe(false);
    expect(d.balance.overdueCount).toBe(0);
  });
});
