/**
 * END-TO-END: the management fee a mid-month tenancy is actually billed.
 *
 * The reported invoice: a RM 5.00 tenancy starting 2026-08-17 is billed RM 2.42
 * of rent (15 of 31 days), but the IVOWN management fee came out at RM 0.54 —
 * 10% of the full contracted RM 5.00 plus SST. The fee base was `rentBase`
 * (Tenancy.monthlyRentAmount verbatim) instead of the rent actually billed.
 *
 * `owner-billing.repository.mgmt-fee-base.test.ts` pins the resolver in
 * isolation; this proves the whole `generateStatementService` path persists the
 * corrected figure — a real Charge row of RM 0.24, with RM 0.02 of SST on the
 * statement — because a unit test on the resolver cannot show that the service
 * actually reads `rentBaseForMonth`.
 *
 * Also pins the no-re-pricing guarantee: a full-month tenancy is untouched, so
 * this fix cannot silently change any existing statement.
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (9c02…).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { getDb } from "@kason/db";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

import { generateStatementService, createFeeConfigService } from "../owner-billing.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  if (!(process.env.ENABLE_PHASE2_OWNER_BILLING === "1" || process.env.ENABLE_PHASE2_OWNER_BILLING === "true")) {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
  }
}

const ORG    = "9c020000-0000-4000-8000-000000000001";
const USER   = "9c020000-0000-4000-8000-000000000002";
const PARTY  = "9c020000-0000-4000-8000-000000000003";
const OWNER  = "9c020000-0000-4000-8000-000000000004";
const PROP   = "9c020000-0000-4000-8000-000000000005";
const APT    = "9c020000-0000-4000-8000-000000000006";
const UNIT   = "9c020000-0000-4000-8000-000000000007";
const TENANCY = "9c020000-0000-4000-8000-000000000008";
const TENANT = "9c020000-0000-4000-8000-000000000009";

/** August 2026 has 31 days; the tenancy starts on the 17th → 15 billable days. */
const BILLING_MONTH = "2026-08";

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.landlordTenancy.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.partyRole.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** One owner, one whole unit, one tenancy — caller picks the start date + rent. */
async function seed(startDate: string, monthlyRentAmount: string) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "9C02 Prorated Org", slug: "9c02-prorated-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "9C02 Operator", partyType: "individual", status: "active" } });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "9c02-operator@example.com", fullName: "9C02 Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "9C02 Owner", partyType: "individual", status: "active" } });
  await db.partyRole.create({ data: { organizationId: ORG, partyId: OWNER, roleType: "owner", status: "active" } });
  await db.property.create({
    data: { id: PROP, organizationId: ORG, name: "9C02 Property", propertyCode: "9C02-P1", propertyType: "apartment", addressLine1: "1 Prorated St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-01-01", listingMode: "WHOLE" } });
  await db.listing.create({
    data: { id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "Whole Unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER },
  });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "BERNICE", partyType: "individual", status: "active" } });
  await db.tenancy.create({
    data: {
      id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: UNIT, tenantPartyId: TENANT,
      tenancyCode: "T-9C02", status: "active", billingStatus: "current",
      startDate: new Date(startDate), monthlyRentAmount,
    },
  });
  await createFeeConfigService(ctx, {
    ownerPartyId: OWNER,
    feeType: "percent",
    feeValue: "10",
    sstPercent: "8",
    isActive: true,
  });
}

async function mgmtFeeCharges(invoiceId: string) {
  return getDb().charge.findMany({
    where: { organizationId: ORG, invoiceId, chargeType: "management_fee" },
    select: { amount: true },
  });
}

dn("generateStatementService — management fee follows the rent actually billed", () => {
  beforeEach(async () => { vi.clearAllMocks(); await cleanup(); });
  afterAll(async () => { await cleanup(); });

  it("mid-month start: RM 5.00 from Aug 17 → fee RM 0.24 + RM 0.02 SST, not RM 0.50 + 0.04", async () => {
    await seed("2026-08-17T00:00:00.000Z", "5.00");

    const r = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Charge.amount is the fee BASE (pre-SST). 10% of the prorated RM 2.42.
    const mgmt = await mgmtFeeCharges(r.data.id);
    expect(mgmt).toHaveLength(1);
    expect(mgmt[0]!.amount.toString()).toBe("0.24"); // was "0.5" — 10% of the full 5.00

    // SST rides on the statement total: 8% of 0.24 = 0.0192 → 0.02 (was 0.04).
    const invoice = await getDb().invoice.findFirstOrThrow({ where: { id: r.data.id } });
    expect(invoice.sstAmount?.toString()).toBe("0.02");
  });

  it("full month is untouched — no existing statement is silently re-priced", async () => {
    await seed("2026-01-01T00:00:00.000Z", "5.00");

    const r = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mgmt = await mgmtFeeCharges(r.data.id);
    expect(mgmt).toHaveLength(1);
    expect(mgmt[0]!.amount.toString()).toBe("0.5"); // 10% of the full RM 5.00, unchanged
  });

  it("a NEXT tenant who has not moved in yet does not erase the month's fee", async () => {
    // Regression: selecting the tenancy by `status:"active"` is a snapshot of
    // NOW. Generating August's statement in September picked the incoming
    // tenant, whose occupancy does not intersect August, so the base prorated
    // to 0.00 and August's fee vanished. Period OVERLAP picks the tenant who
    // actually occupied August — even though that tenancy has since ended.
    await seed("2026-01-01T00:00:00.000Z", "2000.00");
    const db = getDb();
    await db.tenancy.update({
      where: { id: TENANCY },
      data: { endDate: new Date("2026-08-31T00:00:00.000Z"), status: "ended" },
    });
    const nextTenant = "9c020000-0000-4000-8000-00000000000a";
    await db.party.create({ data: { id: nextTenant, organizationId: ORG, displayName: "Next Tenant", partyType: "individual", status: "active" } });
    await db.tenancy.create({
      data: {
        id: "9c020000-0000-4000-8000-00000000000b", organizationId: ORG, propertyId: PROP,
        unitId: UNIT, tenantPartyId: nextTenant, tenancyCode: "T-9C02-NEXT",
        status: "active", billingStatus: "current",
        startDate: new Date("2026-09-01T00:00:00.000Z"), monthlyRentAmount: "2500.00",
      },
    });

    const r = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // August was fully occupied by the departing tenant: 10% of RM 2000.
    const mgmt = await mgmtFeeCharges(r.data.id);
    expect(mgmt).toHaveLength(1);
    expect(mgmt[0]!.amount.toString()).toBe("200");
  });

  it("a unit nobody occupied that month bills NO fee line — not a RM 0.00 one", async () => {
    // A RM 0.00 management_fee row would permanently consume the unit+month
    // no-double-bill slot (findUnvoidedChargeForUnitMonth), so a corrective
    // re-generate could never bill the real fee.
    await seed("2026-09-01T00:00:00.000Z", "5.00"); // starts AFTER August

    const r = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(await mgmtFeeCharges(r.data.id)).toHaveLength(0);
  });

  it("mid-month MOVE-OUT prorates too: RM 3100 ending Aug 10 → fee RM 100.00", async () => {
    await seed("2026-01-01T00:00:00.000Z", "3100.00");
    await getDb().tenancy.update({
      where: { id: TENANCY },
      data: { endDate: new Date("2026-08-10T00:00:00.000Z") },
    });

    const r = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Aug 1–10 inclusive = 10/31 days: 3100 × 10/31 = 1000.00 → 10% = 100.00.
    const mgmt = await mgmtFeeCharges(r.data.id);
    expect(mgmt).toHaveLength(1);
    expect(mgmt[0]!.amount.toString()).toBe("100");
  });
});
