/**
 * "Post charges" × accounting documents (spec §4.2 mint-on-post, §4.6 abort).
 * Real local Postgres.
 * Run: RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 npx vitest run src/modules/meter/__tests__/charge-bill-documents.integration.test.ts
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { chargeUtilityBillService, createReadingService, createUtilityBillService } from "../service";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c7000000-0000-4000-8000-000000000001";
const USER = "c7000000-0000-4000-8000-000000000002";
const PROP = "c7000000-0000-4000-8000-000000000003";
const APT = "c7000000-0000-4000-8000-000000000004";
const ROOM = "c7000000-0000-4000-8000-000000000005";
const PARTY = "c7000000-0000-4000-8000-000000000006";
const TEN = "c7000000-0000-4000-8000-000000000007";
const sess = { orgId: ORG, userId: USER, role: "manager", userType: "operator" };

async function cleanup() {
  const db = getDb();
  // Credit-apply rows (Finding 2 test seeds a CN + lets auto-apply mint
  // Payment/CreditApplication rows) — CreditApplication RESTRICTs both
  // BillingDocument and Payment, so it must go first.
  await db.creditApplication.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.utilityAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.meterReading.deleteMany({ where: { organizationId: ORG } });
  await db.aircondMeter.deleteMany({ where: { organizationId: ORG } });
  await db.unitUtilityBill.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.utilityBillingConfig.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "M2D", slug: "m2d", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "m2d@example.test", fullName: "M2D Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-7", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-7", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: PARTY } });

  // ENABLE_PHASE2_OWNER_BILLING gates assertOwnerBillingReady, which refuses to post
  // charges for a unit whose owner has no ACTIVE management-fee config
  // (OwnerBillingNotReadyError -> 422 OWNER_BILLING_NOT_CONFIGURED). The flag is on in
  // this repo's api .env, so without a config every charge-posting test in this file
  // failed on a precondition rather than on the behaviour it was written to check.
  // Seed the minimal config; effectiveFrom/To null = always in window.
  await db.managementFeeConfig.create({ data: { organizationId: ORG, ownerPartyId: PARTY, feeType: "percent", feeValue: "10.00", isActive: true } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: PARTY, tenancyCode: "T-7", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
}

/** A bill whose tenant utility charge has MULTIPLE non-zero components: no aircond
 * reading (so the aircond kWh never consumes the TNB pool → electricity stays > 0)
 * and both TNB + Air Selangor pooled to the single occupied room. Yields a utility
 * charge = electricity + water, the minimum needed to prove itemization splits it. */
async function makeMultiUtilityBill(): Promise<string> {
  const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "30.00", airSelangor: "6.50" });
  expect(bill.ok).toBe(true);
  return (bill as { data: { id: string } }).data.id;
}

async function makeDraftBill(): Promise<string> {
  const db = getDb();
  await db.aircondMeter.upsert({
    where: { organizationId_unitId: { organizationId: ORG, unitId: ROOM } },
    update: {},
    create: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true },
  });
  const rd = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.35" });
  expect(rd.ok).toBe(true);
  const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "24.21", airSelangor: "6.50", cleaning: "100.00" });
  expect(bill.ok).toBe(true);
  return (bill as { data: { id: string } }).data.id;
}

dn("Post charges → billing documents (integration)", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    await cleanup();
    await seed();
  });
  afterEach(() => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
  });

  it("flag ON: the SAME request mints one DEP debit note per created charge (utility, rent, aircond)", async () => {
    const db = getDb();
    const billId = await makeDraftBill();
    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(true);
    const docs = await db.billingDocument.findMany({ where: { organizationId: ORG }, include: { lines: true } });
    expect(docs).toHaveLength(3); // utility + rent + aircond (no carpark assignments seeded)
    for (const d of docs) {
      expect(d.docType).toBe("debit_note");
      expect(d.counterpartyType).toBe("tenant");
      // Rent + aircond are single-line; the pooled utility doc is now itemized
      // (one line per non-zero utility component) — every line still ties to a charge.
      expect(d.lines.length).toBeGreaterThanOrEqual(1);
      for (const l of d.lines) expect(l.chargeId).toBeTruthy();
    }
    const chargeIds = (await db.charge.findMany({ where: { organizationId: ORG }, select: { id: true } })).map((c) => c.id);
    // Each document maps to exactly one charge (all of a doc's lines share it), so the
    // per-doc charge id set still equals the created charges (utility, rent, aircond).
    expect([...new Set(docs.map((d) => d.lines[0].chargeId))].sort()).toEqual(chargeIds.sort());
    for (const d of docs) {
      expect(new Set(d.lines.map((l) => l.chargeId)).size).toBe(1);
    }
  });

  it("flag ON: the pooled utility charge issues as an itemized document — one line per non-zero utility component, footing exactly", async () => {
    const db = getDb();
    const billId = await makeMultiUtilityBill();
    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(true);

    // The receivable stays a SINGLE utility Charge (void/credit/owner-ledger unaffected)…
    const utilCharge = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeType: "utility" } });
    const alloc = await db.utilityAllocation.findFirstOrThrow({ where: { organizationId: ORG, chargeId: utilCharge.id } });
    // …but its document is split into one line per non-zero pooled component.
    const utilLines = await db.billingDocumentLine.findMany({ where: { chargeId: utilCharge.id } });

    const expectedNonZero = (
      [
        ["Electricity (TNB)", Number(alloc.tnbShare)],
        ["Water (Air Selangor)", Number(alloc.airSelangorShare)],
        ["Sewerage (Indah Water)", Number(alloc.indahShare)],
        ["WiFi", Number(alloc.wifiShare)],
        ["Cleaning", Number(alloc.cleaningShare)],
        ["Subsidy", -Number(alloc.subsidyDeduction)],
      ] as [string, number][]
    ).filter(([, amt]) => Math.round(amt * 100) !== 0);

    // Genuinely itemized (this fixture bills water + cleaning at minimum), not a lump.
    expect(utilLines.length).toBe(expectedNonZero.length);
    expect(utilLines.length).toBeGreaterThan(1);

    // Every line carries the parent charge id (settlement traceability) and none is the
    // old merged "Shared utilities" lump label.
    for (const l of utilLines) {
      expect(l.chargeId).toBe(utilCharge.id);
      expect(l.description).not.toContain("Shared utilities");
    }
    // Each component appears once with its own amount + description.
    const byLabel = new Map(utilLines.map((l) => [l.description.replace(/ \d{6}$/, ""), Number(l.amount)]));
    for (const [label, amt] of expectedNonZero) {
      expect(byLabel.get(label)).toBeCloseTo(amt, 2);
    }

    // Foots: Σ line amounts === charge amount === document total, SST 0 (disbursement).
    const lineSum = utilLines.reduce((s, l) => s + Number(l.amount), 0);
    expect(lineSum).toBeCloseTo(Number(utilCharge.amount), 2);
    const doc = await db.billingDocument.findFirstOrThrow({ where: { id: utilLines[0].documentId } });
    expect(Number(doc.total)).toBeCloseTo(Number(utilCharge.amount), 2);
    expect(Number(doc.sstAmount)).toBe(0);
  });

  it("flag OFF: charges post exactly as before with ZERO documents (byte-identical legacy path)", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const db = getDb();
    const billId = await makeDraftBill();
    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(true);
    expect((charged as { data: { utilityCharges: number; aircondCharges: number } }).data).toEqual({ billId, utilityCharges: 1, aircondCharges: 1 });
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(3);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("a document-layer failure ABORTS the posting: no charges, no documents, bill stays draft (spec §4.6)", async () => {
    const db = getDb();
    // Poison the registry BEFORE posting: pre-create "utility_tnb" routed to a
    // credit_note (CNs require originalDocumentId → issueDocumentTx throws).
    // ensureChargeCategorySeeds is create-only (upsert update: {}), so this row
    // survives the in-tx re-seed.
    const dep = await db.documentSeries.upsert({
      where: { organizationId_code: { organizationId: ORG, code: "DEP" } },
      update: {},
      create: { organizationId: ORG, code: "DEP", prefix: "DEP" },
    });
    await db.chargeCategory.create({
      data: {
        organizationId: ORG, code: "utility_tnb", name: "Utilities (poisoned)", family: "pay_back_landlord",
        docType: "credit_note", seriesId: dep.id, defaultSstRate: "0", eInvoiceEligible: false,
        isSystem: true, active: true, sortOrder: 1,
      },
    });
    const billId = await makeDraftBill();
    await expect(chargeUtilityBillService(sess, billId, {})).rejects.toThrow("DOCUMENT_REFERENCE_REQUIRED");
    // The WHOLE posting rolled back — nothing half-committed.
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
    const bill = await db.unitUtilityBill.findUniqueOrThrow({ where: { id: billId }, select: { status: true } });
    expect(bill.status).toBe("draft");
  });

  // Finding 2 (review of fadf2f78): chargeUtilityBillService's post-commit block
  // only synced the owner ledger — when credit auto-apply settled the
  // freshly-minted charges in the SAME posting, their DEP documents were
  // never refreshed and stayed stuck at 'issued' even though the charge was
  // fully paid. Fix: collect autoApplyOpenCredits' returned charge ids and
  // call refreshDocumentStatusForCharges on them post-commit.
  it("credit auto-apply fully covering the new charges also settles their DEP documents", async () => {
    const db = getDb();
    await ensureChargeCategorySeeds(ORG); // idempotent — creates the CN series this fixture needs
    const cnSeries = await db.documentSeries.findFirstOrThrow({ where: { organizationId: ORG, code: "CN" } });
    await db.billingDocument.create({
      data: {
        organizationId: ORG, docType: "credit_note", documentNumber: "CN-0001",
        seriesId: cnSeries.id, status: "issued", issuedAt: new Date(),
        issuedById: USER, counterpartyType: "tenant", partyId: PARTY, tenancyId: TEN,
        creditAmount: "5000.00", subtotal: "5000.00", sstAmount: 0, total: "5000.00",
      },
    });
    const billId = await makeDraftBill();
    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(true);

    const debitNotes = await db.billingDocument.findMany({ where: { organizationId: ORG, docType: "debit_note" } });
    expect(debitNotes.length).toBeGreaterThan(0); // utility + rent + aircond, per the flag-ON test above
    for (const d of debitNotes) {
      expect(d.status).toBe("settled");
    }
    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    for (const c of charges) {
      expect(Number(c.outstandingAmount.toString())).toBe(0);
      expect(c.status).toBe("paid");
    }
  });
});
