/**
 * getBillingDocumentDetail — per-line expense attachment resolution
 * (bill-expenses R6, Task 6). Real LOCAL Postgres (opt-in RUN_INTEGRATION=1),
 * mirroring detail-paid-balance.integration.test.ts's harness convention (getDb +
 * RUN_INTEGRATION gate + non-local-host guard + process.env flag toggling) and
 * bills-grid/__tests__/line-attachment.integration.test.ts's storage-stub
 * convention for real GridExpense/GridAttachment fixtures (Charge.sourceGridExpenseId
 * is a real FK, so the source expense + its attachments are seeded via the real
 * bills-grid services rather than hand-rolled rows).
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/billing-documents/__tests__/detail-attachments.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
}));

import { getDb } from "@kason/db";
import { getBillingDocumentDetail } from "../repository";
import { createExpensesService, uploadLineAttachmentService } from "../../bills-grid/service";
import { cleanupGridFixtures } from "../../bills-grid/__tests__/cleanup";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed disjoint UUIDs (prefix d6a7; unused by any other suite)
const ORG = "d6a70000-0000-4000-8000-000000000001";
const USER = "d6a70000-0000-4000-8000-000000000002";
const TENANT = "d6a70000-0000-4000-8000-000000000003";
const CAT = "d6a70000-0000-4000-8000-000000000004";
const SERIES = "d6a70000-0000-4000-8000-000000000005";
const PROP = "d6a70000-0000-4000-8000-000000000006";
const APT = "d6a70000-0000-4000-8000-000000000007";
const C1 = "d6a70000-0000-4000-8000-000000000011";
const D1 = "d6a70000-0000-4000-8000-000000000012";
const C2 = "d6a70000-0000-4000-8000-000000000013";

const session = { orgId: ORG, userId: USER, role: "editor" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await cleanupGridFixtures(db, ORG);
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: { id: APT } });
  await db.property.deleteMany({ where: { id: PROP } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "D6A7 Detail Attachments Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "d6a7detail@test.local", passwordHash: "x", role: "admin",
      fullName: "D6A7 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "Detail Tenant", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES, organizationId: ORG, code: "DAT", prefix: "DAT", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "rental", name: "Monthly rental",
      family: "pay_back_landlord", docType: "invoice", seriesId: SERIES,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
  await db.property.create({
    data: {
      id: PROP, organizationId: ORG, name: "P", propertyCode: "P-D6A7", propertyType: "residential",
      addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "D6A7-UNIT", listingMode: "WHOLE" },
  });
}

/** Create a real GridExpense (via the real service — also creates the parent entry). */
async function seedExpense(description: string, amount: string): Promise<string> {
  const r = await createExpensesService(session, {
    apartmentId: APT, billingMonth: "2026-07-01", bearer: "owner",
    items: [{ description, amount, withSST: false }],
  });
  if (!r.ok) throw new Error(`fixture expense create failed: ${r.error}`);
  return r.data.ids[0];
}

/** Upload a real attachment (via the real service; storage is mocked). */
async function seedAttachment(expenseId: string, filename: string): Promise<string> {
  const r = await uploadLineAttachmentService(session, expenseId, {
    filename, contentType: "application/pdf", sizeBytes: 100, body: Buffer.from("x"),
  });
  if (!r.ok) throw new Error(`fixture attachment upload failed: ${r.error}`);
  return r.data.id;
}

/** Seed a posted charge + an issued invoice document (1 line) for it. */
async function seedInvoiceCharge(opts: {
  chargeId: string; docId: string; documentNumber: string; amount: string; sourceGridExpenseId?: string | null;
}) {
  const db = getDb();
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: ORG, chargeNumber: `D6A7-${opts.chargeId.slice(-6)}`,
      partyId: TENANT, chargeType: opts.sourceGridExpenseId ? "utility" : "rental", categoryId: CAT, status: "posted",
      postedAt: new Date(), description: "Line item", dueDate: new Date("2026-07-31"),
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.amount,
      billingMonth: new Date("2026-07-01"),
      sourceGridExpenseId: opts.sourceGridExpenseId ?? null,
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: "invoice",
      documentNumber: opts.documentNumber, seriesId: SERIES, status: "issued",
      issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      billingMonth: new Date("2026-07-01"),
      subtotal: opts.amount, sstAmount: 0, total: opts.amount,
      lines: {
        create: [{ chargeId: opts.chargeId, categoryId: CAT, description: "Line item", amount: opts.amount, sstRate: 0, sstAmount: 0 }],
      },
    },
  });
}

dn("getBillingDocumentDetail — expense-line attachments (Task 6, integration)", () => {
  const prevFlag = process.env.ENABLE_BILL_EXPENSES_AS_CHARGES;

  beforeEach(async () => {
    await cleanup();
    await seedBase();
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "1";
  });
  afterAll(async () => {
    await cleanup();
    if (prevFlag === undefined) delete process.env.ENABLE_BILL_EXPENSES_AS_CHARGES;
    else process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = prevFlag;
  });

  it("resolves expense attachments: two GridAttachments on the source expense both appear on the line, in upload order", async () => {
    const expId = await seedExpense("Aircon repair", "250.00");
    const a1 = await seedAttachment(expId, "slip.pdf");
    const a2 = await seedAttachment(expId, "quote.pdf");
    await seedInvoiceCharge({ chargeId: C1, docId: D1, documentNumber: "DAT-0001", amount: "250.00", sourceGridExpenseId: expId });

    const detail = await getBillingDocumentDetail(ORG, D1);
    const line = detail!.lines.find((l) => l.chargeId === C1)!;
    expect(line.attachments).toEqual([
      { id: a1, filename: "slip.pdf" },
      { id: a2, filename: "quote.pdf" },
    ]);
  });

  it("flag off empty attachments: every line reports [] even though its charge has a real sourceGridExpenseId with an attachment", async () => {
    const expId = await seedExpense("Aircon repair", "250.00");
    await seedAttachment(expId, "slip.pdf");
    await seedInvoiceCharge({ chargeId: C1, docId: D1, documentNumber: "DAT-0002", amount: "250.00", sourceGridExpenseId: expId });
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "0";

    const detail = await getBillingDocumentDetail(ORG, D1);
    expect(detail!.lines.every((l) => l.attachments.length === 0)).toBe(true);
  });

  it("non-expense line empty: a regular utility charge (no sourceGridExpenseId) reports []", async () => {
    await seedInvoiceCharge({ chargeId: C1, docId: D1, documentNumber: "DAT-0003", amount: "80.00" }); // no sourceGridExpenseId

    const detail = await getBillingDocumentDetail(ORG, D1);
    expect(detail!.lines[0].attachments).toEqual([]);
  });

  it("charge-less line (chargeId null) reports []", async () => {
    const db = getDb();
    await db.billingDocument.create({
      data: {
        id: D1, organizationId: ORG, docType: "invoice", documentNumber: "DAT-0004", seriesId: SERIES, status: "issued",
        issuedById: USER, counterpartyType: "tenant", partyId: TENANT, billingMonth: new Date("2026-07-01"),
        subtotal: "10.00", sstAmount: 0, total: "10.00",
        lines: { create: [{ chargeId: null, categoryId: null, description: "Overpayment credit", amount: "10.00", sstRate: 0, sstAmount: 0 }] },
      },
    });
    const detail = await getBillingDocumentDetail(ORG, D1);
    expect(detail!.lines[0].attachments).toEqual([]);
  });

  it("expense with zero attachments reports [] (distinct from flag-off — the expense IS resolved, just has no files)", async () => {
    const expId = await seedExpense("No receipts yet", "30.00");
    await seedInvoiceCharge({ chargeId: C1, docId: D1, documentNumber: "DAT-0005", amount: "30.00", sourceGridExpenseId: expId });

    const detail = await getBillingDocumentDetail(ORG, D1);
    expect(detail!.lines[0].attachments).toEqual([]);
  });

  it("two lines on ONE document, each linked to a DIFFERENT expense, each get only their own attachments (no cross-line leak)", async () => {
    const exp1 = await seedExpense("Expense one", "100.00");
    const exp2 = await seedExpense("Expense two", "50.00");
    const a1 = await seedAttachment(exp1, "one.pdf");
    const a2 = await seedAttachment(exp2, "two.pdf");

    const db = getDb();
    await db.charge.create({
      data: {
        id: C1, organizationId: ORG, chargeNumber: "D6A7-C1DEDUP", partyId: TENANT, chargeType: "utility",
        categoryId: CAT, status: "posted", postedAt: new Date(), description: "One", dueDate: new Date("2026-07-31"),
        amount: "100.00", currency: "MYR", outstandingAmount: "100.00", billingMonth: new Date("2026-07-01"),
        sourceGridExpenseId: exp1,
      },
    });
    await db.charge.create({
      data: {
        id: C2, organizationId: ORG, chargeNumber: "D6A7-C2DEDUP", partyId: TENANT, chargeType: "utility",
        categoryId: CAT, status: "posted", postedAt: new Date(), description: "Two", dueDate: new Date("2026-07-31"),
        amount: "50.00", currency: "MYR", outstandingAmount: "50.00", billingMonth: new Date("2026-07-01"),
        sourceGridExpenseId: exp2,
      },
    });
    await db.billingDocument.create({
      data: {
        id: D1, organizationId: ORG, docType: "invoice", documentNumber: "DAT-0006", seriesId: SERIES, status: "issued",
        issuedById: USER, counterpartyType: "tenant", partyId: TENANT, billingMonth: new Date("2026-07-01"),
        subtotal: "150.00", sstAmount: 0, total: "150.00",
        lines: {
          create: [
            { chargeId: C1, categoryId: CAT, description: "One", amount: "100.00", sstRate: 0, sstAmount: 0 },
            { chargeId: C2, categoryId: CAT, description: "Two", amount: "50.00", sstRate: 0, sstAmount: 0 },
          ],
        },
      },
    });

    const detail = await getBillingDocumentDetail(ORG, D1);
    const line1 = detail!.lines.find((l) => l.chargeId === C1)!;
    const line2 = detail!.lines.find((l) => l.chargeId === C2)!;
    expect(line1.attachments).toEqual([{ id: a1, filename: "one.pdf" }]);
    expect(line2.attachments).toEqual([{ id: a2, filename: "two.pdf" }]);
  });
});
