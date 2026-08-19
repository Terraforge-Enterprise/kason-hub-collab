/**
 * Real local Postgres. Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 npx vitest run \
 *     src/modules/billing-documents/__tests__/billingdocument-paymentid.integration.test.ts
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB: ${host}`);
}

const ORG = "a5000000-0000-4000-8000-000000000001";
const USER = "a5000000-0000-4000-8000-000000000002";
const PARTY = "a5000000-0000-4000-8000-000000000003";
const SERIES = "a5000000-0000-4000-8000-000000000004";
const PAYMENT = "a5000000-0000-4000-8000-000000000005";
const WITH_PID = "a5000000-0000-4000-8000-000000000010";
const NO_PID = "a5000000-0000-4000-8000-000000000011";

async function cleanup() {
  const db = getDb();
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "PID Org", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "p@t.test", fullName: "P", status: "active", role: "admin", userType: "operator" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "tenant", status: "active" } });
  await db.documentSeries.create({ data: { id: SERIES, organizationId: ORG, code: "RCPT", prefix: "RCPT", padding: 4, includeYear: false, active: true } });
}

dn("BillingDocument.paymentId (R13 migration)", () => {
  beforeEach(async () => { await cleanup(); await seed(); });

  it("persists a paymentId when set on a receipt document", async () => {
    const db = getDb();
    await db.billingDocument.create({
      data: { id: WITH_PID, organizationId: ORG, docType: "receipt", documentNumber: "RCPT-0001", seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: PARTY, paymentId: PAYMENT, subtotal: "100.00", sstAmount: "0", total: "100.00" },
    });
    const row = await db.billingDocument.findUniqueOrThrow({ where: { id: WITH_PID } });
    expect(row.paymentId).toBe(PAYMENT);
  });

  it("leaves paymentId null on a document created without it (additive, nullable)", async () => {
    const db = getDb();
    await db.billingDocument.create({
      data: { id: NO_PID, organizationId: ORG, docType: "invoice", documentNumber: "RCPT-0002", seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: PARTY, subtotal: "50.00", sstAmount: "0", total: "50.00" },
    });
    const row = await db.billingDocument.findUniqueOrThrow({ where: { id: NO_PID } });
    expect(row.paymentId).toBeNull();
  });
});
