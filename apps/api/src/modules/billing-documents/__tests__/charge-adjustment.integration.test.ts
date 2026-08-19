/**
 * Phase 3.1 — charge-scoped CREATE credit/debit note (partial amounts),
 * TENANT-ONLY, flag-gated — real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * Mirrors credit-notes.service.ts's DEBIT_ADJUSTMENT branch (increment
 * outstanding, never touch status) and creditPostedChargeTx (mint via
 * issueDocumentTx, ChargeEvent + AuditLog, post-commit ledger/status
 * refresh) but scoped to a caller-chosen PARTIAL amount.
 *
 * Run (localhost DB):
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 ENABLE_PHASE2_INVOICE_ADJUSTMENTS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/charge-adjustment.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { createChargeAdjustmentService } from "../charge-adjustment.service";
import { voidChargeAdjustmentService } from "../charge-adjustment-void.service";
import { buildBillingDocumentPdfModel } from "../pdf.service";
import { remainingCreditByNote } from "../credit-apply.service";
import { getChargeDetail, listCharges } from "../../portal/charges/portal.charges.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
  process.env.ENABLE_PHASE2_INVOICE_ADJUSTMENTS = "1";
}

// Fixed disjoint UUIDs (prefix b750; unused by any other suite)
const ORG = "b7500000-0000-4000-8000-000000000001";
const USER = "b7500000-0000-4000-8000-000000000002";
const TENANT = "b7500000-0000-4000-8000-000000000003";
const OWNER = "b7500000-0000-4000-8000-000000000009";
const CAT = "b7500000-0000-4000-8000-000000000004";
const SERIES_DEP = "b7500000-0000-4000-8000-000000000005";
const SERIES_CN = "b7500000-0000-4000-8000-000000000006";
const SERIES_DN = "b7500000-0000-4000-8000-000000000007";
const SESSION = { orgId: ORG, userId: USER, role: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  // Credit offsetting mints Payment + PaymentAllocation + CreditApplication, so
  // these must be cleared FIRST — they hold FKs into Payment/Charge/Party and
  // would otherwise block the deletes below (and leak across runs).
  await db.creditApplication.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "B750 Charge Adjustment Test Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "b750@test.local", passwordHash: "x", role: "admin",
      fullName: "B750 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "B750 Tenant", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "B750 Owner", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DEP, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DN, organizationId: ORG, code: "DN", prefix: "DN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "utility_tnb", name: "Electricity",
      family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES_DEP,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "utility_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
}

/** Seed a posted charge + an issued invoice document (1 line) for it. counterpartyType defaults tenant. */
async function seedInvoiceCharge(opts: {
  chargeId: string;
  docId: string;
  documentNumber: string;
  description: string;
  amount: string;
  outstanding: string;
  status: string;
  counterpartyType?: "tenant" | "owner";
}) {
  const db = getDb();
  const partyId = (opts.counterpartyType ?? "tenant") === "owner" ? OWNER : TENANT;
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: ORG, chargeNumber: `B750-${opts.chargeId.slice(-6)}`,
      partyId, chargeType: "utility", categoryId: CAT, status: opts.status,
      postedAt: new Date(), description: opts.description, dueDate: new Date("2026-06-30"),
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.outstanding,
      billingMonth: new Date("2026-06-01"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: "invoice",
      documentNumber: opts.documentNumber, seriesId: SERIES_DEP, status: "issued",
      issuedById: USER, counterpartyType: opts.counterpartyType ?? "tenant", partyId,
      billingMonth: new Date("2026-06-01"),
      subtotal: opts.amount, sstAmount: 0, total: opts.amount,
      lines: {
        create: [{
          chargeId: opts.chargeId, categoryId: CAT, description: opts.description,
          amount: opts.amount, sstRate: 0, sstAmount: 0,
        }],
      },
    },
  });
}

// Fixed row ids
const C1 = "b7500000-0000-4000-8000-000000000011";
const D1 = "b7500000-0000-4000-8000-000000000012";
// A SECOND charge + invoice, for the credit-offset cases: the whole point is
// that a credit which cannot reduce its own charge reaches another open one.
const C2 = "b7500000-0000-4000-8000-000000000013";
const D2 = "b7500000-0000-4000-8000-000000000014";

dn("charge-scoped credit/debit note adjustment (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });
  afterAll(cleanup);

  it("B1: debit RM50 on an unpaid Electricity charge (400/400) raises outstanding to 450 and mints a linked debit_note", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9001", description: "Electricity",
      amount: "400.00", outstanding: "400.00", status: "posted",
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "50.00", reason: "meter correction",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    expect(result.data.docType).toBe("debit_note");
    expect(result.data.creditAmount).toBeUndefined();

    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    // Decimal `increment` strips trailing zeros (decimal.js) — codebase
    // convention (correction-adjustments.integration.test.ts) compares via
    // Number(), not exact string equality.
    expect(Number(charge.outstandingAmount.toString())).toBe(450);

    const dnDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(dnDoc.docType).toBe("debit_note");
    expect(dnDoc.originalDocumentId).toBe(D1);
    // Codebase convention (issue.service.integration.test.ts): Decimal.toString()
    // strips trailing zeros — "50", not "50.00".
    expect(dnDoc.total.toString()).toBe("50");

    // refreshDocumentStatusForCharges post-commit call left the invoice sane
    // (partially collected — not fully settled, not corrupted to offset).
    const invoice = await db.billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(invoice.status).not.toBe("offset");
  });

  it("B2: credit RM23 on an unpaid Water charge (123/123) reduces outstanding to 100, mints a credit_note with creditAmount 0.00", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9002", description: "Water",
      amount: "123.00", outstanding: "123.00", status: "posted",
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "23.00", reason: "over-read correction",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.docType).toBe("credit_note");
    // Nothing was actually collected against this unpaid charge, so nothing
    // is spendable — the whole 23 reduces the receivable.
    expect(result.data.creditAmount).toBe("0.00");

    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(100);

    const cnDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(cnDoc.docType).toBe("credit_note");
    expect(cnDoc.originalDocumentId).toBe(D1);
    expect(cnDoc.creditAmount?.toString()).toBe("0");

    // Formula-B adjustedTotal (status.service.ts basis: charge.amount + ΣDN −
    // ΣCN over active notes) reflects the −23 credit.
    const notes = await db.billingDocument.findMany({ where: { organizationId: ORG, originalDocumentId: D1 } });
    const adjusted = notes.reduce(
      (s, n) => (n.docType === "debit_note" ? s + Number(n.total.toString()) : s - Number(n.total.toString())),
      123,
    );
    expect(adjusted).toBe(100);
  });

  it("B3: credit RM30 on a FULLY-PAID charge (100/0) leaves outstanding at 0 and yields a spendable creditAmount of 30.00", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9003", description: "Sewerage",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "30.00", reason: "billed twice",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.creditAmount).toBe("30.00");

    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(0);
    // Spec: credit NEVER touches charge.status.
    expect(charge.status).toBe("paid");
  });

  // ── Offsetting a credit that cannot reduce its own charge ───────────────────
  // The reported bug: crediting an ALREADY-PAID charge left the whole amount
  // sitting on the note as spendable credit that nothing ever spent. The invoice
  // then read "Adjusted 600 / Paid 475 / Balance 175" while the tenant owed 125
  // in substance — and the 50 difference was visible nowhere.
  //
  // A credit raised after payment is money owed BACK, i.e. a credit balance on
  // the customer's account, so the AR treatment is to contra it against that
  // customer's other open items before anything else. These two tests pin both
  // halves: it settles what it can, and what it cannot settle survives as credit.
  it("B3b: credit on a FULLY-PAID charge offsets the party's OTHER open charge instead of stranding", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9031", description: "Electricity",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    // Same tenant, still owed — this is what the credit must find.
    await seedInvoiceCharge({
      chargeId: C2, docId: D2, documentNumber: "DEP-9032", description: "Water",
      amount: "80.00", outstanding: "80.00", status: "posted",
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "30.00", reason: "overbilled electricity",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDb();
    // The credited charge is untouched — it was already settled.
    const c1 = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(c1.outstandingAmount.toString())).toBe(0);
    expect(c1.status).toBe("paid");
    // ...and the open one absorbed the credit: 80 − 30.
    const c2 = await db.charge.findUniqueOrThrow({ where: { id: C2 } });
    expect(Number(c2.outstandingAmount.toString())).toBe(50);
    expect(c2.status).toBe("partially_paid");

    // Applied through the payment rails, not a bare decrement — so every balance
    // in the system (invoice, portal, settlement pills) moves with it.
    const payment = await db.payment.findFirstOrThrow({
      where: { organizationId: ORG, paymentMethod: "credit_note" },
    });
    expect(Number(payment.amount.toString())).toBe(30);
    expect(payment.status).toBe("posted");
    const applications = await db.creditApplication.count({ where: { organizationId: ORG } });
    expect(applications).toBe(1);
  });

  it("B3c: credit larger than the open debt settles it and carries the REST forward as spendable credit", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9033", description: "Electricity",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    await seedInvoiceCharge({
      chargeId: C2, docId: D2, documentNumber: "DEP-9034", description: "Water",
      amount: "10.00", outstanding: "10.00", status: "posted",
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "30.00", reason: "overbilled electricity",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `creditAmount` records what the note was WORTH; the offset then spends part
    // of it. The note's own figure is deliberately not rewritten.
    expect(result.data.creditAmount).toBe("30.00");

    const db = getDb();
    const c2 = await db.charge.findUniqueOrThrow({ where: { id: C2 } });
    expect(Number(c2.outstandingAmount.toString())).toBe(0);
    expect(c2.status).toBe("paid");

    // 30 issued − 10 spent = 20 still available for a future bill.
    const cn = await db.billingDocument.findFirstOrThrow({
      where: { organizationId: ORG, docType: "credit_note" },
      select: { id: true, creditAmount: true },
    });
    const remaining = await remainingCreditByNote(db, ORG, [
      { id: cn.id, creditAmount: Number(cn.creditAmount!.toString()) },
    ]);
    expect(remaining.get(cn.id)).toBe(20);
  });

  it("B3d: credit never crosses to a DIFFERENT party's open charge", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9035", description: "Electricity",
      amount: "100.00", outstanding: "0.00", status: "paid",
    });
    // Owner's debt — the tenant's credit must not touch it.
    await seedInvoiceCharge({
      chargeId: C2, docId: D2, documentNumber: "DEP-9036", description: "Owner repair",
      amount: "80.00", outstanding: "80.00", status: "posted", counterpartyType: "owner",
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "30.00", reason: "overbilled electricity",
    });
    expect(result.ok).toBe(true);

    const db = getDb();
    const c2 = await db.charge.findUniqueOrThrow({ where: { id: C2 } });
    expect(Number(c2.outstandingAmount.toString())).toBe(80);
    expect(await db.creditApplication.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("B4: credit over the cap (charge 100, no prior notes, request 150) is rejected 400 CREDIT_EXCEEDS_ADJUSTABLE and writes nothing", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9004", description: "Aircond",
      amount: "100.00", outstanding: "100.00", status: "posted",
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "150.00", reason: "test overshoot",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("CREDIT_EXCEEDS_ADJUSTABLE");

    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(100);
    const notes = await db.billingDocument.count({ where: { organizationId: ORG, originalDocumentId: D1 } });
    expect(notes).toBe(0);
  });

  it("B5: an OWNER charge now succeeds (seam #4 removed the 403) and mints an owner-counterparty note", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "IVOWN-9005", description: "Management fee",
      amount: "100.00", outstanding: "100.00", status: "posted", counterpartyType: "owner",
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "20.00", reason: "test",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    expect(result.data.docType).toBe("credit_note");

    const db = getDb();
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(80);
    const note = await db.billingDocument.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(note.counterpartyType).toBe("owner");
  });

  it("B7: idempotency replay (same key twice) mints exactly ONE note", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9007", description: "Cleaning",
      amount: "100.00", outstanding: "100.00", status: "posted",
    });
    const idempotencyKey = "b750-replay-key-1";

    const first = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "10.00", reason: "extra cleaning", idempotencyKey,
    });
    const second = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "10.00", reason: "extra cleaning", idempotencyKey,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.id).toBe(first.data.id);

    const db = getDb();
    const notes = await db.billingDocument.count({
      where: { organizationId: ORG, originalDocumentId: D1, docType: "debit_note" },
    });
    expect(notes).toBe(1);
    // The increment ran exactly once too — not double-applied on replay.
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C1 } });
    expect(Number(charge.outstandingAmount.toString())).toBe(110);
  });

  it("B8: a charge in a non-adjustable status (void) is rejected 400 CHARGE_NOT_ADJUSTABLE", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9008", description: "Carpark",
      amount: "50.00", outstanding: "0.00", status: "void",
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "5.00", reason: "test",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("CHARGE_NOT_ADJUSTABLE");
  });

  it("B8b: a nonexistent chargeId (incl. cross-org) is rejected 400 CHARGE_NOT_ADJUSTABLE, never leaking existence", async () => {
    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: "b7500000-0000-4000-8000-0000000000ff", kind: "debit", amount: "5.00", reason: "test",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("CHARGE_NOT_ADJUSTABLE");
  });

  it("B9: a posted charge with no linked invoice line is rejected 400 NO_LINKED_INVOICE", async () => {
    const db = getDb();
    await db.charge.create({
      data: {
        id: C1, organizationId: ORG, chargeNumber: "B750-orphan",
        partyId: TENANT, chargeType: "utility", categoryId: CAT, status: "posted",
        postedAt: new Date(), description: "Orphan charge", dueDate: new Date("2026-06-30"),
        amount: "40.00", currency: "MYR", outstandingAmount: "40.00",
        billingMonth: new Date("2026-06-01"),
      },
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "5.00", reason: "test",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe("NO_LINKED_INVOICE");
  });

  it("B10: invalid amounts (zero, negative, 3dp) are rejected 400 AMOUNT_INVALID", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9010", description: "Wifi",
      amount: "50.00", outstanding: "50.00", status: "posted",
    });
    for (const bad of ["0.00", "-10.00", "10.001", "abc", ""]) {
      const result = await createChargeAdjustmentService(SESSION, {
        chargeId: C1, kind: "debit", amount: bad, reason: "test",
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBe("AMOUNT_INVALID");
    }
    const db = getDb();
    const notes = await db.billingDocument.count({ where: { organizationId: ORG, originalDocumentId: D1 } });
    expect(notes).toBe(0);
  });

  it("B11: the cap nets stacked ACTIVE notes only — a CANCELLED note and a sibling charge's note must not leak in", async () => {
    const db = getDb();
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9011", description: "Electricity",
      amount: "100.00", outstanding: "100.00", status: "posted",
    });
    // Prior ACTIVE debit_note (+50) and ACTIVE credit_note (-20) on C1 → cap = 100+50-20 = 130.
    const priorDn = "b7500000-0000-4000-8000-0000000000d1";
    const priorCn = "b7500000-0000-4000-8000-0000000000d2";
    await db.billingDocument.create({
      data: {
        id: priorDn, organizationId: ORG, docType: "debit_note", documentNumber: "DN-9011a",
        seriesId: SERIES_DN, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
        originalDocumentId: D1, subtotal: "50.00", sstAmount: 0, total: "50.00",
        lines: { create: [{ chargeId: C1, categoryId: CAT, description: "prior DN", amount: "50.00", sstRate: 0, sstAmount: 0 }] },
      },
    });
    await db.billingDocument.create({
      data: {
        id: priorCn, organizationId: ORG, docType: "credit_note", documentNumber: "CN-9011a",
        seriesId: SERIES_CN, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
        originalDocumentId: D1, creditAmount: "20.00", subtotal: "20.00", sstAmount: 0, total: "20.00",
        lines: { create: [{ chargeId: C1, categoryId: CAT, description: "prior CN", amount: "20.00", sstRate: 0, sstAmount: 0 }] },
      },
    });
    // A CANCELLED credit_note (-40) — must be EXCLUDED from the cap (documentStatus filter).
    const cancelledCn = "b7500000-0000-4000-8000-0000000000d3";
    await db.billingDocument.create({
      data: {
        id: cancelledCn, organizationId: ORG, docType: "credit_note", documentNumber: "CN-9011b",
        seriesId: SERIES_CN, status: "issued", documentStatus: "CANCELLED", issuedById: USER,
        counterpartyType: "tenant", partyId: TENANT, originalDocumentId: D1,
        creditAmount: "40.00", subtotal: "40.00", sstAmount: 0, total: "40.00",
        lines: { create: [{ chargeId: C1, categoryId: CAT, description: "cancelled CN", amount: "40.00", sstRate: 0, sstAmount: 0 }] },
      },
    });
    // A sibling charge on the SAME invoice with its own active credit_note (-30) —
    // must be scoped OUT of C1's cap (per-charge line filter, not per-document).
    const C2 = "b7500000-0000-4000-8000-000000000021";
    await db.charge.create({
      data: {
        id: C2, organizationId: ORG, chargeNumber: "B750-sibling", partyId: TENANT,
        chargeType: "utility", categoryId: CAT, status: "posted", postedAt: new Date(),
        description: "Sibling line", dueDate: new Date("2026-06-30"), amount: "60.00",
        currency: "MYR", outstandingAmount: "60.00", billingMonth: new Date("2026-06-01"),
      },
    });
    await db.billingDocumentLine.create({
      data: { documentId: D1, chargeId: C2, categoryId: CAT, description: "Sibling line", amount: "60.00", sstRate: 0, sstAmount: 0 },
    });
    const siblingCn = "b7500000-0000-4000-8000-0000000000d4";
    await db.billingDocument.create({
      data: {
        id: siblingCn, organizationId: ORG, docType: "credit_note", documentNumber: "CN-9011c",
        seriesId: SERIES_CN, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
        originalDocumentId: D1, creditAmount: "30.00", subtotal: "30.00", sstAmount: 0, total: "30.00",
        lines: { create: [{ chargeId: C2, categoryId: CAT, description: "sibling CN", amount: "30.00", sstRate: 0, sstAmount: 0 }] },
      },
    });

    // True cap = 100 (charge) + 50 (active DN) − 20 (active CN) = 130. The
    // cancelled −40 and the sibling's −30 must NOT reduce it.
    const overCap = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "135.00", reason: "over true cap",
    });
    expect(overCap.ok).toBe(false);
    if (overCap.ok) return;
    expect(overCap.error).toBe("CREDIT_EXCEEDS_ADJUSTABLE");

    const withinCap = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "130.00", reason: "at true cap",
    });
    expect(withinCap.ok).toBe(true);
  });

  it("B12: two concurrent credits on the SAME charge, each individually within cap but jointly over it, cannot both fully succeed (row-lock serialization)", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9012", description: "Electricity",
      amount: "100.00", outstanding: "100.00", status: "posted",
    });

    // DISTINCT idempotencyKeys — these represent two genuinely different
    // logical adjustments (different accountants, different reasons) that
    // happen to share a chargeId + amount. Without distinct keys the default
    // chargeId+amountCents-derived key would make the second call collapse
    // into a harmless idempotent replay of the first, defeating the point of
    // this test (which is to exercise the credit-cap race, not idempotency).
    const [a, b] = await Promise.all([
      createChargeAdjustmentService(SESSION, { chargeId: C1, kind: "credit", amount: "60.00", reason: "race A", idempotencyKey: "b750-race-a" }),
      createChargeAdjustmentService(SESSION, { chargeId: C1, kind: "credit", amount: "60.00", reason: "race B", idempotencyKey: "b750-race-b" }),
    ]);

    // At most one of the two individually-under-cap (but jointly over-cap, 60+60=120>100)
    // requests may succeed — the cap must never be double-spent by the race.
    const successes = [a, b].filter((r) => r.ok);
    expect(successes.length).toBe(1);
    const failure = [a, b].find((r) => !r.ok);
    if (failure && !failure.ok) expect(failure.error).toBe("CREDIT_EXCEEDS_ADJUSTABLE");

    const db = getDb();
    const notes = await db.billingDocument.count({ where: { organizationId: ORG, originalDocumentId: D1, docType: "credit_note" } });
    expect(notes).toBe(1);
  });

  it("B13: a caller-supplied idempotencyKey reused across a debit AND a credit on the same charge mints TWO distinct notes (no cross-kind collision)", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9013", description: "Electricity",
      amount: "100.00", outstanding: "100.00", status: "posted",
    });
    const sharedKey = "b750-shared-raw-key";

    const debit = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "10.00", reason: "raise", idempotencyKey: sharedKey,
    });
    const credit = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "5.00", reason: "reduce", idempotencyKey: sharedKey,
    });

    expect(debit.ok).toBe(true);
    expect(credit.ok).toBe(true);
    if (!debit.ok || !credit.ok) return;
    expect(debit.data.docType).toBe("debit_note");
    expect(credit.data.docType).toBe("credit_note");
    expect(debit.data.id).not.toBe(credit.data.id);
  });

  it("B14: a caller-supplied description on a debit note wins verbatim over the auto-derived line description", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9014", description: "Water",
      amount: "50.00", outstanding: "50.00", status: "posted",
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "10.00", reason: "meter correction",
      description: "Water meter over-read correction",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDb();
    const noteLine = await db.billingDocumentLine.findFirstOrThrow({
      where: { documentId: result.data.id, chargeId: C1 },
    });
    expect(noteLine.description).toBe("Water meter over-read correction");
  });

  it("B15: omitting description on a credit note still yields the auto-derived \"Correction: <line desc>\" label", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9015", description: "Water",
      amount: "50.00", outstanding: "50.00", status: "posted",
    });

    const result = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "10.00", reason: "over-read correction",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = getDb();
    const noteLine = await db.billingDocumentLine.findFirstOrThrow({
      where: { documentId: result.data.id, chargeId: C1 },
    });
    expect(noteLine.description).toBe("Correction: Water");
  });
});

// ─── Punch list 2026-08-06: customer-facing CN/DN reflection ─────────────────
// The admin ledger got adjustments right; the tenant-facing surfaces never
// did. These lock the three seams: the render-once PDF cache is invalidated
// on issue AND void, the PDF model carries the notes + adjusted total, and
// the portal readers expose split sums + the adjusted amount.

dn("CN/DN reflection — PDF cache + model + portal readers (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });
  afterAll(cleanup);

  it("issuing a DN clears the invoice's cached pdfKey and the PDF model shows the note + adjusted total", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9101", description: "Electricity",
      amount: "400.00", outstanding: "400.00", status: "posted",
    });
    const db = getDb();
    await db.billingDocument.update({ where: { id: D1 }, data: { pdfKey: "billing-documents/stale.pdf" } });

    const dnRes = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "50.00", reason: "meter correction",
    });
    expect(dnRes.ok).toBe(true);

    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(doc.pdfKey).toBeNull();

    const model = await buildBillingDocumentPdfModel(ORG, D1);
    expect(model).not.toBeNull();
    expect(model!.adjustments).toHaveLength(1);
    expect(model!.adjustments[0]).toMatchObject({ docType: "debit_note", total: "50.00" });
    expect(model!.adjustedTotal).toBe("450.00");
  });

  it("voiding the note clears the pdfKey again and the model returns to unadjusted", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9102", description: "Electricity",
      amount: "400.00", outstanding: "400.00", status: "posted",
    });
    const dnRes = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "50.00", reason: "meter correction",
    });
    expect(dnRes.ok).toBe(true);
    if (!dnRes.ok) return;

    const db = getDb();
    await db.billingDocument.update({ where: { id: D1 }, data: { pdfKey: "billing-documents/stale2.pdf" } });

    const voidRes = await voidChargeAdjustmentService(SESSION, dnRes.data.id, { reason: "raised in error" });
    expect(voidRes.ok).toBe(true);

    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: D1 } });
    expect(doc.pdfKey).toBeNull();

    const model = await buildBillingDocumentPdfModel(ORG, D1);
    expect(model!.adjustments).toHaveLength(0);
    expect(model!.adjustedTotal).toBeNull();
  });

  it("portal readers expose split CN/DN sums and the adjusted amount the tenant should see", async () => {
    await seedInvoiceCharge({
      chargeId: C1, docId: D1, documentNumber: "DEP-9103", description: "Electricity",
      amount: "400.00", outstanding: "400.00", status: "posted",
    });
    const dnRes = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "debit", amount: "50.00", reason: "meter correction",
    });
    expect(dnRes.ok).toBe(true);
    const cnRes = await createChargeAdjustmentService(SESSION, {
      chargeId: C1, kind: "credit", amount: "100.00", reason: "over-billed",
    });
    expect(cnRes.ok).toBe(true);

    const scope = { partyId: TENANT, orgId: ORG };
    const detail = await getChargeDetail(scope, C1);
    expect(detail).not.toBeNull();
    expect(detail!).toMatchObject({
      amount: 400,
      debitNoteTotal: 50,
      creditNoteTotal: 100,
      adjustedAmount: 350,
      outstandingAmount: 350, // 400 + 50 DN − 100 CN reduction
    });

    const list = await listCharges(scope, 1, 20);
    const row = list.data.find((r) => r.id === C1);
    expect(row).toBeDefined();
    expect(row!.adjustedAmount).toBe(350);
    expect(row!.debitNoteTotal).toBe(50);
    expect(row!.creditNoteTotal).toBe(100);
  });

  // ─── The `-SST` sibling ─────────────────────────────────────────────────────
  //
  // Reported 2026-08-17: an admin credited RM 0.50 off a RM 1.00 SST-bearing charge.
  // The credit note correctly declared RM 0.04 of tax relief (subtotal 0.50 + SST
  // 0.04 = 0.54) — but mintExpenseChargesTx holds that tax in a SEPARATE `-SST`
  // sibling Charge, and the adjustment only ever touched the base. The sibling kept
  // its full RM 0.08, so the tenant was asked for 0.58 against a note saying 0.54,
  // and foldTaxLines un-folded the sibling onto its own row (its :110-114 guard
  // exists precisely because of this bug), which is what surfaced it.
  describe("an SST-bearing charge's tax sibling moves with the base", () => {
    const CB = "b7500000-0000-4000-8000-000000000021"; // base   1.00 @ 8%
    const CS = "b7500000-0000-4000-8000-000000000022"; // tax sibling 0.08
    const DS = "b7500000-0000-4000-8000-000000000023"; // their invoice

    /** The two-charge shape mintExpenseChargesTx produces for a withSST expense. */
    async function seedSstPair() {
      const db = getDb();
      const base = {
        organizationId: ORG, partyId: TENANT, chargeType: "expense", categoryId: CAT,
        status: "posted", postedAt: new Date(), dueDate: new Date("2026-06-30"),
        currency: "MYR", billingMonth: new Date("2026-06-01"),
      };
      await db.charge.create({
        data: { ...base, id: CB, chargeNumber: "B750-SSTBASE", description: "Expense with SST",
          amount: "1.00", outstandingAmount: "1.00", sstRate: "8.00" },
      });
      await db.charge.create({
        data: { ...base, id: CS, chargeNumber: "B750-SSTBASE-SST", description: "Expense with SST — SST 8%",
          amount: "0.08", outstandingAmount: "0.08", sstRate: "0.00", parentChargeId: CB },
      });
      await db.billingDocument.create({
        data: {
          id: DS, organizationId: ORG, docType: "invoice", documentNumber: "IVTEN-SST-1",
          seriesId: SERIES_DEP, status: "issued", issuedById: USER, counterpartyType: "tenant",
          partyId: TENANT, billingMonth: new Date("2026-06-01"),
          // isTax is excluded from subtotal; the tax rides the BASE line's own rate.
          subtotal: "1.00", sstAmount: "0.08", total: "1.08",
          lines: {
            create: [
              { chargeId: CB, categoryId: CAT, description: "Expense with SST", amount: "1.00", sstRate: "8.00", sstAmount: "0.08" },
              { chargeId: CS, categoryId: CAT, description: "Expense with SST — SST 8%", amount: "0.08", sstRate: 0, sstAmount: 0, isTax: true },
            ],
          },
        },
      });
    }

    it("MONEY: a credit relieves the sibling by the note's own tax, and the charges foot to the note", async () => {
      await seedSstPair();
      const db = getDb();

      const result = await createChargeAdjustmentService(SESSION, {
        chargeId: CB, kind: "credit", amount: "0.50", reason: "overbilled",
      });
      expect(result.ok).toBe(true);

      const base = await db.charge.findUniqueOrThrow({ where: { id: CB } });
      const sibling = await db.charge.findUniqueOrThrow({ where: { id: CS } });
      expect(base.outstandingAmount.toString()).toBe("0.5");
      // WAS 0.08 — the whole bug. 8% of the surviving 0.50.
      expect(sibling.outstandingAmount.toString()).toBe("0.04");

      // The note's own arithmetic is UNTOUCHED by the extra line: an isTax line is
      // excluded from subtotal and its "0" rate adds nothing to sstAmount.
      const note = await db.billingDocument.findFirstOrThrow({
        where: { organizationId: ORG, docType: "credit_note", originalDocumentId: DS },
        include: { lines: true },
      });
      expect(note.subtotal.toString()).toBe("0.5");
      expect(note.sstAmount.toString()).toBe("0.04");
      expect(note.total.toString()).toBe("0.54");

      // …and what the tenant now owes matches what the note says was relieved.
      const owed = Number(base.outstandingAmount) + Number(sibling.outstandingAmount);
      expect(owed.toFixed(2)).toBe("0.54");

      // The relief landed as a mirrored isTax line pointing at the sibling.
      const taxLine = note.lines.find((l) => l.chargeId === CS);
      expect(taxLine).toBeDefined();
      expect(taxLine!.isTax).toBe(true);
      expect(taxLine!.amount.toString()).toBe("0.04");
    });

    it("MONEY: a debit raises the sibling by its own tax too", async () => {
      await seedSstPair();
      const db = getDb();

      const result = await createChargeAdjustmentService(SESSION, {
        chargeId: CB, kind: "debit", amount: "0.50", reason: "under-billed",
      });
      expect(result.ok).toBe(true);

      const base = await db.charge.findUniqueOrThrow({ where: { id: CB } });
      const sibling = await db.charge.findUniqueOrThrow({ where: { id: CS } });
      expect(base.outstandingAmount.toString()).toBe("1.5");
      expect(sibling.outstandingAmount.toString()).toBe("0.12"); // 8% of 1.50
    });

    // The other half of the same fix (reported 2026-08-17): because the base's note
    // ALREADY moves the sibling, the sibling must not also be adjustable on its own.
    // The two reliefs do not cancel — the Charge clamps at zero outstanding, but both
    // NOTES declare their tax, leaving 0.16 of relief declared against 0.08 of tax.
    it("MONEY: the tax sibling itself is refused — adjusting the base is what moves it", async () => {
      await seedSstPair();
      const db = getDb();

      const result = await createChargeAdjustmentService(SESSION, {
        chargeId: CS, kind: "credit", amount: "0.08", reason: "relieving the same tax twice",
      });
      expect(result).toMatchObject({ ok: false, status: 400, error: "CHARGE_IS_SST_SIBLING" });

      // NOTHING written — the sibling still owes its full tax and no note was minted.
      const sibling = await db.charge.findUniqueOrThrow({ where: { id: CS } });
      expect(sibling.outstandingAmount.toString()).toBe("0.08");
      expect(await db.billingDocument.count({ where: { organizationId: ORG, originalDocumentId: DS } })).toBe(0);
    });

    it("a DEBIT on the tax sibling is refused on the same grounds", async () => {
      await seedSstPair();
      const result = await createChargeAdjustmentService(SESSION, {
        chargeId: CS, kind: "debit", amount: "0.08", reason: "double-billing the same tax",
      });
      expect(result).toMatchObject({ ok: false, status: 400, error: "CHARGE_IS_SST_SIBLING" });
    });

    it("an ORPHAN tax charge — base invoiced elsewhere — stays directly adjustable", async () => {
      // findTaxSibling pairs the two within ONE document, so a tax line whose base
      // sits on another document can never be reached by a mirror. Refusing it would
      // strand a live receivable with no way to correct it.
      const CB2 = "b7500000-0000-4000-8000-000000000024";
      const CS2 = "b7500000-0000-4000-8000-000000000025";
      const DS2 = "b7500000-0000-4000-8000-000000000026";
      const db = getDb();
      const base = {
        organizationId: ORG, partyId: TENANT, chargeType: "expense", categoryId: CAT,
        status: "posted", postedAt: new Date(), dueDate: new Date("2026-06-30"),
        currency: "MYR", billingMonth: new Date("2026-06-01"),
      };
      await db.charge.create({
        data: { ...base, id: CB2, chargeNumber: "B750-ORPHANBASE", description: "Billed elsewhere",
          amount: "1.00", outstandingAmount: "1.00", sstRate: "8.00" },
      });
      await db.charge.create({
        data: { ...base, id: CS2, chargeNumber: "B750-ORPHANBASE-SST", description: "Billed elsewhere — SST 8%",
          amount: "0.08", outstandingAmount: "0.08", sstRate: "0.00", parentChargeId: CB2 },
      });
      // The invoice carries ONLY the tax line — the base was invoiced somewhere else.
      await db.billingDocument.create({
        data: {
          id: DS2, organizationId: ORG, docType: "invoice", documentNumber: "IVTEN-SST-ORPHAN",
          seriesId: SERIES_DEP, status: "issued", issuedById: USER, counterpartyType: "tenant",
          partyId: TENANT, billingMonth: new Date("2026-06-01"),
          subtotal: "0.00", sstAmount: "0.00", total: "0.08",
          lines: {
            create: [
              { chargeId: CS2, categoryId: CAT, description: "Billed elsewhere — SST 8%", amount: "0.08", sstRate: 0, sstAmount: 0, isTax: true },
            ],
          },
        },
      });

      const result = await createChargeAdjustmentService(SESSION, {
        chargeId: CS2, kind: "credit", amount: "0.08", reason: "tax charged in error",
      });
      expect(result.ok).toBe(true);
      const orphan = await db.charge.findUniqueOrThrow({ where: { id: CS2 } });
      expect(orphan.outstandingAmount.toString()).toBe("0");
    });

    it("a charge with NO tax sibling is completely unaffected", async () => {
      await seedInvoiceCharge({
        chargeId: C1, docId: D1, documentNumber: "DEP-NOSST-1", description: "Electricity",
        amount: "400.00", outstanding: "400.00", status: "posted",
      });
      const db = getDb();
      const before = await db.charge.count({ where: { organizationId: ORG } });

      const result = await createChargeAdjustmentService(SESSION, {
        chargeId: C1, kind: "credit", amount: "50.00", reason: "goodwill",
      });
      expect(result.ok).toBe(true);

      const note = await db.billingDocument.findFirstOrThrow({
        where: { organizationId: ORG, docType: "credit_note", originalDocumentId: D1 },
        include: { lines: true },
      });
      // Exactly ONE line — no phantom tax line on a charge that bears no tax.
      expect(note.lines).toHaveLength(1);
      expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(before);
    });
  });
});
