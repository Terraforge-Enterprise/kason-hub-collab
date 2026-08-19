/**
 * A DRAFT charge must not reach the tenant on ANY portal surface.
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 * `Charge.status === "draft"` means no document has been issued for it: both
 * issuance paths flip draft → posted at the moment the document goes live
 * (billing-documents/invoice-create.service.ts, billing/auto-draft.service.ts).
 * So a draft charge is money NO ADMIN HAS APPROVED. It was nevertheless
 * reaching tenants, because each portal read invented its own status filter and
 * they disagreed:
 *
 *   dashboard balance aggregate   no status filter at all   → draft in the balance
 *   dashboard upcomingCharges     in ["posted","partial"]   → "partial" isn't a live status
 *   listCharges                   no status filter          → draft listed
 *   getChargeDetail               no status filter          → draft readable by id
 *   getCombinedStatement          not "void"                → draft on the statement
 *
 * This test asserts the rule at EVERY surface at once, so the next reader who
 * adds a portal money endpoint has one place that says what the contract is.
 *
 * ── RED against the pre-fix code (verified, not assumed) ────────────────────
 * Reverting the three read repositories to their pre-fix filters and re-running
 * this file gives 5 failed / 4 passed:
 *   ✗ listCharges            returned ['C11-POSTED','C11-DRAFT','C11-VOID']
 *   ✗ getChargeDetail(draft) returned the row instead of null
 *   ✗ statement total        2400 instead of 100
 *   ✗ dashboard netBalance   2450 instead of 100  ← the reported bug
 *   ✗ dashboard unpaidCount  undefined (the field did not exist)
 *   ✓ the 3 payability cases — the WRITE path was the one place already correct
 *   ✓ the activity feed — its `in: ["posted","partial"]` excluded draft by luck,
 *     while wrongly excluding every partially_paid charge (fixed separately)
 *
 * Real local Postgres only.
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/portal/__tests__/draft-charge-not-tenant-visible.integration.test.ts
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { getChargeDetail, listCharges } from "../charges/portal.charges.repository";
import { getCombinedStatement } from "../charges/portal.statement.repository";
import { submitPayment } from "../charges/portal.charges.service";
import { getDashboardData } from "../dashboard/portal.dashboard.repository";
import { listPayableCharges, validatePaymentAllocationsTx } from "../payments/portal.payments.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Dedicated fixture namespace (c1100000) — cleanup is org-scoped and total.
const ORG = "c1100000-0000-4000-8000-000000000001";
const USER = "c1100000-0000-4000-8000-000000000002";
const PROP = "c1100000-0000-4000-8000-000000000003";
const APT = "c1100000-0000-4000-8000-000000000004";
const UNIT = "c1100000-0000-4000-8000-000000000005";
const TENANT = "c1100000-0000-4000-8000-000000000006";
const TENANCY = "c1100000-0000-4000-8000-000000000007";
const CH_POSTED = "c1100000-0000-4000-8000-00000000000a";
const CH_DRAFT = "c1100000-0000-4000-8000-00000000000b";
const CH_VOID = "c1100000-0000-4000-8000-00000000000c";

const MONTH = "2026-06";
const DUE = new Date("2026-06-15T00:00:00.000Z");

const scope = { partyId: TENANT, orgId: ORG };

async function cleanup() {
  const db = getDb();
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.notification.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/**
 * One tenant holding three charges in the same month:
 *   posted  RM  100.00  — an approved, live receivable      → MUST be visible
 *   draft   RM 2300.00  — un-approved rent, no document yet  → MUST NOT be visible
 *   void    RM   50.00  — cancelled                          → MUST NOT be visible
 *
 * The amounts are deliberately distinct so any leak shows up as a specific,
 * unmistakable number in the balance rather than an off-by-a-bit total.
 */
async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "C11", slug: "c11", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "c11@example.test", fullName: "C11 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "Kason C11", propertyCode: "P-C11", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-01-01", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Draft Probe Tenant", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "T-C11", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2300.00", numberOfPax: 1 } });

  const base = { organizationId: ORG, partyId: TENANT, tenancyId: TENANCY, unitId: UNIT, currency: "MYR", dueDate: DUE, attachmentKeys: [] };
  await db.charge.create({ data: { ...base, id: CH_POSTED, chargeNumber: "C11-POSTED", chargeType: "utility", status: "posted", amount: "100.00", outstandingAmount: "100.00", description: "Approved utility" } });
  await db.charge.create({ data: { ...base, id: CH_DRAFT, chargeNumber: "C11-DRAFT", chargeType: "rent", status: "draft", amount: "2300.00", outstandingAmount: "2300.00", description: "Un-approved rent" } });
  await db.charge.create({ data: { ...base, id: CH_VOID, chargeNumber: "C11-VOID", chargeType: "utility", status: "void", amount: "50.00", outstandingAmount: "50.00", description: "Cancelled" } });
}

dn("a draft charge is invisible on every tenant portal surface", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(cleanup);

  it("GET /charges — lists the posted charge, never the draft or the void one", async () => {
    const res = await listCharges(scope, 1, 50);
    const numbers = res.data.map((c) => c.chargeNumber);
    expect(numbers).toContain("C11-POSTED");
    expect(numbers).not.toContain("C11-DRAFT");
    expect(numbers).not.toContain("C11-VOID");
    expect(res.pagination.total).toBe(1);
  });

  // The endpoint an attacker probes: hiding a row from the list is worthless if
  // the same row is still readable by guessing/replaying its id.
  it("GET /charges/:id — a draft charge id resolves to null, so the route 404s", async () => {
    expect(await getChargeDetail(scope, CH_POSTED)).toBeTruthy();
    expect(await getChargeDetail(scope, CH_DRAFT)).toBeNull();
    expect(await getChargeDetail(scope, CH_VOID)).toBeNull();
  });

  it("GET /charges/statement — the month's total counts only the approved charge", async () => {
    const stmt = await getCombinedStatement(scope, MONTH);
    expect(stmt.total).toBe(100);
    expect(stmt.outstandingTotal).toBe(100);
    const numbers = stmt.groups.flatMap((g) => g.lines.map((l) => l.chargeNumber));
    expect(numbers).toEqual(["C11-POSTED"]);
  });

  // The headline figure on the tenant's Home screen. Pre-fix this returned 2450
  // (100 + 2300 draft + 50 void) — it summed every charge regardless of status.
  it("GET /dashboard — balance is the approved outstanding only, not draft or void", async () => {
    const d = await getDashboardData(scope);
    expect(d.balance.netBalance).toBe(100);
    expect(d.balance.netBalance).not.toBe(2450);
    expect(d.balance.totalCharges).toBe(100);
  });

  it("GET /dashboard — unpaidCount counts approved unpaid charges only", async () => {
    const d = await getDashboardData(scope);
    expect(d.balance.unpaidCount).toBe(1);
  });

  it("GET /dashboard — the activity feed excludes the draft charge", async () => {
    const d = await getDashboardData(scope);
    const numbers = d.upcomingCharges.map((c) => c.chargeNumber);
    expect(numbers).toEqual(["C11-POSTED"]);
  });

  it("GET /payments/payable — a draft charge is not offered for payment", async () => {
    const res = await listPayableCharges(scope, 1, 50);
    const numbers = res.data.map((c) => c.chargeNumber);
    expect(numbers).toEqual(["C11-POSTED"]);
  });

  // Defense in depth: even handed the draft's id directly, the write paths refuse.
  it("POST /charges/:id/pay — paying a draft charge is rejected", async () => {
    const res = await submitPayment({ ...scope, userId: USER }, CH_DRAFT, {
      amount: 2300, paymentMethod: "bank_transfer", referenceNumber: "REF-1",
    } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it("POST /payments — allocating against a draft charge throws CHARGE_NOT_PAYABLE", async () => {
    const db = getDb();
    await expect(
      db.$transaction((tx) =>
        validatePaymentAllocationsTx(tx, {
          organizationId: ORG, partyId: TENANT,
          lines: [{ chargeId: CH_DRAFT, allocatedAmount: 2300 }],
        }),
      ),
    ).rejects.toThrow("CHARGE_NOT_PAYABLE");
  });
});
