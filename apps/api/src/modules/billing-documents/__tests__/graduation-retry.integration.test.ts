/**
 * Graduation retry (spec R13) — the repair path.
 *
 * Graduation runs post-commit and never throws, so a failure leaves the tenant correctly
 * PAID with the tax invoice missing. The money is right; only the document is absent.
 * Without a retry, an operator's only recourse is reading `graduation.issue_failed` audit
 * rows and doing it by hand.
 *
 * Run: from apps/api, RUN_INTEGRATION=1 + a seeded TEST_DATABASE_URL + ENABLE_* flags.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { issueDocumentTx } from "../issue.service";
import { retryGraduationForEntryService } from "../graduation-retry.service";
import { recordAndAllocatePaymentService } from "../../payments/payments.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB: ${host}`);
}

const ORG = "f3300000-0000-4000-8000-000000000001";
const USER = "f3300000-0000-4000-8000-000000000002";
const PROP = "f3300000-0000-4000-8000-000000000003";
const APT = "f3300000-0000-4000-8000-000000000004";
const PARTY = "f3300000-0000-4000-8000-000000000005";
const S_IVTEN = "f3300000-0000-4000-8000-000000000006";
const S_RCPT = "f3300000-0000-4000-8000-000000000007";
const S_PI = "f3300000-0000-4000-8000-000000000008";
const CAT = "f3300000-0000-4000-8000-000000000009";
const CH = "f3300000-0000-4000-8000-00000000000a";

const PERIOD = new Date("2026-10-01T00:00:00.000Z");
const session = { orgId: ORG, userId: USER, role: "manager" } as never;

async function cleanup() {
  const db = getDb();
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** A paid charge sitting on a proforma with NO graduated invoice — the failure state. */
async function seedPendingGraduation() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "GR", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "gr@t.test", fullName: "GR", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-GR", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-GR", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "tenant", status: "active" } });
  await db.documentSeries.create({ data: { id: S_PI, organizationId: ORG, code: "PI", prefix: "PI", padding: 4, includeYear: false, active: true } });
  await db.documentSeries.create({ data: { id: S_RCPT, organizationId: ORG, code: "RCPT", prefix: "RCPT", padding: 4, includeYear: false, active: true } });
  await db.chargeCategory.create({ data: { id: CAT, organizationId: ORG, code: "wifi_tenant", name: "WiFi", family: "tenant_income", docType: "invoice", seriesId: S_PI, defaultSstRate: "0", eInvoiceEligible: false, active: true, sortOrder: 1 } });

  const entry = await db.unitBillsGridEntry.create({
    data: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER },
  });
  await db.charge.create({
    data: {
      id: CH, organizationId: ORG, chargeNumber: "GRIDUTIL-202610-x-WIFI", chargeType: "utility",
      categoryId: CAT, partyId: PARTY, amount: "100.00", outstandingAmount: "100.00",
      status: "posted", currency: "MYR", dueDate: PERIOD, billingMonth: PERIOD,
      sourceGridEntryId: entry.id,
    },
  });
  await db.$transaction((tx) =>
    issueDocumentTx(tx, {
      organizationId: ORG, docType: "proforma", seriesCode: "PI", counterpartyType: "tenant",
      partyId: PARTY, idempotencyKey: "pf:GR", actorUserId: USER,
      lines: [{ chargeId: CH, categoryId: CAT, description: "WiFi", amount: "100.00", sstRate: "0" }],
    }),
  );

  // Pay it with the IVTEN series ABSENT, so graduation fails exactly as it would in
  // production: the money commits, the invoice does not, and the audit marker is written.
  await recordAndAllocatePaymentService(session, {
    paymentNumber: "PAY-GR", partyId: PARTY, paymentType: "receipt", paymentMethod: "bank_transfer",
    currency: "MYR", receivedAt: new Date().toISOString(), idempotencyKey: "gr-1",
    allocations: [{ chargeId: CH, allocatedAmount: "100.00" }],
  } as never);

  return entry.id;
}

dn("graduation retry (R13)", () => {
  beforeEach(async () => {
    await cleanup();
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_PROFORMA_INVOICES = "true";
  });
  afterEach(async () => {
    await cleanup();
    delete process.env.ENABLE_PROFORMA_INVOICES;
  });

  it("mints the missing invoice after a failed graduation", async () => {
    const db = getDb();
    const entryId = await seedPendingGraduation();

    // Precondition: money settled, no invoice, marker written.
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "invoice" } })).toBe(0);
    expect(await db.auditLog.findFirst({ where: { organizationId: ORG, action: "graduation.issue_failed" } })).not.toBeNull();

    // Repair the cause, then retry.
    await db.documentSeries.create({ data: { id: S_IVTEN, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: false, active: true } });
    const r = await retryGraduationForEntryService(session, entryId);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.graduated).toHaveLength(1);
    const invoice = await db.billingDocument.findFirstOrThrow({ where: { organizationId: ORG, docType: "invoice" } });
    expect(invoice.documentNumber.startsWith("IVTEN-")).toBe(true);
    expect(invoice.proformaDocumentId).not.toBeNull();
  });

  it("is idempotent — a second retry mints nothing", async () => {
    const db = getDb();
    const entryId = await seedPendingGraduation();
    await db.documentSeries.create({ data: { id: S_IVTEN, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: false, active: true } });

    await retryGraduationForEntryService(session, entryId);
    const second = await retryGraduationForEntryService(session, entryId);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Empty is the ORDINARY answer once repaired — not an error.
    expect(second.data.graduated).toHaveLength(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "invoice" } })).toBe(1);
  });

  it("a healthy entry with nothing pending is a clean 200 no-op", async () => {
    const db = getDb();
    await db.organization.create({ data: { id: ORG, name: "GR", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
    await db.user.create({ data: { id: USER, organizationId: ORG, email: "gr@t.test", fullName: "GR", status: "active", role: "manager", userType: "operator" } });
    await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-GR", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
    await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-GR", listingMode: "WHOLE" } });
    const entry = await db.unitBillsGridEntry.create({ data: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER } });

    const r = await retryGraduationForEntryService(session, entry.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.graduated).toHaveLength(0);
  });

  it("404s on an entry from another org", async () => {
    const entryId = await seedPendingGraduation();
    const other = { orgId: "f3300000-0000-4000-8000-0000000000ff", userId: USER, role: "manager" } as never;
    const r = await retryGraduationForEntryService(other, entryId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);
  });

  it("409 FLAG_DISABLED when the proforma flag is off", async () => {
    const entryId = await seedPendingGraduation();
    delete process.env.ENABLE_PROFORMA_INVOICES;
    const r = await retryGraduationForEntryService(session, entryId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.error).toBe("FLAG_DISABLED");
  });
});
