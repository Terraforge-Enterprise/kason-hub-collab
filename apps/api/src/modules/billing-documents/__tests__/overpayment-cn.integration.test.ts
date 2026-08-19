import { describe, it, expect, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { createOverpaymentCreditNoteService } from "../overpayment-cn.service";
import { randomUUID } from "node:crypto";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "9c360000-0000-4000-8000-000000000001";
const USER = "9c360000-0000-4000-8000-000000000002";
const PARTY = "9c360000-0000-4000-8000-000000000003";
const SERIES_CN = "9c360000-0000-4000-8000-000000000004";
const SERIES_DEP = "9c360000-0000-4000-8000-000000000005";
const INV = "9c360000-0000-4000-8000-000000000006";
const CN_ORIG = "9c360000-0000-4000-8000-000000000007";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "P4 OverpayCN Org", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "p4ocn@test.local", passwordHash: "x", role: "accountant", fullName: "P4 Acc", status: "active", userType: "operator" },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "Overpay Tenant", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DEP, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  // the overpaid invoice (docType invoice, status settled — allowed original)
  await db.billingDocument.create({
    data: { id: INV, organizationId: ORG, docType: "invoice", documentNumber: "DEP-9601", seriesId: SERIES_DEP, status: "settled", issuedById: USER, counterpartyType: "tenant", partyId: PARTY, subtotal: "150.00", sstAmount: "0", total: "150.00" },
  });
  // a credit_note we will (illegally) try to use as the original
  await db.billingDocument.create({
    data: { id: CN_ORIG, organizationId: ORG, docType: "credit_note", documentNumber: "CN-9601", seriesId: SERIES_CN, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: PARTY, originalDocumentId: INV, creditAmount: "10.00", subtotal: "10.00", sstAmount: "0", total: "10.00" },
  });
}

const session = { orgId: ORG, userId: USER, role: "accountant" };

dn("createOverpaymentCreditNoteService (integration)", () => {
  afterAll(cleanup);

  it("mints a CN with a charge-less/category-less line, creditAmount defaults to total", async () => {
    await cleanup(); await seed();
    const res = await createOverpaymentCreditNoteService(session, {
      originalDocumentId: INV, partyId: PARTY, counterpartyType: "tenant",
      lines: [{ description: "Overpayment credit", amount: "50.00" }],
      reason: "tenant overpaid RM50", idempotencyKey: randomUUID(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe(201);
    expect(res.data.creditAmount).toBe("50.00");
    const db = getDb();
    const cn = await db.billingDocument.findUniqueOrThrow({ where: { id: res.data.id } });
    expect(cn.docType).toBe("credit_note");
    expect(cn.originalDocumentId).toBe(INV);
    expect(Number(cn.total.toString())).toBe(50);
    expect(Number(cn.creditAmount!.toString())).toBe(50);
    const line = await db.billingDocumentLine.findFirstOrThrow({ where: { documentId: cn.id } });
    expect(line.chargeId).toBeNull();
    expect(line.categoryId).toBeNull();
  });

  it("replay with the same idempotencyKey mints no second CN", async () => {
    await cleanup(); await seed();
    const key = randomUUID();
    const body = {
      originalDocumentId: INV, partyId: PARTY, counterpartyType: "tenant" as const,
      lines: [{ description: "Overpayment credit", amount: "50.00" }],
      reason: "tenant overpaid RM50", idempotencyKey: key,
    };
    const first = await createOverpaymentCreditNoteService(session, body);
    const second = await createOverpaymentCreditNoteService(session, body);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.data.id).toBe(first.data.id);
    const db = getDb();
    const count = await db.billingDocument.count({ where: { organizationId: ORG, docType: "credit_note", originalDocumentId: INV } });
    // one pre-seeded CN_ORIG + exactly one from this flow = 2
    expect(count).toBe(2);
  });

  it("rejects a credit_note original with 400 ORIGINAL_NOT_INVOICEABLE", async () => {
    await cleanup(); await seed();
    const res = await createOverpaymentCreditNoteService(session, {
      originalDocumentId: CN_ORIG, partyId: PARTY, counterpartyType: "tenant",
      lines: [{ description: "x", amount: "5.00" }], reason: "bad", idempotencyKey: randomUUID(),
    });
    expect(res).toEqual({ ok: false, status: 400, error: "ORIGINAL_NOT_INVOICEABLE" });
  });

  it("rejects an offset original with 400 ORIGINAL_OFFSET", async () => {
    await cleanup(); await seed();
    const db = getDb();
    await db.billingDocument.update({ where: { id: INV }, data: { status: "offset" } });
    const res = await createOverpaymentCreditNoteService(session, {
      originalDocumentId: INV, partyId: PARTY, counterpartyType: "tenant",
      lines: [{ description: "x", amount: "5.00" }], reason: "bad", idempotencyKey: randomUUID(),
    });
    expect(res).toEqual({ ok: false, status: 400, error: "ORIGINAL_OFFSET" });
  });
});
