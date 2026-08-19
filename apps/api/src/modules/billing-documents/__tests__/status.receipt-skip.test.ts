/**
 * Real local Postgres. Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 npx vitest run \
 *     src/modules/billing-documents/__tests__/status.receipt-skip.test.ts
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { refreshDocumentStatusForCharges } from "../status.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB: ${host}`);
}

const ORG = "a4000000-0000-4000-8000-000000000001";
const USER = "a4000000-0000-4000-8000-000000000002";
const PARTY = "a4000000-0000-4000-8000-000000000003";
const SERIES = "a4000000-0000-4000-8000-000000000004";
const CAT = "a4000000-0000-4000-8000-000000000005";
const CHARGE = "a4000000-0000-4000-8000-000000000006";
const RECEIPT = "a4000000-0000-4000-8000-000000000010";
const DEBIT = "a4000000-0000-4000-8000-000000000011";

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "Status Skip Org", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "s@t.test", fullName: "S", status: "active", role: "admin", userType: "operator" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "tenant", status: "active" } });
  await db.documentSeries.create({ data: { id: SERIES, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true } });
  await db.chargeCategory.create({ data: { id: CAT, organizationId: ORG, code: "rental", name: "Monthly rental", family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES, defaultSstRate: "0", eInvoiceEligible: false, isSystem: true, active: true, sortOrder: 1 } });
  // A fully-paid charge (outstanding 0, status paid) so a NON-skipped doc would flip to settled.
  await db.charge.create({ data: { id: CHARGE, organizationId: ORG, chargeNumber: "RENT-1", chargeType: "rental", categoryId: CAT, partyId: PARTY, amount: "100.00", outstandingAmount: "0.00", status: "paid", currency: "MYR", dueDate: new Date("2026-07-01") } });
  // One receipt doc + one debit_note doc, each linked to the same charge.
  for (const [id, docType] of [[RECEIPT, "receipt"], [DEBIT, "debit_note"]] as const) {
    await db.billingDocument.create({
      data: {
        id, organizationId: ORG, docType, documentNumber: docType === "receipt" ? "RCPT-0001" : "DEP-0001",
        seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: PARTY,
        subtotal: "100.00", sstAmount: "0", total: "100.00",
        lines: { create: [{ chargeId: CHARGE, categoryId: CAT, description: "Monthly rental", amount: "100.00", sstRate: "0", sstAmount: "0" }] },
      },
    });
  }
}

dn("refreshDocumentStatusForCharges skips receipts (R6)", () => {
  beforeEach(async () => { await cleanup(); await seed(); });

  it("leaves a receipt at issued but re-derives the debit_note to settled", async () => {
    await refreshDocumentStatusForCharges([CHARGE]);
    const db = getDb();
    const receipt = await db.billingDocument.findUniqueOrThrow({ where: { id: RECEIPT } });
    const debit = await db.billingDocument.findUniqueOrThrow({ where: { id: DEBIT } });
    expect(receipt.status).toBe("issued"); // skipped — never mutated
    expect(debit.status).toBe("settled"); // NON-receipt still recomputes (regression guard)
  });
});
