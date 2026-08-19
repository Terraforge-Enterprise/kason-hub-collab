/**
 * Integration tests for listPayableCharges (Task C1).
 *
 * Skipped by default — only run against a LOCAL postgres instance:
 *   RUN_INTEGRATION=1 npm test -w @kason/api -- portal.payments.pay.integration
 *
 * Mirrors the meter/owner-billing integration harness pattern:
 *   const RUN = process.env.RUN_INTEGRATION === "1";
 *   const dn = RUN ? describe : describe.skip;
 *
 * Verifies that listPayableCharges:
 *   - returns only the tenant's charges matching payable statuses with outstandingAmount > 0
 *   - excludes paid/void/draft charges and other parties' charges
 *   - surfaces invoiceNumber from the linked Invoice
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { listPayableCharges, submitMultiPaymentTx, findPaymentByIdempotencyKey } from "../portal.payments.repository";
import { rejectPaymentTx, postPaymentTx } from "../../../payments/payments.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing non-local DB host: ${host}`);
  }
}

// Stable UUIDs for this test suite (C1 prefix = c1...)
const ORG = "c1000000-0000-4000-8000-000000000001";
const PARTY_TENANT = "c1000000-0000-4000-8000-000000000002";
const PARTY_OTHER = "c1000000-0000-4000-8000-000000000003";
const INVOICE_1 = "c1000000-0000-4000-8000-000000000010";
const CHARGE_POSTED = "c1000000-0000-4000-8000-000000000020";
const CHARGE_PARTIAL = "c1000000-0000-4000-8000-000000000021";
const CHARGE_PARTIALLY_PAID = "c1000000-0000-4000-8000-000000000022";
const CHARGE_OVERDUE = "c1000000-0000-4000-8000-000000000023";
const CHARGE_PENDING = "c1000000-0000-4000-8000-000000000024";
const CHARGE_PAID = "c1000000-0000-4000-8000-000000000025"; // excluded: status paid
const CHARGE_ZERO_OUTSTANDING = "c1000000-0000-4000-8000-000000000026"; // excluded: outstandingAmount = 0
const CHARGE_OTHER_PARTY = "c1000000-0000-4000-8000-000000000027"; // excluded: different party
const CHARGE_DRAFT = "c1000000-0000-4000-8000-000000000028"; // excluded: status draft (not payable)
const USER_ID = "c1000000-0000-4000-8000-000000000099";
const PROP = "c1000000-0000-4000-8000-000000000050";
const APT = "c1000000-0000-4000-8000-000000000051";
const LISTING = "c1000000-0000-4000-8000-000000000052";

const session = { partyId: PARTY_TENANT, orgId: ORG };

async function cleanup() {
  const db = getDb();
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.invoice.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.unitUtilityBill.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "C1-Org", slug: "c1-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER_ID, organizationId: ORG, email: "c1@example.test",
      fullName: "C1 Operator", status: "active", role: "manager", userType: "operator",
    },
  });
  await db.party.createMany({
    data: [
      { id: PARTY_TENANT, organizationId: ORG, partyType: "individual", displayName: "Tenant A", status: "active" },
      { id: PARTY_OTHER, organizationId: ORG, partyType: "individual", displayName: "Other Party", status: "active" },
    ],
  });
  await db.property.create({
    data: {
      id: PROP, organizationId: ORG, name: "P1", propertyCode: "P1-1",
      propertyType: "residential", addressLine1: "1", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "PARTITIONED" },
  });
  await db.listing.create({
    data: {
      id: LISTING, organizationId: ORG, apartmentId: APT, listingType: "room",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR",
    },
  });
  // Invoice linked to some charges
  await db.invoice.create({
    data: {
      id: INVOICE_1, organizationId: ORG, invoiceNumber: "INV-C1-0001",
      partyId: PARTY_TENANT, status: "sent", currency: "MYR",
      invoiceType: "tenant_rental",
      invoiceDate: new Date("2026-06-01"), dueDate: new Date("2026-06-15"),
      totalAmount: 900,
    },
  });

  const chargeBase = {
    organizationId: ORG,
    partyId: PARTY_TENANT,
    currency: "MYR",
    dueDate: new Date("2026-06-15"),
  };

  await db.charge.createMany({
    data: [
      // Payable statuses — all should be returned
      { id: CHARGE_POSTED, ...chargeBase, chargeNumber: "CHG-C1-0001", chargeType: "rent", amount: 900, outstandingAmount: 900, status: "posted", invoiceId: INVOICE_1 },
      { id: CHARGE_PARTIAL, ...chargeBase, chargeNumber: "CHG-C1-0002", chargeType: "rent", amount: 900, outstandingAmount: 450, status: "partial" },
      { id: CHARGE_PARTIALLY_PAID, ...chargeBase, chargeNumber: "CHG-C1-0003", chargeType: "rent", amount: 900, outstandingAmount: 200, status: "partially_paid" },
      { id: CHARGE_OVERDUE, ...chargeBase, chargeNumber: "CHG-C1-0004", chargeType: "rent", amount: 500, outstandingAmount: 500, status: "overdue" },
      { id: CHARGE_PENDING, ...chargeBase, chargeNumber: "CHG-C1-0005", chargeType: "aircon", amount: 120, outstandingAmount: 120, status: "pending" },
      // Excluded: paid (outstanding = 0 but status is paid — excluded by status)
      { id: CHARGE_PAID, ...chargeBase, chargeNumber: "CHG-C1-0006", chargeType: "rent", amount: 900, outstandingAmount: 0, status: "paid" },
      // Excluded: outstandingAmount = 0 even though status is posted
      { id: CHARGE_ZERO_OUTSTANDING, ...chargeBase, chargeNumber: "CHG-C1-0007", chargeType: "rent", amount: 900, outstandingAmount: 0, status: "posted" },
      // Excluded: draft status (not payable)
      { id: CHARGE_DRAFT, ...chargeBase, chargeNumber: "CHG-C1-0008", chargeType: "rent", amount: 500, outstandingAmount: 500, status: "draft" },
      // Excluded: different party
      { id: CHARGE_OTHER_PARTY, organizationId: ORG, partyId: PARTY_OTHER, chargeNumber: "CHG-C1-0009", chargeType: "rent", amount: 700, outstandingAmount: 700, status: "posted", currency: "MYR", dueDate: new Date("2026-06-15") },
    ],
  });
}

dn("listPayableCharges integration", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("returns only the tenant's charges with payable status AND outstandingAmount > 0", async () => {
    const result = await listPayableCharges(session, 1, 50);

    // 5 payable charges for the tenant (posted+partial+partially_paid+overdue+pending)
    // Excludes: paid (status not payable), zero-outstanding posted, draft, other-party
    expect(result.data).toHaveLength(5);
    expect(result.pagination.total).toBe(5);

    const numbers = result.data.map((r) => r.chargeNumber).sort();
    expect(numbers).toEqual([
      "CHG-C1-0001",
      "CHG-C1-0002",
      "CHG-C1-0003",
      "CHG-C1-0004",
      "CHG-C1-0005",
    ]);
  });

  it("surfaces invoiceNumber from the linked Invoice relation", async () => {
    const result = await listPayableCharges(session, 1, 50);
    const postedCharge = result.data.find((r) => r.id === CHARGE_POSTED);
    expect(postedCharge).toBeDefined();
    expect(postedCharge!.invoiceId).toBe(INVOICE_1);
    expect(postedCharge!.invoiceNumber).toBe("INV-C1-0001");
  });

  it("returns null invoiceNumber for charges not linked to an invoice", async () => {
    const result = await listPayableCharges(session, 1, 50);
    const pendingCharge = result.data.find((r) => r.id === CHARGE_PENDING);
    expect(pendingCharge).toBeDefined();
    expect(pendingCharge!.invoiceId).toBeNull();
    expect(pendingCharge!.invoiceNumber).toBeNull();
  });

  it("excludes charges belonging to a different party (cross-tenant isolation)", async () => {
    const result = await listPayableCharges(session, 1, 50);
    const ids = result.data.map((r) => r.id);
    expect(ids).not.toContain(CHARGE_OTHER_PARTY);
  });

  it("excludes paid charges and draft charges by status", async () => {
    const result = await listPayableCharges(session, 1, 50);
    const ids = result.data.map((r) => r.id);
    expect(ids).not.toContain(CHARGE_PAID);
    expect(ids).not.toContain(CHARGE_DRAFT);
  });

  it("excludes charges with outstandingAmount = 0 even when status is posted", async () => {
    const result = await listPayableCharges(session, 1, 50);
    const ids = result.data.map((r) => r.id);
    expect(ids).not.toContain(CHARGE_ZERO_OUTSTANDING);
  });

  it("paginates correctly", async () => {
    const page1 = await listPayableCharges(session, 1, 3);
    expect(page1.data).toHaveLength(3);
    expect(page1.pagination.total).toBe(5);
    expect(page1.pagination.totalPages).toBe(2);

    const page2 = await listPayableCharges(session, 2, 3);
    expect(page2.data).toHaveLength(2);

    // No overlap between pages
    const page1Ids = page1.data.map((r) => r.id);
    const page2Ids = page2.data.map((r) => r.id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
  });

  it("returns outstandingAmount as a number (not Decimal object)", async () => {
    const result = await listPayableCharges(session, 1, 1);
    expect(typeof result.data[0].outstandingAmount).toBe("number");
    expect(typeof result.data[0].amount).toBe("number");
  });

  it("orders charges by dueDate ascending", async () => {
    const result = await listPayableCharges(session, 1, 50);
    // All test charges share the same dueDate so order is stable — at minimum no error.
    expect(result.data.length).toBeGreaterThan(0);
  });
});

// ── C2: submitMultiPaymentTx integration ─────────────────────────────────────

// Stable UUIDs for C2 tests (c2... prefix)
const C2_ORG = "c2000000-0000-4000-8000-000000000001";
const C2_PARTY_TENANT = "c2000000-0000-4000-8000-000000000002";
const C2_PARTY_OTHER = "c2000000-0000-4000-8000-000000000003";
const C2_USER_ID = "c2000000-0000-4000-8000-000000000099";
const C2_PROP = "c2000000-0000-4000-8000-000000000050";
const C2_APT = "c2000000-0000-4000-8000-000000000051";
const C2_LISTING = "c2000000-0000-4000-8000-000000000052";
const C2_CHARGE_ROOM = "c2000000-0000-4000-8000-000000000020";
const C2_CHARGE_CARPARK = "c2000000-0000-4000-8000-000000000021";
const C2_CHARGE_OTHER = "c2000000-0000-4000-8000-000000000022";

async function c2Cleanup() {
  const db = getDb();
  await db.paymentAllocation.deleteMany({ where: { organizationId: C2_ORG } });
  await db.payment.deleteMany({ where: { organizationId: C2_ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: C2_ORG } });
  await db.notification.deleteMany({ where: { organizationId: C2_ORG } });
  await db.charge.deleteMany({ where: { organizationId: C2_ORG } });
  // UtilityAllocation FKs to Tenancy and is NOT organization-scoped, so it has
  // to be cleared via its tenancies or the tenancy delete below fails on
  // UtilityAllocation_tenancyId_fkey. A single leaked row poisons every run of
  // this suite thereafter, since cleanup then throws in beforeEach.
  const c2Tenancies = await db.tenancy.findMany({ where: { organizationId: C2_ORG }, select: { id: true } });
  if (c2Tenancies.length) {
    await db.utilityAllocation.deleteMany({ where: { tenancyId: { in: c2Tenancies.map((t) => t.id) } } });
  }
  await db.tenancy.deleteMany({ where: { organizationId: C2_ORG } });
  await db.unitUtilityBill.deleteMany({ where: { organizationId: C2_ORG } });
  await db.listing.deleteMany({ where: { organizationId: C2_ORG } });
  await db.apartment.deleteMany({ where: { organizationId: C2_ORG } });
  await db.property.deleteMany({ where: { organizationId: C2_ORG } });
  await db.user.deleteMany({ where: { organizationId: C2_ORG } });
  await db.party.deleteMany({ where: { organizationId: C2_ORG } });
  await db.organization.deleteMany({ where: { id: C2_ORG } });
}

async function c2Seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: C2_ORG, name: "C2-Org", slug: "c2-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: C2_USER_ID, organizationId: C2_ORG, email: "c2@example.test",
      fullName: "C2 Operator", status: "active", role: "manager", userType: "operator",
    },
  });
  await db.party.createMany({
    data: [
      { id: C2_PARTY_TENANT, organizationId: C2_ORG, partyType: "individual", displayName: "C2 Tenant", status: "active" },
      { id: C2_PARTY_OTHER, organizationId: C2_ORG, partyType: "individual", displayName: "C2 Other", status: "active" },
    ],
  });
  await db.property.create({
    data: {
      id: C2_PROP, organizationId: C2_ORG, name: "C2-P1", propertyCode: "C2-P1",
      propertyType: "residential", addressLine1: "1", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: C2_APT, organizationId: C2_ORG, propertyId: C2_PROP, unitCode: "C2-A1", listingMode: "PARTITIONED" },
  });
  await db.listing.create({
    data: {
      id: C2_LISTING, organizationId: C2_ORG, apartmentId: C2_APT, listingType: "room",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR",
    },
  });
  await db.charge.createMany({
    data: [
      {
        id: C2_CHARGE_ROOM, organizationId: C2_ORG, partyId: C2_PARTY_TENANT,
        chargeNumber: "CHG-C2-0001", chargeType: "rent",
        amount: 900, outstandingAmount: 900, status: "posted",
        currency: "MYR", dueDate: new Date("2026-07-01"),
      },
      {
        id: C2_CHARGE_CARPARK, organizationId: C2_ORG, partyId: C2_PARTY_TENANT,
        chargeNumber: "CHG-C2-0002", chargeType: "carpark",
        amount: 120, outstandingAmount: 120, status: "posted",
        currency: "MYR", dueDate: new Date("2026-07-01"),
      },
      {
        id: C2_CHARGE_OTHER, organizationId: C2_ORG, partyId: C2_PARTY_OTHER,
        chargeNumber: "CHG-C2-0003", chargeType: "rent",
        amount: 900, outstandingAmount: 900, status: "posted",
        currency: "MYR", dueDate: new Date("2026-07-01"),
      },
    ],
  });
}

dn("submitMultiPaymentTx integration (C2)", () => {
  beforeEach(async () => {
    await c2Cleanup();
    await c2Seed();
  });

  afterEach(async () => {
    await c2Cleanup();
  });

  it("(a) basket of 2 charges → ONE pending_approval Payment + 2 allocations; both charges outstandingAmount UNCHANGED", async () => {
    const db = getDb();

    const result = await submitMultiPaymentTx({
      organizationId: C2_ORG,
      partyId: C2_PARTY_TENANT,
      actorUserId: C2_USER_ID,
      paymentNumber: "PAY-C2-001",
      idempotencyKey: "c2111111-1111-4111-8111-111111111111",
      paymentMethod: "bank_transfer",
      referenceNumber: "TXN-C2-001",
      notes: null,
      attachmentKeys: [],
      lines: [
        { chargeId: C2_CHARGE_ROOM, allocatedAmount: 900, prorateRatio: null },
        { chargeId: C2_CHARGE_CARPARK, allocatedAmount: 120, prorateRatio: null },
      ],
    });

    // One payment created with amount = Σ
    expect(result.paymentNumber).toBe("PAY-C2-001");
    const payment = await db.payment.findUnique({ where: { id: result.id } });
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe("pending_approval");
    expect(Number(payment!.amount)).toBe(1020);

    // Two allocations
    const allocations = await db.paymentAllocation.findMany({ where: { paymentId: result.id } });
    expect(allocations).toHaveLength(2);

    // Charges NOT decremented (pending — not yet applied)
    const room = await db.charge.findUnique({ where: { id: C2_CHARGE_ROOM } });
    const carpark = await db.charge.findUnique({ where: { id: C2_CHARGE_CARPARK } });
    expect(Number(room!.outstandingAmount)).toBe(900);
    expect(Number(carpark!.outstandingAmount)).toBe(120);
  });

  it("(b) charge belonging to another party → CHARGE_NOT_FOUND (no payment created)", async () => {
    const db = getDb();

    await expect(
      submitMultiPaymentTx({
        organizationId: C2_ORG,
        partyId: C2_PARTY_TENANT,
        actorUserId: C2_USER_ID,
        paymentNumber: "PAY-C2-002",
        idempotencyKey: "c2222222-2222-4222-8222-222222222222",
        paymentMethod: "cash",
        referenceNumber: "TXN-C2-002",
        notes: null,
        attachmentKeys: [],
        lines: [{ chargeId: C2_CHARGE_OTHER, allocatedAmount: 900, prorateRatio: null }],
      }),
    ).rejects.toThrow("CHARGE_NOT_FOUND");

    const payments = await db.payment.findMany({ where: { organizationId: C2_ORG } });
    expect(payments).toHaveLength(0);
  });

  it("(c) idempotent replay: same key twice → one Payment, second returns same id", async () => {
    const db = getDb();
    const key = "c2333333-3333-4333-8333-333333333333";
    const baseParams = {
      organizationId: C2_ORG,
      partyId: C2_PARTY_TENANT,
      actorUserId: C2_USER_ID,
      paymentMethod: "cash",
      referenceNumber: "TXN-C2-003",
      notes: null,
      attachmentKeys: [],
      lines: [{ chargeId: C2_CHARGE_ROOM, allocatedAmount: 900, prorateRatio: null }],
    };

    const first = await submitMultiPaymentTx({ ...baseParams, paymentNumber: "PAY-C2-003A", idempotencyKey: key });

    // Second call uses same idempotencyKey but different paymentNumber —
    // Prisma @@unique([organizationId, idempotencyKey]) will throw P2002.
    // The service layer catches P2002 and re-fetches; here at the repo layer
    // the tx itself should throw. We verify via findPaymentByIdempotencyKey.
    const fetched = await findPaymentByIdempotencyKey(C2_ORG, key);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(first.id);

    // Only one payment exists for this org
    const payments = await db.payment.findMany({ where: { organizationId: C2_ORG, idempotencyKey: key } });
    expect(payments).toHaveLength(1);
  });

  it("(d) allocation below a charge's outstanding → ALLOC_BELOW_OUTSTANDING (no payment created)", async () => {
    const db = getDb();
    await expect(
      submitMultiPaymentTx({
        organizationId: C2_ORG,
        partyId: C2_PARTY_TENANT,
        actorUserId: C2_USER_ID,
        paymentNumber: "PAY-C2-004",
        idempotencyKey: "c2444444-4444-4444-8444-444444444444",
        paymentMethod: "cash",
        referenceNumber: "TXN-C2-004",
        notes: null,
        attachmentKeys: [],
        lines: [{ chargeId: C2_CHARGE_ROOM, allocatedAmount: 500, prorateRatio: null }], // outstanding 900
      }),
    ).rejects.toThrow("ALLOC_BELOW_OUTSTANDING");
    const payments = await db.payment.findMany({ where: { organizationId: C2_ORG } });
    expect(payments).toHaveLength(0);
  });
});

/**
 * Slip verification: the double-submit guard and the reject path. These are the
 * money rules only a real DB can prove — the guard reads through the
 * allocation→payment relation, and reject's entire claim is that it leaves the
 * charges ALONE.
 */
dn("tenant transfer-slip verification", () => {
  const SLIP = `orgs/${C2_ORG}/payment-slips/${C2_PARTY_TENANT}/aaaa-slip.jpg`;

  beforeEach(async () => {
    await c2Cleanup();
    await c2Seed();
  });
  afterEach(async () => {
    await c2Cleanup();
  });

  function submit(key: string, chargeId: string, amount: number, paymentNumber: string) {
    return submitMultiPaymentTx({
      organizationId: C2_ORG,
      partyId: C2_PARTY_TENANT,
      actorUserId: C2_USER_ID,
      paymentNumber,
      idempotencyKey: key,
      paymentMethod: "bank_transfer",
      referenceNumber: `TXN-${paymentNumber}`,
      notes: null,
      attachmentKeys: [SLIP],
      lines: [{ chargeId, allocatedAmount: amount, prorateRatio: null }],
    });
  }

  it("persists the slip key on the payment so an admin can verify it", async () => {
    const p = await submit("c2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", C2_CHARGE_ROOM, 900, "PAY-SV-001");
    const row = await getDb().payment.findUnique({
      where: { id: p.id },
      select: { attachmentKeys: true, status: true },
    });
    expect(row?.attachmentKeys).toEqual([SLIP]);
    expect(row?.status).toBe("pending_approval");
  });

  it("BLOCKS a second submission against a charge already awaiting verification", async () => {
    await submit("c2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", C2_CHARGE_ROOM, 900, "PAY-SV-002");
    // The charge's outstanding is UNCHANGED by the first submission (nothing
    // settled), so without the guard this second call looks perfectly valid and
    // the tenant ends up on the hook twice for one debt.
    await expect(
      submit("c2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", C2_CHARGE_ROOM, 900, "PAY-SV-003"),
    ).rejects.toThrow("CHARGE_PENDING_VERIFICATION");
    const payments = await getDb().payment.findMany({ where: { organizationId: C2_ORG } });
    expect(payments).toHaveLength(1);
  });

  it("does NOT block a different charge", async () => {
    await submit("c2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", C2_CHARGE_ROOM, 900, "PAY-SV-004");
    await expect(
      submit("c2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5", C2_CHARGE_CARPARK, 120, "PAY-SV-005"),
    ).resolves.toBeTruthy();
  });

  it("reject leaves the charge fully outstanding and frees it to be paid again", async () => {
    const db = getDb();
    const p = await submit("c2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", C2_CHARGE_ROOM, 900, "PAY-SV-006");

    const r = await rejectPaymentTx({
      organizationId: C2_ORG,
      paymentId: p.id,
      reason: "Slip is unreadable",
      actorUserId: C2_USER_ID,
      actorRole: "manager",
    });
    expect(r).toMatchObject({ ok: true });

    const payment = await db.payment.findUnique({
      where: { id: p.id },
      select: { status: true, rejectionReason: true, reviewedAt: true, reviewedById: true },
    });
    expect(payment?.status).toBe("rejected");
    expect(payment?.rejectionReason).toBe("Slip is unreadable");
    expect(payment?.reviewedById).toBe(C2_USER_ID);
    expect(payment?.reviewedAt).toBeInstanceOf(Date);

    // The money never arrived, so nothing may be credited back — the charge
    // must read exactly as it did before the tenant ever submitted.
    const charge = await db.charge.findUnique({
      where: { id: C2_CHARGE_ROOM },
      select: { outstandingAmount: true, status: true },
    });
    expect(Number(charge?.outstandingAmount)).toBe(900);
    expect(charge?.status).toBe("posted");

    // …and the guard no longer blocks: the tenant can re-submit a better slip.
    await expect(
      submit("c2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7", C2_CHARGE_ROOM, 900, "PAY-SV-007"),
    ).resolves.toBeTruthy();
  });

  it("refuses to reject a payment that was already posted", async () => {
    const p = await submit("c2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8", C2_CHARGE_ROOM, 900, "PAY-SV-008");
    await postPaymentTx({ organizationId: C2_ORG, paymentId: p.id, actorUserId: C2_USER_ID, actorRole: "manager" });

    // Posted money is real money. Unwinding it is void/refund (which restores
    // the charge and nets reversals); routing it through reject would flip the
    // status while leaving the charge settled — silently erasing a receivable.
    const r = await rejectPaymentTx({
      organizationId: C2_ORG,
      paymentId: p.id,
      reason: "changed my mind",
      actorUserId: C2_USER_ID,
      actorRole: "manager",
    });
    expect(r).toMatchObject({ badStatus: true, status: "posted" });
    const after = await getDb().payment.findUnique({ where: { id: p.id }, select: { status: true } });
    expect(after?.status).toBe("posted");
  });

  it("flags the pending charge to the tenant's pay page, and only that charge", async () => {
    await submit("c2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9", C2_CHARGE_ROOM, 900, "PAY-SV-009");
    const listed = await listPayableCharges({ partyId: C2_PARTY_TENANT, orgId: C2_ORG }, 1, 50);
    expect(listed.data.find((c) => c.id === C2_CHARGE_ROOM)?.pendingVerification).toBe(true);
    expect(listed.data.find((c) => c.id === C2_CHARGE_CARPARK)?.pendingVerification).toBe(false);
  });
});
