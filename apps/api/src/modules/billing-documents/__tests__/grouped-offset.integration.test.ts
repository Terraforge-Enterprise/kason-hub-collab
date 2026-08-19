/**
 * Phase 0B (§7-A2 / Issue 3): crediting ONE charge of a multi-charge grouped invoice
 * must derive the document's status from ALL its charges — NOT blanket-`offset` it.
 * Also proves the canonical deriveAndWriteDocumentStatusTx writes BOTH status axes and
 * is empty-charge-set safe. Real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/grouped-offset.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { creditPostedChargeTx } from "../credit-notes.service";
import { deriveAndWriteDocumentStatusTx } from "../status.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

const ORG = "b7200000-0000-4000-8000-000000000001";
const USER = "b7200000-0000-4000-8000-000000000002";
const TENANT = "b7200000-0000-4000-8000-000000000003";
const CAT = "b7200000-0000-4000-8000-000000000004";
const SERIES_DEP = "b7200000-0000-4000-8000-000000000005";
const SERIES_CN = "b7200000-0000-4000-8000-000000000006";
const C1 = "b7200000-0000-4000-8000-000000000011";
const C2 = "b7200000-0000-4000-8000-000000000012";
const D1 = "b7200000-0000-4000-8000-000000000013";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.paymentAllocationReversal.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
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
      id: ORG, name: "Grouped Offset Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "b720@test.local", passwordHash: "x", role: "admin",
      fullName: "B720 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "Grouped Tenant", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DEP, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "rental", name: "Utility",
      family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES_DEP,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
}

async function seedCharge(id: string, num: string, amount: string) {
  await getDb().charge.create({
    data: {
      id, organizationId: ORG, chargeNumber: num, partyId: TENANT, chargeType: "rental",
      categoryId: CAT, status: "posted", postedAt: new Date(), description: `charge ${num}`,
      dueDate: new Date("2026-06-30"), amount, currency: "MYR", outstandingAmount: amount,
      billingMonth: new Date("2026-06-01"),
    },
  });
}

/** One grouped invoice document over the given charges (1 line each). */
async function seedGroupedInvoice(charges: { id: string; amount: string }[]) {
  const total = charges.reduce((s, c) => s + Number(c.amount), 0).toFixed(2);
  await getDb().billingDocument.create({
    data: {
      id: D1, organizationId: ORG, docType: "invoice", documentNumber: "DEP-9001", seriesId: SERIES_DEP,
      status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      billingMonth: new Date("2026-06-01"), subtotal: total, sstAmount: 0, total,
      lines: { create: charges.map((c) => ({ chargeId: c.id, categoryId: CAT, description: `line ${c.id.slice(-2)}`, amount: c.amount, sstRate: 0, sstAmount: 0 })) },
    },
  });
}

const status = async () => (await getDb().billingDocument.findUniqueOrThrow({ where: { id: D1 } }));

dn("grouped-invoice offset derivation (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });
  afterAll(cleanup);

  it("single-charge invoice fully credited → offset", async () => {
    await seedCharge(C1, "B720-C1", "100.00");
    await seedGroupedInvoice([{ id: C1, amount: "100.00" }]);
    await getDb().$transaction((tx) =>
      creditPostedChargeTx(tx, { organizationId: ORG, chargeId: C1, reason: "full credit", actorUserId: USER, actorRole: "admin" }),
    );
    expect((await status()).status).toBe("offset");
  });

  it("grouped invoice, 1 of 2 charges credited → partially_settled, NOT offset (the corruption fix)", async () => {
    await seedCharge(C1, "B720-C1", "100.00");
    await seedCharge(C2, "B720-C2", "50.00");
    await seedGroupedInvoice([{ id: C1, amount: "100.00" }, { id: C2, amount: "50.00" }]);

    await getDb().$transaction((tx) =>
      creditPostedChargeTx(tx, { organizationId: ORG, chargeId: C1, reason: "credit one", actorUserId: USER, actorRole: "admin" }),
    );

    const doc = await status();
    expect(doc.status).toBe("partially_settled"); // NOT offset — C2 still owes
    expect(doc.settlementStatus).toBe("PARTIALLY_PAID"); // both axes written consistently
  });

  it("grouped invoice, ALL charges credited → offset", async () => {
    await seedCharge(C1, "B720-C1", "100.00");
    await seedCharge(C2, "B720-C2", "50.00");
    await seedGroupedInvoice([{ id: C1, amount: "100.00" }, { id: C2, amount: "50.00" }]);

    await getDb().$transaction(async (tx) => {
      await creditPostedChargeTx(tx, { organizationId: ORG, chargeId: C1, reason: "credit c1", actorUserId: USER, actorRole: "admin" });
      await creditPostedChargeTx(tx, { organizationId: ORG, chargeId: C2, reason: "credit c2", actorUserId: USER, actorRole: "admin" });
    });

    expect((await status()).status).toBe("offset");
  });

  it("deriveAndWriteDocumentStatusTx is empty-charge-set safe → issued, not offset", async () => {
    // A document whose only line carries chargeId=null (overpayment-CN shape) → no charges.
    await getDb().billingDocument.create({
      data: {
        id: D1, organizationId: ORG, docType: "invoice", documentNumber: "DEP-9002", seriesId: SERIES_DEP,
        status: "partially_settled", settlementStatus: "PARTIALLY_PAID", issuedById: USER,
        counterpartyType: "tenant", partyId: TENANT, subtotal: "0.00", sstAmount: 0, total: "0.00",
        lines: { create: [{ chargeId: null, categoryId: null, description: "no charge", amount: "0.00", sstRate: 0, sstAmount: 0 }] },
      },
    });
    await getDb().$transaction((tx) => deriveAndWriteDocumentStatusTx(tx, D1));
    const doc = await status();
    expect(doc.status).toBe("issued"); // [].every() guarded → NOT offset
    expect(doc.settlementStatus).toBe("UNPAID");
  });
});
