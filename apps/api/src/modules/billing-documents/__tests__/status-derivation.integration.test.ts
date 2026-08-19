/**
 * Read-time badge derivation over real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * Proves the wired endpoints (listBillingDocuments + getBillingDocumentDetail) return the
 * derived fields correctly, list and detail AGREE (R11), and the SST + overpayment-CN
 * corrections from review hold:
 *   • an invoice fully offset by a real CN → FULLY_CREDITED (via legacy `offset`), adjusted 0;
 *   • a fully-PAID SST-bearing invoice → PAID (payment reuses the charge-basis settlement, so
 *     the SST-inclusive total never mis-reads it as Part-paid);
 *   • a full CN on an SST invoice → adjusted 0 on the SST-inclusive display basis;
 *   • an overpayment CN (settles no charge) does NOT reduce or badge the invoice.
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/status-derivation.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import type { ListBillingDocumentsQuery } from "@kason/shared";
import { voidPostedChargeWithCreditNote } from "../credit-notes.service";
import { listBillingDocuments, getBillingDocumentDetail } from "../repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Disjoint UUID prefix 9c31 (unused by any other suite).
const ORG = "9c310000-0000-4000-8000-000000000001";
const USER = "9c310000-0000-4000-8000-000000000002";
const TENANT = "9c310000-0000-4000-8000-000000000003";
const CAT = "9c310000-0000-4000-8000-000000000004";
const SERIES_IV = "9c310000-0000-4000-8000-000000000005";
const SERIES_CN = "9c310000-0000-4000-8000-000000000006";

const LIST_Q: ListBillingDocumentsQuery = { page: 1, pageSize: 50 };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
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
      id: ORG, name: "Status Derivation Test Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "status-deriv@test.local", passwordHash: "x", role: "admin",
      fullName: "Deriv Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "Deriv Tenant", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_IV, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "rental", name: "Monthly rental",
      family: "pay_back_landlord", docType: "invoice", seriesId: SERIES_IV,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
}

/** Seed a charge + its issued INVOICE document (1 line). SST optional; settlement fields settable. */
async function seedInvoice(opts: {
  chargeId: string; docId: string; documentNumber: string;
  amount: string; outstanding: string; chargeStatus: string;
  sstRate?: string; sstAmount?: string; total?: string;
  /** legacy BillingDocument.status (issued|partially_settled|settled|offset). */
  docStatus?: string;
  settlementStatus?: string;
}) {
  const db = getDb();
  const sstAmount = opts.sstAmount ?? "0.00";
  const total = opts.total ?? opts.amount;
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: ORG, chargeNumber: `CHG-${opts.chargeId.slice(0, 8)}`,
      partyId: TENANT, chargeType: "rental", categoryId: CAT, status: opts.chargeStatus,
      postedAt: new Date(), description: "Rent Jul", dueDate: new Date("2026-07-31"),
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.outstanding,
      billingMonth: new Date("2026-07-01"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: "invoice",
      documentNumber: opts.documentNumber, seriesId: SERIES_IV,
      status: opts.docStatus ?? "issued", settlementStatus: opts.settlementStatus ?? "UNPAID",
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      billingMonth: new Date("2026-07-01"), subtotal: opts.amount, sstAmount, total,
      lines: {
        create: [{ chargeId: opts.chargeId, categoryId: CAT, description: "Rent Jul", amount: opts.amount, sstRate: opts.sstRate ?? "0", sstAmount }],
      },
    },
  });
}

dn("read-time status derivation (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });
  afterAll(cleanup);

  it("full credit note → list AND detail both FULLY_CREDITED, adjusted 0 (R11)", async () => {
    const C = "9c310000-0000-4000-8000-000000000011";
    const D = "9c310000-0000-4000-8000-000000000012";
    await seedInvoice({ chargeId: C, docId: D, documentNumber: "IVTEN-9101", amount: "100.00", outstanding: "100.00", chargeStatus: "posted" });
    const r = await voidPostedChargeWithCreditNote({ organizationId: ORG, chargeId: C, reason: "overbilled", actorUserId: USER, actorRole: "admin" });
    expect(r.plainVoid).toBe(false);

    const detail = await getBillingDocumentDetail(ORG, D);
    expect(detail!.derivedPaymentStatus).toBe("FULLY_CREDITED");
    expect(detail!.adjustmentStatus).toBe("FULLY_CREDITED");
    expect(detail!.adjustedTotal).toBe("0.00");
    expect(detail!.creditNoteTotal).toBe("100.00");

    const { items } = await listBillingDocuments(ORG, LIST_Q);
    const listed = items.find((i) => i.id === D);
    expect(listed!.derivedPaymentStatus).toBe(detail!.derivedPaymentStatus); // R11
    expect(listed!.adjustmentStatus).toBe(detail!.adjustmentStatus);
    expect(listed!.adjustedTotal).toBe(detail!.adjustedTotal);
  });

  it("payment status is passed through from settlementStatus (list == detail, R11)", async () => {
    const C = "9c310000-0000-4000-8000-000000000013";
    const D = "9c310000-0000-4000-8000-000000000014";
    await seedInvoice({
      chargeId: C, docId: D, documentNumber: "IVTEN-9102", amount: "100.00", outstanding: "60.00",
      chargeStatus: "partially_paid", docStatus: "partially_settled", settlementStatus: "PARTIALLY_PAID",
    });
    const detail = await getBillingDocumentDetail(ORG, D);
    expect(detail!.derivedPaymentStatus).toBe("PARTIALLY_PAID");
    expect(detail!.adjustedTotal).toBe("100.00");
    const { items } = await listBillingDocuments(ORG, LIST_Q);
    expect(items.find((i) => i.id === D)!.derivedPaymentStatus).toBe("PARTIALLY_PAID");
  });

  it("fully-PAID SST invoice → PAID, not Part-paid (payment reuses the SST-EXCLUSIVE settlement)", async () => {
    // base 100 + 8% SST = 108 total (incl). settlementStatus is the charge basis (excl) = PAID.
    const C = "9c310000-0000-4000-8000-000000000015";
    const D = "9c310000-0000-4000-8000-000000000016";
    await seedInvoice({
      chargeId: C, docId: D, documentNumber: "IVTEN-9103", amount: "100.00", outstanding: "0.00",
      chargeStatus: "paid", sstRate: "8", sstAmount: "8.00", total: "108.00",
      docStatus: "settled", settlementStatus: "PAID",
    });
    const detail = await getBillingDocumentDetail(ORG, D);
    expect(detail!.derivedPaymentStatus).toBe("PAID");
    expect(detail!.adjustedTotal).toBe("108.00");
    const { items } = await listBillingDocuments(ORG, LIST_Q);
    expect(items.find((i) => i.id === D)!.derivedPaymentStatus).toBe("PAID");
  });

  it("full credit note on an SST invoice → FULLY_CREDITED, adjusted 0 (SST-inclusive display nets)", async () => {
    const C = "9c310000-0000-4000-8000-000000000017";
    const D = "9c310000-0000-4000-8000-000000000018";
    await seedInvoice({
      chargeId: C, docId: D, documentNumber: "IVTEN-9104", amount: "100.00", outstanding: "100.00",
      chargeStatus: "posted", sstRate: "8", sstAmount: "8.00", total: "108.00",
    });
    await voidPostedChargeWithCreditNote({ organizationId: ORG, chargeId: C, reason: "SST overbill", actorUserId: USER, actorRole: "admin" });
    const detail = await getBillingDocumentDetail(ORG, D);
    expect(detail!.derivedPaymentStatus).toBe("FULLY_CREDITED"); // via legacy offset, no SST math
    expect(detail!.adjustedTotal).toBe("0.00");
    expect(detail!.creditNoteTotal).toBe("108.00"); // SST-inclusive note total nets the SST-inclusive original
  });

  it("an OVERPAYMENT credit note (settles no charge) does NOT reduce or badge the invoice", async () => {
    const C = "9c310000-0000-4000-8000-000000000019";
    const D = "9c310000-0000-4000-8000-00000000001a";
    const CN = "9c310000-0000-4000-8000-00000000001b";
    await seedInvoice({
      chargeId: C, docId: D, documentNumber: "IVTEN-9105", amount: "100.00", outstanding: "0.00",
      chargeStatus: "paid", docStatus: "settled", settlementStatus: "PAID",
    });
    // Overpayment CN: credit_note linked to the invoice, line settles NO charge (chargeId null, R12a).
    const db = getDb();
    await db.billingDocument.create({
      data: {
        id: CN, organizationId: ORG, docType: "credit_note", documentNumber: "CN-9105", seriesId: SERIES_CN,
        status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
        originalDocumentId: D, creditAmount: "50.00", subtotal: "50.00", sstAmount: "0.00", total: "50.00",
        lines: { create: [{ chargeId: null, categoryId: null, description: "Overpayment credit", amount: "50.00", sstRate: "0", sstAmount: "0.00" }] },
      },
    });
    const detail = await getBillingDocumentDetail(ORG, D);
    expect(detail!.adjustmentStatus).toBe("NONE"); // overpayment CN excluded (not charge-backed)
    expect(detail!.adjustedTotal).toBe("100.00"); // bill NOT reduced
    expect(detail!.derivedPaymentStatus).toBe("PAID");
    const { items } = await listBillingDocuments(ORG, LIST_Q);
    expect(items.find((i) => i.id === D)!.adjustmentStatus).toBe("NONE");
  });

  it("PARTIALLY-credited MULTI-CHARGE (grouped) invoice → NOT FULLY_CREDITED (NEW-1 regression, end-to-end)", async () => {
    // Grouped invoice: electricity RM100 + water RM100 = RM200. Credit ONLY electricity. The CN flow sets
    // the WHOLE document legacy status="offset", but only RM100 is credited — RM100 water is still owed, so
    // it must NOT read "Closed · Fully credited".
    const db = getDb();
    const C_ELEC = "9c310000-0000-4000-8000-00000000001d";
    const C_WATER = "9c310000-0000-4000-8000-00000000001e";
    const D = "9c310000-0000-4000-8000-00000000001f";
    for (const [id, desc] of [[C_ELEC, "Electricity"], [C_WATER, "Water"]] as const) {
      await db.charge.create({
        data: {
          id, organizationId: ORG, chargeNumber: `CHG-${id.slice(-8)}`, partyId: TENANT,
          chargeType: "utility", categoryId: CAT, status: "posted", postedAt: new Date(),
          description: desc, dueDate: new Date("2026-07-31"), amount: "100.00", currency: "MYR",
          outstandingAmount: "100.00", billingMonth: new Date("2026-07-01"),
        },
      });
    }
    await db.billingDocument.create({
      data: {
        id: D, organizationId: ORG, docType: "invoice", documentNumber: "IVTEN-9106", seriesId: SERIES_IV,
        status: "issued", settlementStatus: "UNPAID", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
        billingMonth: new Date("2026-07-01"), subtotal: "200.00", sstAmount: "0.00", total: "200.00",
        lines: {
          create: [
            { chargeId: C_ELEC, categoryId: CAT, description: "Electricity", amount: "100.00", sstRate: "0", sstAmount: "0.00" },
            { chargeId: C_WATER, categoryId: CAT, description: "Water", amount: "100.00", sstRate: "0", sstAmount: "0.00" },
          ],
        },
      },
    });
    // Credit ONLY electricity → whole doc becomes legacy `offset`.
    await voidPostedChargeWithCreditNote({ organizationId: ORG, chargeId: C_ELEC, reason: "elec overbill", actorUserId: USER, actorRole: "admin" });

    const detail = await getBillingDocumentDetail(ORG, D);
    expect(detail!.derivedPaymentStatus).not.toBe("FULLY_CREDITED"); // RM100 water still owed
    expect(detail!.adjustmentStatus).toBe("CREDIT_NOTE_ISSUED");
    expect(detail!.adjustedTotal).toBe("100.00"); // RM200 − RM100 electricity CN
    const { items } = await listBillingDocuments(ORG, LIST_Q);
    expect(items.find((i) => i.id === D)!.derivedPaymentStatus).not.toBe("FULLY_CREDITED");
  });
});
