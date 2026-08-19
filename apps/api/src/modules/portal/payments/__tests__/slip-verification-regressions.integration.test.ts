/**
 * Regression suite for the slip-verification review findings.
 *
 * Every test here asserts the CORRECT behaviour, and every one of them fails on
 * the pre-fix tree. They exist because two independent reviews found the same
 * root cause: the double-submit guard originally matched any `pending_approval`
 * payment, which also matches an FPX attempt that is mid-flight at the bank.
 *
 *   RUN_INTEGRATION=1 DATABASE_URL=…kaenproperties_test TEST_DATABASE_URL=…kaenproperties_test \
 *     npx vitest run slip-verification-regressions --no-file-parallelism
 *
 * Own org id prefix (c3…) so nothing collides with the C1/C2 fixtures — a
 * shared unit id between the payments and meter suites has already caused
 * cross-suite FK failures once.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import {
  submitMultiPaymentTx,
  initiateFpxPaymentTx,
  listPayableCharges,
} from "../portal.payments.repository";
import { getPendingPaymentsForDocument } from "../../../billing-documents/pending-payments.service";
import { listBillingDocuments } from "../../../billing-documents/repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing non-local DB host: ${host}`);
  }
}

const ORG = "c3000000-0000-4000-8000-000000000001";
const TENANT = "c3000000-0000-4000-8000-000000000002";
const USER = "c3000000-0000-4000-8000-000000000099";
const PROP = "c3000000-0000-4000-8000-000000000050";
const APT = "c3000000-0000-4000-8000-000000000051";
const LISTING = "c3000000-0000-4000-8000-000000000052";
const SERIES = "c3000000-0000-4000-8000-000000000060";
const CH_RENT = "c3000000-0000-4000-8000-000000000020";
const CH_CARPARK = "c3000000-0000-4000-8000-000000000021";
const CH_WIFI = "c3000000-0000-4000-8000-000000000022";
const CH_CLEAN = "c3000000-0000-4000-8000-000000000023";
const DOC_A = "c3000000-0000-4000-8000-000000000070";
const DOC_B = "c3000000-0000-4000-8000-000000000071";

const SLIP = `orgs/${ORG}/payment-slips/${TENANT}/aaaa-slip.jpg`;
const session = { partyId: TENANT, orgId: ORG };

async function cleanup() {
  const db = getDb();
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.notification.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "C3-Org", slug: "c3-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "c3@example.test", fullName: "C3 Operator",
      status: "active", role: "manager", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, partyType: "individual", displayName: "C3 Tenant", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROP, organizationId: ORG, name: "C3-P1", propertyCode: "C3-P1", propertyType: "residential",
      addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "C3-A1", listingMode: "PARTITIONED" },
  });
  await db.listing.create({
    data: {
      id: LISTING, organizationId: ORG, apartmentId: APT, listingType: "room",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR",
    },
  });
  await db.charge.createMany({
    data: [
      { id: CH_RENT, organizationId: ORG, partyId: TENANT, chargeNumber: "CHG-C3-1", chargeType: "rent", amount: 900, outstandingAmount: 900, status: "posted", currency: "MYR", dueDate: new Date("2026-07-01") },
      { id: CH_CARPARK, organizationId: ORG, partyId: TENANT, chargeNumber: "CHG-C3-2", chargeType: "carpark", amount: 120, outstandingAmount: 120, status: "posted", currency: "MYR", dueDate: new Date("2026-07-01") },
      { id: CH_WIFI, organizationId: ORG, partyId: TENANT, chargeNumber: "CHG-C3-3", chargeType: "utility", amount: 50, outstandingAmount: 50, status: "posted", currency: "MYR", dueDate: new Date("2026-07-01") },
      { id: CH_CLEAN, organizationId: ORG, partyId: TENANT, chargeNumber: "CHG-C3-4", chargeType: "utility", amount: 30, outstandingAmount: 30, status: "posted", currency: "MYR", dueDate: new Date("2026-07-01") },
    ],
  });
}

/** Two invoices: A carries rent+carpark+wifi+cleaning, B carries nothing yet. */
async function seedDocuments() {
  const db = getDb();
  await db.documentSeries.create({
    data: { id: SERIES, organizationId: ORG, code: "IVTEN", prefix: "IVTEN" },
  });
  for (const [id, num] of [[DOC_A, "IVTEN-C3A"], [DOC_B, "IVTEN-C3B"]] as const) {
    await db.billingDocument.create({
      data: {
        id, organizationId: ORG, docType: "invoice", documentNumber: num, seriesId: SERIES,
        issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
        subtotal: 0, total: 0,
      },
    });
  }
}

function submit(key: string, lines: { chargeId: string; allocatedAmount: number }[], num: string) {
  return submitMultiPaymentTx({
    organizationId: ORG, partyId: TENANT, actorUserId: USER, paymentNumber: num,
    idempotencyKey: key, paymentMethod: "bank_transfer", referenceNumber: `TXN-${num}`,
    notes: null, attachmentKeys: [SLIP],
    lines: lines.map((l) => ({ ...l, prorateRatio: null })),
  });
}

function initiateFpx(key: string, chargeId: string, amount: number, num: string) {
  return initiateFpxPaymentTx({
    organizationId: ORG, partyId: TENANT, actorUserId: USER, provider: "fpx-mock",
    paymentNumber: num, providerTxnId: key.replace(/-/g, ""), idempotencyKey: key,
    lines: [{ chargeId, allocatedAmount: amount, prorateRatio: null }],
  });
}

dn("slip verification — review regressions", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(cleanup);

  // ── C-1 / F1: an abandoned bank redirect must not take the rails offline ──
  // The original guard matched any `pending_approval`, which an in-flight FPX
  // row also is. A tenant who closed the bank tab could not pay that charge by
  // ANY method until their dead row aged out after 30 minutes.

  it("an in-flight FPX attempt does NOT block a second FPX attempt on the same charge", async () => {
    await initiateFpx("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01", CH_RENT, 900, "PAY-C3-F1");
    await expect(
      initiateFpx("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02", CH_RENT, 900, "PAY-C3-F2"),
    ).resolves.toBeTruthy();
  });

  it("an in-flight FPX attempt does NOT block a manual transfer-slip submission", async () => {
    await initiateFpx("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03", CH_RENT, 900, "PAY-C3-F3");
    await expect(
      submit("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04", [{ chargeId: CH_RENT, allocatedAmount: 900 }], "PAY-C3-S1"),
    ).resolves.toBeTruthy();
  });

  it("an in-flight FPX attempt does NOT hide the charge from the tenant's payable list", async () => {
    await initiateFpx("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05", CH_RENT, 900, "PAY-C3-F4");
    const listed = await listPayableCharges(session, 1, 50);
    expect(listed.data.find((c) => c.id === CH_RENT)?.pendingVerification).toBe(false);
  });

  // ── the protection the guard actually exists for, still intact ──

  it("a submitted slip DOES block a second slip on the same charge", async () => {
    await submit("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06", [{ chargeId: CH_RENT, allocatedAmount: 900 }], "PAY-C3-S2");
    await expect(
      submit("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07", [{ chargeId: CH_RENT, allocatedAmount: 900 }], "PAY-C3-S3"),
    ).rejects.toThrow("CHARGE_PENDING_VERIFICATION");
  });

  it("a submitted slip DOES block an FPX attempt on the same charge", async () => {
    await submit("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa08", [{ chargeId: CH_RENT, allocatedAmount: 900 }], "PAY-C3-S4");
    await expect(
      initiateFpx("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa09", CH_RENT, 900, "PAY-C3-F5"),
    ).rejects.toThrow("CHARGE_PENDING_VERIFICATION");
  });

  // ── I-1 / F2: the guard is a read-then-write; it needs the row lock ──

  it("two concurrent submissions for one charge produce exactly ONE payment", async () => {
    const results = await Promise.allSettled([
      submit("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10", [{ chargeId: CH_RENT, allocatedAmount: 900 }], "PAY-C3-R1"),
      submit("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11", [{ chargeId: CH_RENT, allocatedAmount: 900 }], "PAY-C3-R2"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);

    // The invariant that matters to the admin: one debt, one card to action.
    const allocs = await getDb().paymentAllocation.findMany({
      where: { organizationId: ORG, chargeId: CH_RENT },
    });
    expect(allocs).toHaveLength(1);
  });

  // ── R5 / R6 / F3: what the admin actually sees ──

  it("the register red dot counts DISTINCT payments, so one slip over four charges reads 1", async () => {
    await seedDocuments();
    const db = getDb();
    for (const chargeId of [CH_RENT, CH_CARPARK, CH_WIFI, CH_CLEAN]) {
      await db.billingDocumentLine.create({
        data: { documentId: DOC_A, chargeId, description: `line ${chargeId.slice(-2)}`, amount: 1 },
      });
    }
    await submit("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12", [
      { chargeId: CH_RENT, allocatedAmount: 900 },
      { chargeId: CH_CARPARK, allocatedAmount: 120 },
      { chargeId: CH_WIFI, allocatedAmount: 50 },
      { chargeId: CH_CLEAN, allocatedAmount: 30 },
    ], "PAY-C3-D1");

    const { items } = await listBillingDocuments(ORG, { page: 1, pageSize: 25 } as never);
    const docA = items.find((d) => d.id === DOC_A);
    // 4 allocations, ONE transfer — badging "4" would misreport the backlog.
    expect(docA?.pendingVerificationCount).toBe(1);
  });

  it("an in-flight FPX attempt is absent from both the red dot and the verification panel", async () => {
    await seedDocuments();
    await getDb().billingDocumentLine.create({
      data: { documentId: DOC_A, chargeId: CH_RENT, description: "Room rent", amount: 900 },
    });
    await initiateFpx("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13", CH_RENT, 900, "PAY-C3-F6");

    const { items } = await listBillingDocuments(ORG, { page: 1, pageSize: 25 } as never);
    expect(items.find((d) => d.id === DOC_A)?.pendingVerificationCount).toBe(0);

    // Neither Approve nor Reject can action an in-flight FPX row (both 409 on
    // isInFlightFpx), so a card here would be permanently unclearable.
    const panel = await getPendingPaymentsForDocument(ORG, DOC_A);
    expect(panel).toEqual([]);
  });

  // ── F4: a transfer spanning two invoices must foot to the lines shown ──

  it("a payment spanning two invoices shows each invoice its own share, plus the full transfer", async () => {
    await seedDocuments();
    const db = getDb();
    await db.billingDocumentLine.create({
      data: { documentId: DOC_A, chargeId: CH_RENT, description: "Room rent", amount: 900 },
    });
    await db.billingDocumentLine.create({
      data: { documentId: DOC_B, chargeId: CH_CARPARK, description: "Carpark", amount: 120 },
    });
    await submit("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa14", [
      { chargeId: CH_RENT, allocatedAmount: 900 },
      { chargeId: CH_CARPARK, allocatedAmount: 120 },
    ], "PAY-C3-D2");

    const panelA = await getPendingPaymentsForDocument(ORG, DOC_A);
    expect(panelA).toHaveLength(1);
    // The slip says 1020 — that is what the admin matches to the bank statement.
    expect(panelA![0].amount).toBe("1020.00");
    // …but only 900 of it lands here, and that is what foots to the line shown.
    expect(panelA![0].allocatedToThisDocument).toBe("900.00");
    expect(panelA![0].spansOtherDocuments).toBe(true);
    expect(panelA![0].lines).toHaveLength(1);

    const panelB = await getPendingPaymentsForDocument(ORG, DOC_B);
    expect(panelB![0].allocatedToThisDocument).toBe("120.00");
    expect(panelB![0].spansOtherDocuments).toBe(true);
  });

  it("a single-invoice payment reports no cross-document spread", async () => {
    await seedDocuments();
    await getDb().billingDocumentLine.create({
      data: { documentId: DOC_A, chargeId: CH_RENT, description: "Room rent", amount: 900 },
    });
    await submit("c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa15", [{ chargeId: CH_RENT, allocatedAmount: 900 }], "PAY-C3-D3");

    const panel = await getPendingPaymentsForDocument(ORG, DOC_A);
    expect(panel![0].allocatedToThisDocument).toBe("900.00");
    expect(panel![0].amount).toBe("900.00");
    expect(panel![0].spansOtherDocuments).toBe(false);
  });
});
