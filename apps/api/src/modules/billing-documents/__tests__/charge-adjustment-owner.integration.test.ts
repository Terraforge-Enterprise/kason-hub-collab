/**
 * Task 4 (seam #4) — owner charge-adjustments END-TO-END through the REAL
 * service (not a hand-mint), real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * seams #1-#3 already proved the pieces in isolation:
 *   - owner-adjustment-gap.integration.test.ts (seam #1) hand-mints the note
 *     + calls syncOwnerLedgerForCharges directly to prove the payout nets it.
 *   - charge-adjustment-frozen-period.integration.test.ts (seam #2) proves
 *     assertPeriodOpen blocks a frozen month.
 * This suite is the first to go through createChargeAdjustmentService /
 * voidChargeAdjustmentService THEMSELVES for an owner charge, now that seam
 * #4 has removed the OWNER_ADJUSTMENT_NOT_SUPPORTED / OWNER_VOID_NOT_SUPPORTED
 * 403s — proving seam #1 (payout netting) and seam #4 (guard removal) compose
 * correctly on the real write path, in an OPEN month.
 *
 * Run (localhost DB):
 *   cd apps/api
 *   set -a; . ../../.env; set +a
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_INVOICE_ADJUSTMENTS=true \
 *     ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER=true ENABLE_PHASE2_OWNER_BILLING=true \
 *     ENABLE_PHASE2_BILLING_DOCS=true \
 *     npx vitest run src/modules/billing-documents/__tests__/charge-adjustment-owner.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { createChargeAdjustmentService } from "../charge-adjustment.service";
import { voidChargeAdjustmentService } from "../charge-adjustment-void.service";
import { computeAvailableOwnerPayableC } from "../../owner-remittance/owner-remittance.repository";
import { syncMonthService } from "../../owner-ledger/owner-ledger.sync";
import { syncOwnerLedgerForCharges } from "../../owner-ledger/owner-ledger.sync-hook";
import type { OwnerLedgerActorCtx } from "../../owner-ledger/owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
  process.env.ENABLE_PHASE2_INVOICE_ADJUSTMENTS = "1";
  process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = "1";
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
}

// Fixed disjoint UUIDs (mnemonic prefix o4wn; hex 04a0 — unused by any other suite)
const ORG          = "04a00000-0000-4000-8000-000000000001";
const USER         = "04a00000-0000-4000-8000-000000000002";
const OP_PARTY     = "04a00000-0000-4000-8000-000000000003";
const OWNER        = "04a00000-0000-4000-8000-000000000004";
const PROPERTY     = "04a00000-0000-4000-8000-000000000005";
const APARTMENT    = "04a00000-0000-4000-8000-000000000006";
const LISTING      = "04a00000-0000-4000-8000-000000000007";
const SERIES_IVOWN = "04a00000-0000-4000-8000-000000000008";
const SERIES_CN    = "04a00000-0000-4000-8000-000000000009";
const STMT_INVOICE = "04a00000-0000-4000-8000-00000000000a";
const CHARGE       = "04a00000-0000-4000-8000-00000000000b";
const IVOWN_DOC    = "04a00000-0000-4000-8000-00000000000c";
const CAT          = "04a00000-0000-4000-8000-00000000000d";

// Open month — no OwnerStatementPeriod row is seeded for it, so
// assertPeriodOpen's "no period yet ⇒ allowed" no-op path is what applies.
const MONTH = "2026-08";
const MONTH_START = new Date(Date.UTC(2026, 7, 1));

const SESSION = { orgId: ORG, userId: USER, role: "admin" };
const actor: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.chargeEvent.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.partyRole.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/**
 * Seed an OWNER scenario in an OPEN month: owner Party + a Listing they own,
 * a legacy owner_statement Invoice with ONE management_fee Charge
 * (amount=outstanding="100.00", status "posted"), and an IVOWN
 * BillingDocument (docType "invoice", counterpartyType "owner") with one
 * CATEGORISED line to that Charge — createChargeAdjustmentService requires a
 * non-null categoryId on the linked line (unlike owner-adjustment-gap's
 * hand-mint fixture, which bypasses the service and doesn't need one).
 */
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "O4WN Owner Adjustment E2E Org", slug: "o4wn-owner-adjustment-e2e",
      status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: OP_PARTY, organizationId: ORG, displayName: "O4WN Operator", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "o4wn-operator@example.com", fullName: "O4WN Operator",
      status: "active", role: "admin", userType: "operator", partyId: OP_PARTY,
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "O4WN Owner", partyType: "individual", status: "active" },
  });
  await db.partyRole.create({
    data: { organizationId: ORG, partyId: OWNER, roleType: "owner", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY, organizationId: ORG, name: "O4WN Property", propertyCode: "O4WN-P1",
      propertyType: "apartment", addressLine1: "1 O4WN St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "O4WN-1", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: LISTING, organizationId: ORG, apartmentId: APARTMENT, listingType: "Whole Unit",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER,
    },
  });
  await db.documentSeries.create({
    data: { id: SERIES_IVOWN, organizationId: ORG, code: "IVOWN", prefix: "IVOWN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "mgmt_fee", name: "Management fee",
      family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES_IVOWN,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "utility_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });

  // Legacy owner_statement Invoice — the record owner-ledger.sync.ts's
  // Source-2 reads directly (db.invoice.findMany, NOT BillingDocument).
  await db.invoice.create({
    data: {
      id: STMT_INVOICE, organizationId: ORG, invoiceNumber: "O4WN-STMT-1", partyId: OWNER,
      ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft",
      invoiceDate: MONTH_START, periodMonth: MONTH_START, totalAmount: "100.00", sstAmount: "0.00",
      currency: "MYR", idempotencyKey: `owner:${OWNER}:${MONTH}`,
    },
  });
  await db.charge.create({
    data: {
      id: CHARGE, organizationId: ORG, chargeNumber: "O4WN-CHG-1", unitId: LISTING, partyId: OWNER,
      chargeType: "management_fee", categoryId: CAT, status: "posted", postedAt: new Date(),
      dueDate: MONTH_START, amount: "100.00", currency: "MYR", outstandingAmount: "100.00",
      invoiceId: STMT_INVOICE, billingMonth: MONTH_START,
    },
  });
  await db.billingDocument.create({
    data: {
      id: IVOWN_DOC, organizationId: ORG, docType: "invoice", documentNumber: "IVOWN-0001",
      seriesId: SERIES_IVOWN, status: "issued", issuedById: USER, counterpartyType: "owner",
      partyId: OWNER, propertyId: PROPERTY, apartmentId: APARTMENT, listingId: LISTING,
      billingMonth: MONTH_START, statementInvoiceId: STMT_INVOICE,
      subtotal: "100.00", sstAmount: "0", total: "100.00",
      lines: {
        create: [{ chargeId: CHARGE, categoryId: CAT, description: "Management fee", amount: "100.00", sstRate: 0, sstAmount: 0 }],
      },
    },
  });
}

/** Same read recordRemittanceService/recordOffsetService gate every write on. */
async function readPayableC(): Promise<number> {
  return getDb().$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));
}

dn("owner charge-adjustments end-to-end through the real service (seam #4)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it("owner CN moves payout: create via the service returns 201 with an owner-counterparty note, then the payable rises by 30", async () => {
    const db = getDb();
    const firstSync = await syncMonthService(actor, { ownerPartyId: OWNER, month: MONTH });
    expect(firstSync.ok).toBe(true);
    const payableBefore = await readPayableC();

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: CHARGE, kind: "credit", amount: "30.00", reason: "owner correction",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    expect(result.data.docType).toBe("credit_note");

    const note = await db.billingDocument.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(note.counterpartyType).toBe("owner");

    // Explicit re-sync (the service already fires this post-commit — this call
    // proves the persisted read-state reflects it regardless of that internal hook).
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [CHARGE]);

    const payableAfter = await readPayableC();
    expect(payableAfter).toBe(payableBefore + 3000); // CN → expense down → payable up (Formula-B)
  });

  it("owner void reverts payout: voiding the owner CN in an OPEN month returns 200 and the payable returns to its pre-CN value", async () => {
    const firstSync = await syncMonthService(actor, { ownerPartyId: OWNER, month: MONTH });
    expect(firstSync.ok).toBe(true);
    const payableBaseline = await readPayableC();

    const createResult = await createChargeAdjustmentService(SESSION, {
      chargeId: CHARGE, kind: "credit", amount: "30.00", reason: "owner correction",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    const payableAfterCreate = await readPayableC();
    expect(payableAfterCreate).toBe(payableBaseline + 3000);

    const voidResult = await voidChargeAdjustmentService(SESSION, createResult.data.id, { reason: "test" });
    expect(voidResult.ok).toBe(true);
    if (!voidResult.ok) return;
    expect(voidResult.status).toBe(200);
    expect(voidResult.data.documentStatus).toBe("CANCELLED");

    const payableAfterVoid = await readPayableC();
    expect(payableAfterVoid).toBe(payableBaseline); // reverts to the pre-CN value
  });
});
