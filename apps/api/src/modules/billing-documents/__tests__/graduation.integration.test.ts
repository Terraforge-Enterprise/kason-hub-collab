/**
 * Graduation (spec R3) + the receipt gap it rides with.
 *
 * A proforma is a request for payment. When money arrives, the lines it paid for become
 * a REAL invoice, and that invoice gets its receipt. Both now run from
 * afterPaymentSettled, so EVERY settlement path gets them — including postPaymentService,
 * which is how a tenant's portal FPX payment settles and which previously minted no
 * receipt at all.
 *
 * Real local Postgres. Run (from apps/api):
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 ENABLE_PROFORMA_INVOICES=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/graduation.integration.test.ts
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { issueDocumentTx } from "../issue.service";
import { recordAndAllocatePaymentService, postPaymentService } from "../../payments/payments.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB: ${host}`);
}

const ORG = "c4000000-0000-4000-8000-000000000001";
const USER = "c4000000-0000-4000-8000-000000000002";
const PARTY = "c4000000-0000-4000-8000-000000000003";
const S_IVTEN = "c4000000-0000-4000-8000-000000000004";
const S_RCPT = "c4000000-0000-4000-8000-000000000005";
const S_PI = "c4000000-0000-4000-8000-000000000006";
const CAT = "c4000000-0000-4000-8000-000000000007";
const CH_A = "c4000000-0000-4000-8000-000000000011";
const CH_B = "c4000000-0000-4000-8000-000000000012";

const session = { orgId: ORG, userId: USER, role: "accountant" } as never;

async function cleanup() {
  const db = getDb();
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** A tenant holding ONE proforma with two lines: RM100 (A) and RM60 (B). */
async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "Grad Org", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "g@t.test", fullName: "G", status: "active", role: "admin", userType: "operator" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "tenant", status: "active" } });
  await db.documentSeries.create({ data: { id: S_IVTEN, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: false, active: true } });
  await db.documentSeries.create({ data: { id: S_RCPT, organizationId: ORG, code: "RCPT", prefix: "RCPT", padding: 4, includeYear: false, active: true } });
  await db.documentSeries.create({ data: { id: S_PI, organizationId: ORG, code: "PI", prefix: "PI", padding: 4, includeYear: false, active: true } });
  await db.chargeCategory.create({ data: { id: CAT, organizationId: ORG, code: "wifi_tenant", name: "WiFi", family: "tenant_income", docType: "invoice", seriesId: S_IVTEN, defaultSstRate: "0", eInvoiceEligible: false, active: true, sortOrder: 1 } });
  await db.charge.create({ data: { id: CH_A, organizationId: ORG, chargeNumber: "GRAD-A", chargeType: "utility", categoryId: CAT, partyId: PARTY, amount: "100.00", outstandingAmount: "100.00", status: "posted", currency: "MYR", dueDate: new Date("2026-07-01") } });
  await db.charge.create({ data: { id: CH_B, organizationId: ORG, chargeNumber: "GRAD-B", chargeType: "utility", categoryId: CAT, partyId: PARTY, amount: "60.00", outstandingAmount: "60.00", status: "posted", currency: "MYR", dueDate: new Date("2026-07-01") } });
  return db.$transaction((tx) =>
    issueDocumentTx(tx, {
      organizationId: ORG, docType: "proforma", seriesCode: "PI", counterpartyType: "tenant", partyId: PARTY,
      idempotencyKey: "pf:GRAD", actorUserId: USER,
      lines: [
        { chargeId: CH_A, categoryId: CAT, description: "WiFi", amount: "100.00", sstRate: "0" },
        { chargeId: CH_B, categoryId: CAT, description: "Cleaning", amount: "60.00", sstRate: "0" },
      ],
    }),
  );
}

function payInput(idem: string, chargeId: string, amount: string) {
  return {
    paymentNumber: `PAY-${idem}`, partyId: PARTY, paymentType: "receipt", paymentMethod: "bank_transfer",
    currency: "MYR", receivedAt: new Date().toISOString(), idempotencyKey: idem,
    allocations: [{ chargeId, allocatedAmount: amount }],
  } as never;
}

dn("proforma graduation (R3)", () => {
  beforeEach(async () => {
    await cleanup();
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_PROFORMA_INVOICES = "true";
    await seed();
  });
  afterEach(async () => {
    await cleanup();
    delete process.env.ENABLE_PROFORMA_INVOICES;
  });

  it("paying ONE line mints an invoice for that line only, plus its receipt", async () => {
    const db = getDb();
    const proforma = await db.billingDocument.findFirstOrThrow({ where: { organizationId: ORG, docType: "proforma" } });

    const r = await recordAndAllocatePaymentService(session, payInput("grad-1", CH_A, "100.00"));
    expect(r.ok).toBe(true);

    const invoice = await db.billingDocument.findFirstOrThrow({ where: { organizationId: ORG, docType: "invoice" } });
    expect(invoice.documentNumber.startsWith("IVTEN-")).toBe(true);
    expect(invoice.proformaDocumentId).toBe(proforma.id);
    // NEVER originalDocumentId — four paths read its NULL as "head of chain".
    expect(invoice.originalDocumentId).toBeNull();
    // Only the PAID line graduated. The RM60 line is still owed and stays on the proforma.
    expect(Number(invoice.total.toString())).toBe(100);
    const lines = await db.billingDocumentLine.findMany({ where: { documentId: invoice.id } });
    expect(lines.map((l) => l.chargeId)).toEqual([CH_A]);

    // The proforma is a dated snapshot: not re-issued, not cancelled, total unchanged.
    const after = await db.billingDocument.findUniqueOrThrow({ where: { id: proforma.id } });
    expect(after.documentStatus).toBe("ISSUED");
    expect(Number(after.total.toString())).toBe(160);

    // The receipt follows the invoice — it can only find lines on an invoice/debit_note,
    // so this also proves graduation ran FIRST.
    const receipt = await db.billingDocument.findFirstOrThrow({ where: { organizationId: ORG, docType: "receipt" } });
    expect(receipt.paymentId).toBe((r as { data: { id: string } }).data.id);
  });

  it("a portal FPX payment settling through postPaymentService gets BOTH documents", async () => {
    // THE bug this fixes. issueReceiptForPayment used to be wired only into the admin
    // Record Payment form, so a tenant paying online settled here and minted nothing.
    const db = getDb();
    const payment = await db.payment.create({
      data: {
        organizationId: ORG, paymentNumber: "FPX-1", partyId: PARTY, paymentType: "receipt",
        paymentMethod: "fpx", status: "pending_approval", amount: "100.00", currency: "MYR",
        receivedAt: new Date(),
      },
      select: { id: true },
    });
    // Mirrors portal FPX initiate: the allocation exists but settles nothing until the
    // gateway callback posts the payment.
    await db.paymentAllocation.create({
      data: { organizationId: ORG, paymentId: payment.id, chargeId: CH_A, allocatedAmount: "100.00", allocatedAt: new Date() },
    });

    const r = await postPaymentService(session, { paymentId: payment.id } as never);
    expect(r.ok).toBe(true);

    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "invoice" } })).toBe(1);
    const receipt = await db.billingDocument.findFirstOrThrow({ where: { organizationId: ORG, docType: "receipt" } });
    expect(receipt.paymentId).toBe(payment.id);
  });

  it("replaying the same payment mints no second invoice", async () => {
    const db = getDb();
    await recordAndAllocatePaymentService(session, payInput("grad-2", CH_A, "100.00"));
    await recordAndAllocatePaymentService(session, payInput("grad-2", CH_A, "100.00"));
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "invoice" } })).toBe(1);
  });

  it("a second payment for the OTHER line mints its own invoice against the same proforma", async () => {
    const db = getDb();
    const proforma = await db.billingDocument.findFirstOrThrow({ where: { organizationId: ORG, docType: "proforma" } });
    await recordAndAllocatePaymentService(session, payInput("grad-3a", CH_A, "100.00"));
    await recordAndAllocatePaymentService(session, payInput("grad-3b", CH_B, "60.00"));

    const invoices = await db.billingDocument.findMany({ where: { organizationId: ORG, docType: "invoice" }, orderBy: { issuedAt: "asc" } });
    expect(invoices).toHaveLength(2);
    expect(invoices.every((i) => i.proformaDocumentId === proforma.id)).toBe(true);
    expect(invoices.map((i) => Number(i.total.toString()))).toEqual([100, 60]);
  });

  it("flag OFF — no graduation, and the legacy receipt path still works off a real invoice", async () => {
    // A pre-flag charge sits on an `invoice`, not a proforma. Graduation must skip it
    // rather than mint a duplicate, and the receipt must still be issued.
    delete process.env.ENABLE_PROFORMA_INVOICES;
    const db = getDb();
    await db.billingDocument.deleteMany({ where: { organizationId: ORG, docType: "proforma" } });
    await db.$transaction((tx) =>
      issueDocumentTx(tx, {
        organizationId: ORG, docType: "invoice", counterpartyType: "tenant", partyId: PARTY,
        idempotencyKey: "legacy:GRAD", actorUserId: USER,
        lines: [{ chargeId: CH_A, categoryId: CAT, description: "WiFi", amount: "100.00", sstRate: "0" }],
      }),
    );

    await recordAndAllocatePaymentService(session, payInput("grad-4", CH_A, "100.00"));

    // Exactly the one legacy invoice — graduation minted nothing.
    const invoices = await db.billingDocument.findMany({ where: { organizationId: ORG, docType: "invoice" } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].proformaDocumentId).toBeNull();
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "receipt" } })).toBe(1);
  });

  it("payment stands and leaves a marker when graduation throws (PI lines but no IVTEN series)", async () => {
    const db = getDb();
    // Rename rather than delete: ChargeCategory.seriesId FKs this row. issueDocumentTx
    // resolves by CODE, so this is enough to make graduation's IVTEN lookup fail.
    await db.documentSeries.update({ where: { id: S_IVTEN }, data: { code: "IVTEN_GONE" } });

    const r = await recordAndAllocatePaymentService(session, payInput("grad-5", CH_A, "100.00"));
    expect(r.ok).toBe(true); // money committed regardless

    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "invoice" } })).toBe(0);
    const marker = await db.auditLog.findFirst({ where: { organizationId: ORG, action: "graduation.issue_failed" } });
    expect(marker).not.toBeNull();
  });
  it("two partial payments on ONE charge mint ONE invoice for the billed amount", async () => {
    // Review finding (CRITICAL). A partial allocation is permitted — only OVER-allocation
    // raises ALLOC_EXCEEDS_OUTSTANDING — so a RM100 charge can be settled by RM40 then
    // RM60. Graduation is keyed per PAYMENT and mints the proforma LINE amount, so each
    // payment minted a full RM100 tax invoice: RM100 billed, RM200 invoiced and receipted.
    const db = getDb();
    await recordAndAllocatePaymentService(session, payInput("crit-a", CH_A, "40.00"));
    await recordAndAllocatePaymentService(session, payInput("crit-b", CH_A, "60.00"));

    const invoices = await db.billingDocument.findMany({ where: { organizationId: ORG, docType: "invoice" } });
    const invoiced = invoices.reduce((s, i) => s + Number(i.total.toString()), 0);
    // RM100 was billed and RM100 was received. Anything more is fabricated tax documents.
    expect(invoiced).toBe(100);
  });

  it("a payment spanning TWO proformas graduates BOTH", async () => {
    // Review finding (HIGH). usable[0].documentId picks one proforma from an unordered
    // findMany and discards the rest; the per-payment key means the dropped lines can
    // never graduate later. CH_A (100) and CH_B (60) sit on the SAME proforma here, so to
    // exercise it we move CH_B onto its own.
    const db = getDb();
    const first = await db.billingDocument.findFirstOrThrow({ where: { organizationId: ORG, docType: "proforma" } });
    await db.billingDocumentLine.deleteMany({ where: { documentId: first.id, chargeId: CH_B } });
    await db.billingDocument.update({ where: { id: first.id }, data: { subtotal: "100.00", total: "100.00" } });
    await db.$transaction((tx) =>
      issueDocumentTx(tx, {
        organizationId: ORG, docType: "proforma", seriesCode: "PI", counterpartyType: "tenant", partyId: PARTY,
        idempotencyKey: "pf:GRAD-2", actorUserId: USER,
        lines: [{ chargeId: CH_B, categoryId: CAT, description: "Cleaning", amount: "60.00", sstRate: "0" }],
      }),
    );

    await recordAndAllocatePaymentService(session, {
      paymentNumber: "PAY-span", partyId: PARTY, paymentType: "receipt", paymentMethod: "bank_transfer",
      currency: "MYR", receivedAt: new Date().toISOString(), idempotencyKey: "span",
      allocations: [{ chargeId: CH_A, allocatedAmount: "100.00" }, { chargeId: CH_B, allocatedAmount: "60.00" }],
    } as never);

    const invoices = await db.billingDocument.findMany({ where: { organizationId: ORG, docType: "invoice" } });
    const invoiced = invoices.reduce((s, i) => s + Number(i.total.toString()), 0);
    // RM160 received across two proformas ⇒ RM160 of tax invoices, not RM100.
    expect(invoiced).toBe(160);
  });
});
