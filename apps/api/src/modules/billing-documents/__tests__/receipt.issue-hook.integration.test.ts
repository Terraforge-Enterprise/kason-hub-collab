/**
 * Real local Postgres. Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 npx vitest run \
 *     src/modules/billing-documents/__tests__/receipt.issue-hook.integration.test.ts
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { issueDocumentTx } from "../issue.service";
import { recordAndAllocatePaymentService } from "../../payments/payments.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB: ${host}`);
}

const ORG = "a7000000-0000-4000-8000-000000000001";
const USER = "a7000000-0000-4000-8000-000000000002";
const PARTY = "a7000000-0000-4000-8000-000000000003";
const IVTEN = "a7000000-0000-4000-8000-000000000004";
const RCPT = "a7000000-0000-4000-8000-000000000005";
const CAT = "a7000000-0000-4000-8000-000000000006";
const CHARGE = "a7000000-0000-4000-8000-000000000011";

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

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "Hook Org", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "h@t.test", fullName: "H", status: "active", role: "admin", userType: "operator" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "tenant", status: "active" } });
  await db.documentSeries.create({ data: { id: IVTEN, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: false, active: true } });
  await db.documentSeries.create({ data: { id: RCPT, organizationId: ORG, code: "RCPT", prefix: "RCPT", padding: 4, includeYear: false, active: true } });
  await db.chargeCategory.create({ data: { id: CAT, organizationId: ORG, code: "booking_fee", name: "Booking fee", family: "tenant_income", docType: "invoice", seriesId: IVTEN, defaultSstRate: "0", eInvoiceEligible: false, active: true, sortOrder: 1 } });
  await db.charge.create({ data: { id: CHARGE, organizationId: ORG, chargeNumber: "BF-1", chargeType: "booking_fee", categoryId: CAT, partyId: PARTY, amount: "100.00", outstandingAmount: "100.00", status: "posted", currency: "MYR", dueDate: new Date("2026-07-01") } });
  await db.$transaction((tx) =>
    issueDocumentTx(tx, { organizationId: ORG, docType: "invoice", counterpartyType: "tenant", partyId: PARTY, idempotencyKey: "doc:BF-1", lines: [{ chargeId: CHARGE, categoryId: CAT, description: "Booking fee", amount: "100.00", sstRate: "0" }], actorUserId: USER }),
  );
}

function payInput(idem: string) {
  return { paymentNumber: `PAY-${idem}`, partyId: PARTY, paymentType: "receipt", paymentMethod: "bank_transfer", currency: "MYR", receivedAt: new Date().toISOString(), idempotencyKey: idem, allocations: [{ chargeId: CHARGE, allocatedAmount: "100.00" }] } as never;
}

dn("receipt issuance post-commit hook (R8)", () => {
  beforeEach(async () => { await cleanup(); await seed(); });

  it("issues exactly one receipt with paymentId; replay mints no second", async () => {
    const db = getDb();
    const r1 = await recordAndAllocatePaymentService(session, payInput("idem-1"));
    expect(r1.ok).toBe(true);
    const paymentId = (r1 as { data: { id: string } }).data.id;
    const receipts = await db.billingDocument.findMany({ where: { organizationId: ORG, docType: "receipt" } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].paymentId).toBe(paymentId);

    // Replay (same idempotencyKey) → original payment, no second receipt.
    const r2 = await recordAndAllocatePaymentService(session, payInput("idem-1"));
    expect((r2 as { data: { replayed?: boolean } }).data.replayed).toBe(true);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "receipt" } })).toBe(1);
  });

  it("payment stands + records receipt.issue_failed when issuance throws (RCPT series missing)", async () => {
    const db = getDb();
    await db.documentSeries.deleteMany({ where: { organizationId: ORG, code: "RCPT" } }); // force SERIES_NOT_FOUND in issueDocumentTx
    const r = await recordAndAllocatePaymentService(session, payInput("idem-2"));
    expect(r.ok).toBe(true); // payment still committed
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "receipt" } })).toBe(0);
    const marker = await db.auditLog.findFirst({ where: { organizationId: ORG, action: "receipt.issue_failed" } });
    expect(marker).not.toBeNull();
  });
});
