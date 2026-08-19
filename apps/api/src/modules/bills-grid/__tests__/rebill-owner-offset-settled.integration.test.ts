/**
 * ⚠️ MONEY — a re-Bill must NEVER void an owner invoice the owner has already settled.
 *
 * The incident (UAT, 2026-08-18, IVOWN-0008 → IVOWN-0009): the tenant's rent was collected,
 * `autoOffsetOwnerReceivablesForPaidRent` netted the owner's whole IVOWN out of their payout
 * (one `OWNER_RECEIVABLE_OFFSET` entry + one `OwnerReceivableOffsetAllocation` per charge),
 * and the bills grid duly went green. The admin then added a TENANT expense and re-Billed.
 * The re-Bill's paid-guard reads `PaymentAllocation` — and the offset rail mints none — so
 * it saw an entirely unpaid owner side, credited all five settled charges, CANCELLED
 * IVOWN-0008 and re-minted the same RM 1.29 onto IVOWN-0009. The owner's payable had
 * already absorbed that money, so they were charged twice.
 *
 * The seam is the whole re-Bill (`billService`), not the guard helper: the bug needed the
 * guard, the credit sweep and the document-void step to line up, and a unit test on any one
 * of them passes while the chain still double-bills.
 *
 * Real local Postgres only. Period = the org-local CURRENT month.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/rebill-owner-offset-settled.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, currentBillingMonthUTC } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "b7810000-0000-4000-8000-000000000001";
const USER = "b7810000-0000-4000-8000-000000000002";
const PROP = "b7810000-0000-4000-8000-000000000003";
const APT = "b7810000-0000-4000-8000-000000000004";
const ROOM_A = "b7810000-0000-4000-8000-000000000005";
const PARTY_A = "b7810000-0000-4000-8000-000000000007";
const OWNER_PARTY = "b7810000-0000-4000-8000-000000000009";
const TEN_A = "b7810000-0000-4000-8000-00000000000a";

const PERIOD = currentBillingMonthUTC("Asia/Kuala_Lumpur");
const PERIOD_STR = PERIOD.toISOString().slice(0, 10);
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.ownerReceivableOffsetAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.gridMeterReading.deleteMany({ where: { organizationId: ORG } });
  await db.gridExpense.deleteMany({ where: { organizationId: ORG } });
  await db.gridAttachment.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
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

/** WHOLE unit, owner bears TNB (absorbed) + cleaning + maintenance ⇒ a real IVOWN. */
async function seedEntry(): Promise<void> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG9", slug: "bg9", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg9@example.test", fullName: "BG9 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B9", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B9", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A9", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", cleaning: "80.00",
      tnbPattern: "absorbed", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
}

async function token(): Promise<string> {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
  return e.updatedAt.toISOString();
}
async function amendWifi(wifi: string): Promise<void> {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
  await db.unitBillsGridEntry.update({ where: { id: e.id }, data: { wifi } });
}
async function bill(confirm?: boolean) {
  const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await token(), confirmRebill: confirm }] });
  if (!r.ok) throw new Error("not ok");
  return r.data.results[0];
}

/** The live owner invoice and the charges on it. */
async function ownerInvoice() {
  const db = getDb();
  const doc = await db.billingDocument.findFirstOrThrow({
    where: { organizationId: ORG, counterpartyType: "owner", documentStatus: "ISSUED" },
    select: { id: true, documentNumber: true },
  });
  const lines = await db.billingDocumentLine.findMany({ where: { documentId: doc.id }, select: { id: true, chargeId: true } });
  const charges = await db.charge.findMany({
    where: { id: { in: lines.map((l) => l.chargeId).filter((x): x is string => !!x) } },
    select: { id: true, chargeNumber: true, amount: true, outstandingAmount: true, status: true },
  });
  return { doc, lines, charges };
}

/**
 * Replay what `autoOffsetOwnerReceivablesForPaidRent` leaves behind when the tenant's rent
 * settles the owner's whole IVOWN: ONE active OWNER_RECEIVABLE_OFFSET payout entry, one
 * allocation row per charge, and the charges decremented to zero — with NO Payment and NO
 * PaymentAllocation anywhere, which is the entire point.
 */
async function settleByOwnerOffset(chargeIds: string[]): Promise<string> {
  const db = getDb();
  const charges = await db.charge.findMany({ where: { id: { in: chargeIds } }, select: { id: true, outstandingAmount: true } });
  const totalC = charges.reduce((s, c) => s + Math.round(Number(c.outstandingAmount.toString()) * 100), 0);
  const entry = await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER_PARTY, propertyId: PROP, apartmentId: APT,
      statementMonth: PERIOD, transactionDate: PERIOD,
      direction: "payout", category: "owner_payout", amount: (totalC / 100).toFixed(2),
      paidBy: "kaen", paymentStatus: "paid", status: "active",
      sourceType: "manual", settlementKind: "OWNER_RECEIVABLE_OFFSET",
      memo: "Auto-settled from tenant rent collection",
      createdById: USER, updatedById: USER,
    },
    select: { id: true },
  });
  for (const c of charges) {
    const allocC = Math.round(Number(c.outstandingAmount.toString()) * 100);
    if (allocC <= 0) continue;
    await db.ownerReceivableOffsetAllocation.create({
      data: { organizationId: ORG, offsetEntryId: entry.id, chargeId: c.id, allocatedAmountC: allocC, createdById: USER },
    });
    await db.charge.update({ where: { id: c.id }, data: { outstandingAmount: "0.00", status: "paid" } });
  }
  return entry.id;
}

dn("re-Bill must not void an owner invoice settled by OWNER_RECEIVABLE_OFFSET", () => {
  beforeEach(cleanup);
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    delete process.env.ENABLE_PROFORMA_INVOICES;
    await cleanup();
  });

  it("keeps the settled IVOWN ISSUED, credits nothing on it, and re-mints none of its charges", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_PROFORMA_INVOICES = "true";
    const db = getDb();
    await seedEntry();
    expect((await bill()).outcome).toBe("invoiced");

    const before = await ownerInvoice();
    expect(before.charges.length).toBeGreaterThan(0);
    const settledIds = before.charges.map((c) => c.id);
    await settleByOwnerOffset(settledIds);

    // Sanity: the settlement left NO cash trace — this is exactly what the old guard read.
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG, chargeId: { in: settledIds } } })).toBe(0);

    // Admin amends the TENANT side and re-Bills.
    await amendWifi("240.00");
    expect((await bill()).outcome).toBe("rebill_confirmation_required");
    expect((await bill(true)).outcome).toBe("reinvoiced");

    // 1. The owner's invoice is untouched — NOT cancelled, NOT superseded.
    const after = await db.billingDocument.findUniqueOrThrow({
      where: { id: before.doc.id },
      select: { documentStatus: true, supersededByDocumentId: true, reason: true },
    });
    expect(after.documentStatus).toBe("ISSUED");
    expect(after.supersededByDocumentId).toBeNull();

    // 2. Its charges are still settled — none credited by the re-Bill's sweep.
    const afterCharges = await db.charge.findMany({ where: { id: { in: settledIds } }, select: { status: true, outstandingAmount: true } });
    expect(afterCharges.map((c) => c.status).sort()).toEqual(settledIds.map(() => "paid"));
    expect(afterCharges.every((c) => Number(c.outstandingAmount.toString()) === 0)).toBe(true);

    // 3. Nothing was re-minted for them — the double-bill itself. One live charge per
    //    settled component, not two.
    for (const c of before.charges) {
      const base = c.chargeNumber.replace(/-r\d+$/, "");
      const live = await db.charge.count({
        where: { organizationId: ORG, chargeNumber: { startsWith: base }, status: { notIn: ["void", "credited"] } },
      });
      expect(live, `duplicate mint for ${base}`).toBe(1);
    }

    // 4. The owner's payable was consumed ONCE: Σ(offset allocations) still equals what the
    //    owner is billed across every live owner charge.
    const offsetC = (await db.ownerReceivableOffsetAllocation.findMany({ where: { organizationId: ORG }, select: { allocatedAmountC: true } }))
      .reduce((s, a) => s + a.allocatedAmountC, 0);
    const liveOwnerC = (await db.charge.findMany({
      where: { organizationId: ORG, partyId: OWNER_PARTY, status: { notIn: ["void", "credited"] } },
      select: { amount: true },
    })).reduce((s, c) => s + Math.round(Number(c.amount.toString()) * 100), 0);
    expect(offsetC).toBe(liveOwnerC);
  });

  it("a REVERSED offset does not protect the invoice — the re-Bill supersedes it as normal", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_PROFORMA_INVOICES = "true";
    const db = getDb();
    await seedEntry();
    expect((await bill()).outcome).toBe("invoiced");

    const before = await ownerInvoice();
    const settledIds = before.charges.map((c) => c.id);
    const offsetEntryId = await settleByOwnerOffset(settledIds);

    // reverseOffsetService APPENDS a reversal entry and restores the charges; the ORIGINAL
    // entry deliberately stays `active`, which is why the netting cannot read status alone.
    await db.ownerLedgerEntry.create({
      data: {
        organizationId: ORG, ownerPartyId: OWNER_PARTY, propertyId: PROP, apartmentId: APT,
        statementMonth: PERIOD, transactionDate: PERIOD,
        direction: "payout", category: "owner_payout", amount: "1.00",
        paidBy: "kaen", paymentStatus: "paid", status: "active",
        sourceType: "manual", settlementKind: "OWNER_RECEIVABLE_OFFSET",
        reversalOfEntryId: offsetEntryId, createdById: USER, updatedById: USER,
      },
    });
    for (const c of before.charges) {
      await db.charge.update({ where: { id: c.id }, data: { outstandingAmount: c.amount, status: "posted" } });
    }

    await amendWifi("240.00");
    expect((await bill()).outcome).toBe("rebill_confirmation_required");
    expect((await bill(true)).outcome).toBe("reinvoiced");

    const after = await db.billingDocument.findUniqueOrThrow({ where: { id: before.doc.id }, select: { documentStatus: true } });
    expect(after.documentStatus).toBe("CANCELLED");
  });
});
