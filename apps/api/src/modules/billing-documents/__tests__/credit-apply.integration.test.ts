/**
 * autoApplyOpenCredits — FIFO + idempotency (integration, RUN_INTEGRATION=1).
 *
 * Proves: two open CNs apply OLDEST-first across new charges; re-running the
 * same application (same cn+charge) never double-applies (check-first idem
 * key); Payment(method credit_note) + allocation + CreditApplication rows are
 * written; charge outstanding/status update through the payment rails' math;
 * a CN belonging to a different party never applies to this tenant's charge.
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/credit-apply.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { autoApplyOpenCredits, applyCreditManuallyService } from "../credit-apply.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed disjoint UUIDs (prefix 9c33)
const ORG = "9c330000-0000-4000-8000-000000000001";
const USER = "9c330000-0000-4000-8000-000000000002";
const PROP = "9c330000-0000-4000-8000-0000000000a1";
const APT = "9c330000-0000-4000-8000-0000000000a2";
const ROOM = "9c330000-0000-4000-8000-0000000000a3";
const TENANT = "9c330000-0000-4000-8000-000000000003";
const TEN = "9c330000-0000-4000-8000-000000000004";
const CAT = "9c330000-0000-4000-8000-000000000005";
const SERIES_CN = "9c330000-0000-4000-8000-000000000006";
const SERIES_DEP = "9c330000-0000-4000-8000-000000000007";
const CN_OLD = "9c330000-0000-4000-8000-000000000011";
const CN_NEW = "9c330000-0000-4000-8000-000000000012";
const C_JULY = "9c330000-0000-4000-8000-000000000013";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.creditApplication.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "P3 Credit Apply Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "p3ca@test.local", passwordHash: "x", role: "admin",
      fullName: "P3 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "Credit Tenant", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-9C33", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({
    data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-9C33", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: TENANT },
  });
  // Tenancy — autoApplyOpenCredits keys on tenancyId only, but the row itself
  // still needs a real property/unit per schema (Tenancy.propertyId/unitId NOT NULL).
  await db.tenancy.create({
    data: {
      id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT,
      tenancyCode: "T-9C33", status: "active", billingStatus: "current",
      startDate: new Date(Date.UTC(2026, 0, 1)), monthlyRentAmount: "70.00",
    },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DEP, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "rental", name: "Monthly rental",
      family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES_DEP,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
  // Two open tenant CNs: OLD (2026-06-01, credit 30) then NEW (2026-06-15, credit 50).
  await db.billingDocument.create({
    data: {
      id: CN_OLD, organizationId: ORG, docType: "credit_note", documentNumber: "CN-0001",
      seriesId: SERIES_CN, status: "issued", issuedAt: new Date(Date.UTC(2026, 5, 1)),
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT, tenancyId: TEN,
      creditAmount: "30.00", subtotal: "30.00", sstAmount: 0, total: "30.00",
    },
  });
  await db.billingDocument.create({
    data: {
      id: CN_NEW, organizationId: ORG, docType: "credit_note", documentNumber: "CN-0002",
      seriesId: SERIES_CN, status: "issued", issuedAt: new Date(Date.UTC(2026, 5, 15)),
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT, tenancyId: TEN,
      creditAmount: "50.00", subtotal: "50.00", sstAmount: 0, total: "50.00",
    },
  });
  // The next month's posted charge: RM 70 outstanding.
  await db.charge.create({
    data: {
      id: C_JULY, organizationId: ORG, chargeNumber: "RENT-202607", partyId: TENANT,
      tenancyId: TEN, chargeType: "rental", categoryId: CAT, status: "posted",
      postedAt: new Date(), dueDate: new Date(Date.UTC(2026, 6, 31)),
      amount: "70.00", currency: "MYR", outstandingAmount: "70.00",
      billingMonth: new Date(Date.UTC(2026, 6, 1)),
    },
  });
}

dn("autoApplyOpenCredits (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it("FIFO across 2 CNs: oldest fully consumed first, remainder from the newer", async () => {
    const db = getDb();
    await db.$transaction((tx) => autoApplyOpenCredits(tx, ORG, TEN, [C_JULY], USER));

    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_JULY } });
    expect(Number(charge.outstandingAmount.toString())).toBe(0); // 30 + 40 = 70
    expect(charge.status).toBe("paid");

    const apps = await db.creditApplication.findMany({
      where: { organizationId: ORG },
      orderBy: { appliedAt: "asc" },
      include: { payment: { select: { amount: true, paymentMethod: true, status: true } } },
    });
    expect(apps).toHaveLength(2);
    expect(apps[0]!.creditDocumentId).toBe(CN_OLD); // FIFO: 2026-06-01 first
    expect(Number(apps[0]!.payment.amount.toString())).toBe(30);
    expect(apps[1]!.creditDocumentId).toBe(CN_NEW);
    expect(Number(apps[1]!.payment.amount.toString())).toBe(40); // partial from the newer CN
    expect(apps.every((a) => a.payment.paymentMethod === "credit_note" && a.payment.status === "posted")).toBe(true);
  });

  it("re-running the posting never double-applies (idempotency)", async () => {
    const db = getDb();
    await db.$transaction((tx) => autoApplyOpenCredits(tx, ORG, TEN, [C_JULY], USER));
    await db.$transaction((tx) => autoApplyOpenCredits(tx, ORG, TEN, [C_JULY], USER)); // replay

    const payments = await db.payment.findMany({ where: { organizationId: ORG, paymentMethod: "credit_note" } });
    expect(payments).toHaveLength(2); // still exactly 2 (30 + 40), not 4
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_JULY } });
    expect(Number(charge.outstandingAmount.toString())).toBe(0);
  });

  it("cross-party CN never applies (partyId guard)", async () => {
    const db = getDb();
    const OTHER = "9c330000-0000-4000-8000-0000000000ff";
    await db.party.create({
      data: { id: OTHER, organizationId: ORG, displayName: "Other Tenant", partyType: "individual", status: "active" },
    });
    await db.billingDocument.update({ where: { id: CN_OLD }, data: { partyId: OTHER } });
    await db.billingDocument.update({ where: { id: CN_NEW }, data: { partyId: OTHER } });
    await db.$transaction((tx) => autoApplyOpenCredits(tx, ORG, TEN, [C_JULY], USER));
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_JULY } });
    expect(Number(charge.outstandingAmount.toString())).toBe(70); // untouched
  });

  // Finding 1 (review of fadf2f78): `available = creditAmount − Σ(applications)`
  // was a plain read with no serialization — two concurrent applications
  // against the SAME CN could both read the same available balance and both
  // apply, over-spending the CN. Fix: a `SELECT ... FOR UPDATE` row lock on
  // the CN before recomputing available (lockCreditNoteAndRecomputeAvailable),
  // plus an updatedAt-in-WHERE guard on the charge decrement.
  it("concurrency: 5 concurrent manual applies against ONE CN never let spendable exceed creditAmount (row lock)", async () => {
    const db = getDb();
    const CN_RACE = "9c330000-0000-4000-8000-000000000021";
    await db.billingDocument.create({
      data: {
        id: CN_RACE, organizationId: ORG, docType: "credit_note", documentNumber: "CN-RACE",
        seriesId: SERIES_CN, status: "issued", issuedAt: new Date(Date.UTC(2026, 5, 20)),
        issuedById: USER, counterpartyType: "tenant", partyId: TENANT, tenancyId: TEN,
        creditAmount: "100.00", subtotal: "100.00", sstAmount: 0, total: "100.00",
      },
    });
    // 5 distinct posted charges of the same tenancy, RM30 outstanding each —
    // 150 total demand against 100 available credit.
    const raceChargeIds = Array.from({ length: 5 }, (_, i) => `9c330000-0000-4000-8000-00000000030${i}`);
    for (const [i, chargeId] of raceChargeIds.entries()) {
      await db.charge.create({
        data: {
          id: chargeId, organizationId: ORG, chargeNumber: `RACE-${i}`, partyId: TENANT, tenancyId: TEN,
          chargeType: "rental", categoryId: CAT, status: "posted", postedAt: new Date(),
          dueDate: new Date(Date.UTC(2026, 6, 31)), amount: "30.00", currency: "MYR", outstandingAmount: "30.00",
          billingMonth: new Date(Date.UTC(2026, 6, 1)),
        },
      });
    }

    const settled = await Promise.allSettled(
      raceChargeIds.map((chargeId) =>
        applyCreditManuallyService({ orgId: ORG, userId: USER, role: "admin" }, CN_RACE, { chargeId, amount: "30.00" }),
      ),
    );
    // No rejected promises expected — applyCreditManuallyService returns Result
    // objects for both success and the over-application 400, never throws.
    for (const s of settled) expect(s.status).toBe("fulfilled");
    const outcomes = settled.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof applyCreditManuallyService>>>).value);
    const successes = outcomes.filter((o) => o.ok);
    const failures = outcomes.filter((o) => !o.ok);

    // Deterministic regardless of lock-acquisition order: available starts at
    // 100 and drops by exactly 0 or 30 per applier under the row lock, so
    // EXACTLY 3 of the 5 attempts (90 total) can ever succeed.
    expect(successes).toHaveLength(3);
    expect(failures).toHaveLength(2);
    const totalApplied = successes.reduce((sum, o) => sum + Number((o as { ok: true; data: { applied: string } }).data.applied), 0);
    expect(totalApplied).toBe(90);
    expect(totalApplied).toBeLessThanOrEqual(100); // the spec invariant itself
    for (const f of failures) {
      expect((f as { ok: false; error: string }).error).toBe("AMOUNT_EXCEEDS_AVAILABLE_CREDIT");
    }

    // Cross-check: the CreditApplication/Payment rows on disk agree with what
    // the service reported — no ledger drift from the concurrent writers.
    const apps = await db.creditApplication.findMany({
      where: { organizationId: ORG, creditDocumentId: CN_RACE },
      include: { payment: { select: { amount: true } } },
    });
    expect(apps).toHaveLength(3);
    const dbTotal = apps.reduce((sum, a) => sum + Number(a.payment.amount.toString()), 0);
    expect(dbTotal).toBe(totalApplied);
  });
});
