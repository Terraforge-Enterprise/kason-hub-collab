/**
 * R3 — prior_period_collection forward flow for paid-after-freeze cash
 * (integration, RUN_INTEGRATION=1). The HIGHEST-RISK money slice: an income
 * (rent) ledger row freezes at COLLECTED = amount − outstanding, so an UNPAID
 * charge freezes at 0. When the tenant pays AFTER freeze, the frozen month is
 * immutable — the newly-collected cash must post FORWARD as a
 * `prior_period_collection` row into the CURRENT open month (never mutating the
 * frozen row or its snapshot).
 *
 * Frozen month = the calendar month BEFORE now; current open month = now's month
 * (derived at runtime so the suite is date-independent — the forward row always
 * targets the real current UTC month the service computes).
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER=1 \
 *     npx vitest run \
 *     src/modules/owner-ledger/__tests__/prior-period-collection.integration.test.ts \
 *     --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "@kason/db";
import { syncMonthService } from "../owner-ledger.sync";
import { syncOwnerLedgerForCharges } from "../owner-ledger.sync-hook";
import { resolveOwnerBalance } from "../owner-ledger.repository";
import { postPriorPeriodCollections } from "../prior-period-collection";
import { voidPaymentTx } from "../../payments/payments.repository";
import { freezeStatementPeriod } from "../../owner-billing/owner-statement-period.service";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 9cd1; unused by any other suite) ───────────────
const ORG = "9cd10000-0000-4000-8000-000000000001";
const USER = "9cd10000-0000-4000-8000-000000000002";
const OWNER = "9cd10000-0000-4000-8000-000000000003";
const TENANT = "9cd10000-0000-4000-8000-000000000004";
const PROP = "9cd10000-0000-4000-8000-000000000005";
const APT = "9cd10000-0000-4000-8000-000000000006";
const UNIT = "9cd10000-0000-4000-8000-000000000007";
const TEN = "9cd10000-0000-4000-8000-000000000008";
const C_RENT = "9cd10000-0000-4000-8000-000000000009";
const C_RENT2 = "9cd10000-0000-4000-8000-00000000000a";
const C_EXP = "9cd10000-0000-4000-8000-00000000000b";
const CARPARK = "9cd10000-0000-4000-8000-00000000000c";
const CP_CHARGE = "9cd10000-0000-4000-8000-00000000000d";

const ledgerCtx: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };
const billingCtx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

// ── Runtime-derived months (date-independent) ──────────────────────────────────
const NOW = new Date();
const curStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
const frozenStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1));
const ym = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const FROZEN_M = ym(frozenStart);
const CUR_M = ym(curStart);
const frozenDue = new Date(Date.UTC(frozenStart.getUTCFullYear(), frozenStart.getUTCMonth(), 5));
// A deterministic "received in the open month" date used for allocatedAt (transactionDate).
const RECEIVED = new Date(Date.UTC(curStart.getUTCFullYear(), curStart.getUTCMonth(), 10));

let savedBilling: string | undefined;
let savedLedger: string | undefined;
let payCounter = 0;

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.paymentAllocationReversal.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.ownerStatementFreezeManifestRow.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.carpark.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "9CD1 Prior-Period Collection Org",
      slug: "9cd1-prior-period-collection-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "9cd1@test.local", passwordHash: "x", role: "admin", status: "active", fullName: "9CD1 Admin" },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "PPC Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "PPC Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROP, organizationId: ORG, name: "PPC Tower", propertyCode: "PPC-P1", propertyType: "apartment", addressLine1: "1 PPC St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "PPC-01-01", listingMode: "WHOLE" } });
  await db.listing.create({
    data: {
      id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "Whole Unit",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER,
    },
  });
  await db.tenancy.create({
    data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "PPC-T1", status: "active", billingStatus: "current", startDate: new Date(Date.UTC(2025, 0, 1)), monthlyRentAmount: "800" },
  });
}

async function makeRentCharge(o: {
  id: string;
  status: string;
  amount: string;
  outstanding: string;
  billingMonth: Date;
  dueDate: Date;
  number: string;
}) {
  return getDb().charge.create({
    data: {
      id: o.id,
      organizationId: ORG,
      chargeNumber: o.number,
      partyId: TENANT,
      tenancyId: TEN,
      unitId: UNIT,
      chargeType: "rent",
      status: o.status,
      postedAt: new Date(),
      dueDate: o.dueDate,
      amount: o.amount,
      currency: "MYR",
      outstandingAmount: o.outstanding,
      billingMonth: o.billingMonth,
    },
  });
}

/**
 * Record a tenant payment ALLOCATED to a charge, with explicit control over the
 * allocation's `createdAt` (the freeze-boundary discriminator) and `allocatedAt`
 * (the actual received date → the forward row's transactionDate). Returns the
 * allocation id so a later reversal can target it.
 */
async function payCharge(o: { chargeId: string; amount: string; allocatedAt: Date; createdAt: Date }): Promise<string> {
  const db = getDb();
  const paymentId = randomUUID();
  await db.payment.create({
    data: {
      id: paymentId,
      organizationId: ORG,
      paymentNumber: `PPC-PAY-${++payCounter}`,
      partyId: TENANT,
      paymentType: "tenant_payment",
      paymentMethod: "bank_transfer",
      // "posted" — the ONLY status that means money arrived. This fixture read
      // "completed", which the production code writes nowhere (see
      // PAYMENT_STATUSES); the forward-collection readers now filter on
      // CASH_ALLOCATION_WHERE, so a fictional status would make every test here
      // see zero allocations — and, worse, these suites would have passed even
      // if those readers ignored payment status entirely.
      status: "posted",
      amount: o.amount,
      currency: "MYR",
      receivedAt: o.allocatedAt,
    },
  });
  const allocId = randomUUID();
  await db.paymentAllocation.create({
    data: {
      id: allocId,
      organizationId: ORG,
      paymentId,
      chargeId: o.chargeId,
      allocatedAmount: o.amount,
      allocatedAt: o.allocatedAt,
      createdAt: o.createdAt,
    },
  });
  return allocId;
}

/** Append a PaymentAllocationReversal against an allocation (append-only; a reroute = reverse + new alloc). */
async function reverseAllocation(o: { allocationId: string; amount: string; createdAt: Date }): Promise<string> {
  const db = getDb();
  const id = randomUUID();
  await db.paymentAllocationReversal.create({
    data: {
      id,
      organizationId: ORG,
      originalAllocationId: o.allocationId,
      amount: o.amount,
      reason: "reroute",
      reversedById: USER,
      createdAt: o.createdAt,
      idempotencyKey: `PPC-REV-${id}`,
    },
  });
  return id;
}

const collectionRows = (chargeId: string) =>
  getDb().ownerLedgerEntry.findMany({
    where: { organizationId: ORG, sourceType: "prior_period_collection", sourceChargeId: chargeId },
    orderBy: { amount: "asc" },
  });

const reversalRows = (chargeId: string) =>
  getDb().ownerLedgerEntry.findMany({
    where: { organizationId: ORG, sourceType: "prior_period_collection_reversal", sourceChargeId: chargeId },
    orderBy: { amount: "asc" },
  });

/** Seed an UNPAID rent charge in the frozen month, materialise it (collected 0), and freeze. */
async function freezeUnpaidRent(o: { id: string; amount: string; number: string }) {
  await makeRentCharge({ id: o.id, status: "posted", amount: o.amount, outstanding: o.amount, billingMonth: frozenStart, dueDate: frozenDue, number: o.number });
  await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
  const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
  return { frozen, firstFrozenAt: frozen.firstFrozenAt as Date };
}

dn("postPriorPeriodCollections — paid-after-freeze forward flow (R3, integration)", () => {
  beforeAll(() => {
    savedBilling = process.env.ENABLE_PHASE2_OWNER_BILLING;
    savedLedger = process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = "1";
  });
  afterAll(async () => {
    if (savedBilling === undefined) delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    else process.env.ENABLE_PHASE2_OWNER_BILLING = savedBilling;
    if (savedLedger === undefined) delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    else process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = savedLedger;
    await cleanup();
  });
  beforeEach(async () => {
    payCounter = 0;
    await cleanup();
    await seedBase();
  });

  // ── B1: full payment after freeze → one forward collection in the open month ────
  it("B1: unpaid frozen rent paid in full after freeze posts one prior_period_collection into the open month; frozen row + snapshot unchanged; open-month payout reflects it", async () => {
    const db = getDb();
    // Unpaid rent charge in the frozen month → collected 0 at freeze.
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-RENT-1" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT } });
    expect(Number(normal.amount.toString())).toBe(0);
    expect(normal.paymentStatus).toBe("pending");

    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const beforeSnap = JSON.stringify(frozen.snapshotJson);
    const beforeClosing = frozen.closingBalanceC;
    expect(frozen.firstFrozenAt).toBeTruthy();
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // Tenant pays IN FULL after freeze.
    await payCharge({ chargeId: C_RENT, amount: "800.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    // Exactly one forward-collection row, in the OPEN month, income, full amount.
    const cols = await collectionRows(C_RENT);
    expect(cols).toHaveLength(1);
    const col = cols[0]!;
    expect(col.direction).toBe("income"); // preserved from the normal row (NOT flipped)
    expect(col.category).toBe("rental_income");
    expect(Number(col.amount.toString())).toBe(800);
    expect(col.statementMonth.getTime()).toBe(curStart.getTime());
    expect(col.paymentStatus).toBe("paid");
    expect(col.includeInPayout).toBe(true);
    expect(col.status).toBe("active");
    expect(col.sourceAllocationEventId).toBeTruthy(); // B6: NON-NULL (else not deduped)
    expect(col.transactionDate.toISOString().slice(0, 10)).toBe(RECEIVED.toISOString().slice(0, 10));

    // Frozen normal row is byte-untouched.
    const normalAfter = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: normal.id } });
    expect(Number(normalAfter.amount.toString())).toBe(0);
    expect(normalAfter.statementMonth.getTime()).toBe(frozenStart.getTime());
    expect(normalAfter.status).toBe("active");
    expect(normalAfter.paymentStatus).toBe("pending");

    // Frozen snapshot + closing balance are unchanged.
    const periodAfter = await db.ownerStatementPeriod.findUniqueOrThrow({ where: { id: frozen.id } });
    expect(JSON.stringify(periodAfter.snapshotJson)).toBe(beforeSnap);
    expect(periodAfter.closingBalanceC).toBe(beforeClosing);

    // Owner payout for the OPEN month reflects the +800 collection.
    const bal = await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M);
    expect(bal.netThisPeriod).toBe("800.00");
  });

  // ── Slip verification: an UNVERIFIED or REFUSED claim is not owner cash ────────
  // Portal payments mint allocations at submit time while the payment is still
  // unsettled, and nothing ever removes them — expiry, gateway failure and an
  // admin's rejection all leave the allocation in place by design. Before these
  // readers filtered on CASH_ALLOCATION_WHERE, any of those paid the owner real
  // money for cash that never arrived.
  it("a tenant's UNVERIFIED slip against a frozen-month charge posts NO forward collection", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-PEND-1" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // Tenant submits a transfer slip: allocation exists, charge UNTOUCHED
    // (submitMultiPaymentTx settles nothing), payment awaiting an admin.
    const paymentId = randomUUID();
    await db.payment.create({
      data: {
        id: paymentId, organizationId: ORG, paymentNumber: "PPC-PAY-PEND", partyId: TENANT,
        paymentType: "tenant_payment", paymentMethod: "bank_transfer", status: "pending_approval",
        amount: "800.00", currency: "MYR", receivedAt: RECEIVED,
      },
    });
    await db.paymentAllocation.create({
      data: {
        id: randomUUID(), organizationId: ORG, paymentId, chargeId: C_RENT,
        allocatedAmount: "800.00", allocatedAt: RECEIVED,
        createdAt: new Date(firstFrozenAt.getTime() + 60_000),
      },
    });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    expect(await collectionRows(C_RENT)).toHaveLength(0);
    const bal = await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M);
    expect(bal.netThisPeriod).toBe("0.00");
  });

  it("a REJECTED slip posts no forward collection, and approving a real payment later still does", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-REJ-1" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // An admin read the slip and refused it. rejectPaymentTx deliberately leaves
    // the allocation in place as the evidence trail — so it is still here.
    const rejectedId = randomUUID();
    await db.payment.create({
      data: {
        id: rejectedId, organizationId: ORG, paymentNumber: "PPC-PAY-REJ", partyId: TENANT,
        paymentType: "tenant_payment", paymentMethod: "bank_transfer", status: "rejected",
        rejectionReason: "Slip is unreadable", amount: "800.00", currency: "MYR", receivedAt: RECEIVED,
      },
    });
    await db.paymentAllocation.create({
      data: {
        id: randomUUID(), organizationId: ORG, paymentId: rejectedId, chargeId: C_RENT,
        allocatedAmount: "800.00", allocatedAt: RECEIVED,
        createdAt: new Date(firstFrozenAt.getTime() + 60_000),
      },
    });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    expect(await collectionRows(C_RENT)).toHaveLength(0);

    // The tenant re-submits and this time it IS verified — the owner must be
    // paid, so the filter cannot simply be suppressing everything.
    await payCharge({ chargeId: C_RENT, amount: "800.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 120_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    const cols = await collectionRows(C_RENT);
    expect(cols).toHaveLength(1);
    expect(Number(cols[0]!.amount.toString())).toBe(800);
    const bal = await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M);
    expect(bal.netThisPeriod).toBe("800.00");
  });

  // Money that WAS received and is then clawed back must un-credit the owner.
  // This is the mirror of the two tests above and the boundary between them:
  // "never was cash" (pending/rejected) must not credit, but "was cash, then
  // given back" (void/refund) must credit AND then reverse. A filter that
  // cannot tell those apart hides the reversal and strands the credit forever —
  // no re-run repairs it, because the allocation stays invisible.
  //
  // The trigger is the ordinary admin Void/Refund button on a bounced cheque or
  // a chargeback, well inside the 180-day window.
  it("voiding a forward-collected payment posts the compensating reversal (owner not left over-credited)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-VOID-1" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // Real money arrives after the freeze and is forward-collected.
    const paymentId = randomUUID();
    await db.payment.create({
      data: {
        id: paymentId, organizationId: ORG, paymentNumber: "PPC-PAY-VOID", partyId: TENANT,
        paymentType: "tenant_payment", paymentMethod: "bank_transfer", status: "posted",
        amount: "800.00", currency: "MYR", receivedAt: RECEIVED,
      },
    });
    await db.paymentAllocation.create({
      data: {
        id: randomUUID(), organizationId: ORG, paymentId, chargeId: C_RENT,
        allocatedAmount: "800.00", allocatedAt: RECEIVED,
        createdAt: new Date(firstFrozenAt.getTime() + 60_000),
      },
    });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    expect(await collectionRows(C_RENT)).toHaveLength(1);
    expect((await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M)).netThisPeriod).toBe("800.00");

    // Cheque bounces. The real void path: writes a PaymentAllocationReversal
    // (only because the payment WAS posted), restores the charge, flips the
    // payment to "void".
    const r = await voidPaymentTx({
      organizationId: ORG, paymentId, status: "void", referenceNote: "bounced",
      actorUserId: USER, actorRole: "manager",
    });
    expect("ok" in r).toBe(true);
    expect(await db.paymentAllocationReversal.count({ where: { organizationId: ORG } })).toBe(1);

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    // The compensating (−) row must exist and net the owner back to zero. The
    // original (+) row stays — this is event-sourced, never mutated.
    const revs = await reversalRows(C_RENT);
    expect(revs).toHaveLength(1);
    expect(Number(revs[0]!.amount.toString())).toBe(800);
    expect(await collectionRows(C_RENT)).toHaveLength(1);
    expect((await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M)).netThisPeriod).toBe("0.00");
  });

  it("refunding a forward-collected payment also un-credits the owner", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-REFUND-1" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    const paymentId = randomUUID();
    await db.payment.create({
      data: {
        id: paymentId, organizationId: ORG, paymentNumber: "PPC-PAY-REFUND", partyId: TENANT,
        paymentType: "tenant_payment", paymentMethod: "bank_transfer", status: "posted",
        amount: "800.00", currency: "MYR", receivedAt: RECEIVED,
      },
    });
    await db.paymentAllocation.create({
      data: {
        id: randomUUID(), organizationId: ORG, paymentId, chargeId: C_RENT,
        allocatedAmount: "800.00", allocatedAt: RECEIVED,
        createdAt: new Date(firstFrozenAt.getTime() + 60_000),
      },
    });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    expect((await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M)).netThisPeriod).toBe("800.00");

    await voidPaymentTx({
      organizationId: ORG, paymentId, status: "refunded", referenceNote: "chargeback",
      actorUserId: USER, actorRole: "manager",
    });
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    expect((await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M)).netThisPeriod).toBe("0.00");
  });

  // A clawback may only net against credit that ACTUALLY EXISTS. Payment status
  // tells you money once arrived; it does not tell you the owner was ever
  // credited for it. Posting a (−) with no matching (+) debits the owner out of
  // nothing — and unlike an over-credit, it leaves a debit with no credit
  // anywhere to point at.
  it("a reversal on an allocation that was NEVER credited posts nothing (owner not debited out of nothing)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-C1" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // Tenant submits a slip; nothing settles, so NO credit is ever posted.
    const paymentId = randomUUID();
    const allocId = randomUUID();
    await db.payment.create({
      data: {
        id: paymentId, organizationId: ORG, paymentNumber: "PPC-PAY-C1", partyId: TENANT,
        paymentType: "tenant_payment", paymentMethod: "bank_transfer", status: "pending_approval",
        amount: "800.00", currency: "MYR", receivedAt: RECEIVED,
      },
    });
    await db.paymentAllocation.create({
      data: {
        id: allocId, organizationId: ORG, paymentId, chargeId: C_RENT,
        allocatedAmount: "800.00", allocatedAt: RECEIVED,
        createdAt: new Date(firstFrozenAt.getTime() + 60_000),
      },
    });
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    expect(await collectionRows(C_RENT)).toHaveLength(0); // no credit — correct

    // A reversal lands on that never-credited allocation. reverseAllocationInTx
    // writes the row unconditionally (it consults payment.status only to decide
    // whether to restore the charge), and correction-replace reads a charge's
    // allocations with no payment filter — so this needs nobody to do anything
    // unusual.
    await db.paymentAllocationReversal.create({
      data: {
        id: randomUUID(), organizationId: ORG, originalAllocationId: allocId,
        amount: "800.00", reason: "cancel-and-replace", reversedById: USER,
        idempotencyKey: randomUUID(), createdAt: new Date(firstFrozenAt.getTime() + 120_000),
      },
    });
    // The payment is then voided — which is what made it "ever cash" to a
    // status-based filter, even though no money ever arrived.
    await db.payment.update({ where: { id: paymentId }, data: { status: "void" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    expect(await reversalRows(C_RENT)).toHaveLength(0);
    expect((await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M)).netThisPeriod).toBe("0.00");
  });

  it("a void racing the credit run posts no orphan clawback, and the credit still lands later", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-C2" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // Real posted money — but the forward-collection run never fired for it
    // (postPriorPeriodCollections swallows all errors by design, so a transient
    // failure silently skips the credit).
    const paymentId = randomUUID();
    await db.payment.create({
      data: {
        id: paymentId, organizationId: ORG, paymentNumber: "PPC-PAY-C2", partyId: TENANT,
        paymentType: "tenant_payment", paymentMethod: "bank_transfer", status: "posted",
        amount: "800.00", currency: "MYR", receivedAt: RECEIVED,
      },
    });
    await db.paymentAllocation.create({
      data: {
        id: randomUUID(), organizationId: ORG, paymentId, chargeId: C_RENT,
        allocatedAmount: "800.00", allocatedAt: RECEIVED,
        createdAt: new Date(firstFrozenAt.getTime() + 60_000),
      },
    });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });

    // Voided BEFORE any collection run posted the credit.
    await voidPaymentTx({
      organizationId: ORG, paymentId, status: "void", referenceNote: "bounced",
      actorUserId: USER, actorRole: "manager",
    });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    // No credit was ever recognised, so no clawback may post.
    expect(await reversalRows(C_RENT)).toHaveLength(0);
    expect((await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M)).netThisPeriod).toBe("0.00");
  });

  // ── B7: a frozen period with NO manifest (firstFrozenAt null) → early return ─────
  it("B7: a legacy frozen period lacking firstFrozenAt posts NOTHING (no reliable freeze boundary)", async () => {
    const db = getDb();
    const { frozen, firstFrozenAt } = await freezeUnpaidRent({ id: C_RENT, amount: "800.00", number: "PPC-B7" });
    // Simulate a period frozen BEFORE the manifest feature shipped: no firstFrozenAt.
    await db.ownerStatementPeriod.update({ where: { id: frozen.id }, data: { firstFrozenAt: null } });
    await payCharge({ chargeId: C_RENT, amount: "800.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });

    const res = await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    expect(res.posted).toBe(0);
    expect(await collectionRows(C_RENT)).toHaveLength(0);
  });

  // ── B8: a PRE-freeze allocation is already in the frozen collected → excluded ────
  it("B8: only allocations created AFTER firstFrozenAt post forward (pre-freeze cash is already in the frozen collected)", async () => {
    const db = getDb();
    // Rent 800, of which 300 was collected BEFORE freeze (outstanding 500 → collected 300).
    await makeRentCharge({ id: C_RENT, status: "partially_paid", amount: "800.00", outstanding: "500.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-B8" });
    // The pre-freeze payment event (dated inside the frozen month → createdAt < firstFrozenAt).
    await payCharge({ chargeId: C_RENT, amount: "300.00", allocatedAt: frozenDue, createdAt: frozenDue });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // The remaining 500 arrives AFTER freeze.
    await payCharge({ chargeId: C_RENT, amount: "500.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    const cols = await collectionRows(C_RENT);
    expect(cols).toHaveLength(1); // ONLY the post-freeze 500 — never the pre-freeze 300
    expect(Number(cols[0]!.amount.toString())).toBe(500);
  });

  // ── B4: a post-freeze allocation REVERSAL posts a compensating (−) row ───────────
  it("B4: reversing a forward-collected allocation posts one prior_period_collection_reversal (opposite direction), leaves the prior collection row untouched, and satisfies the R5 identity", async () => {
    const db = getDb();
    const { frozen, firstFrozenAt } = await freezeUnpaidRent({ id: C_RENT, amount: "800.00", number: "PPC-B4" });

    // Pay in full after freeze → collection posts.
    const allocId = await payCharge({ chargeId: C_RENT, amount: "800.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    const colBefore = (await collectionRows(C_RENT))[0]!;
    expect(colBefore.direction).toBe("income");
    expect(colBefore.sourceAllocationEventId).toBe(allocId); // keyed on the ALLOCATION event

    // Later, the allocation is reversed (reroute / refund) — append-only.
    const revCreatedAt = new Date(firstFrozenAt.getTime() + 120_000);
    const revId = await reverseAllocation({ allocationId: allocId, amount: "800.00", createdAt: revCreatedAt });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "posted", outstandingAmount: "800.00" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    // A single compensating reversal row, OPPOSITE direction, same amount, in the open month.
    const revs = await reversalRows(C_RENT);
    expect(revs).toHaveLength(1);
    const rev = revs[0]!;
    expect(rev.direction).toBe("expense"); // income → expense so it nets against the collection
    expect(Number(rev.amount.toString())).toBe(800);
    expect(rev.statementMonth.getTime()).toBe(curStart.getTime());
    expect(rev.sourceAllocationEventId).toBe(revId); // NON-NULL, keyed on the reversal event
    expect(revId).not.toBe(allocId); // distinct event ids → per-event traceability (net-zero pair)
    expect(rev.transactionDate.toISOString().slice(0, 10)).toBe(revCreatedAt.toISOString().slice(0, 10));

    // The prior collection row is NOT mutated.
    const colAfter = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: colBefore.id } });
    expect(colAfter.direction).toBe("income");
    expect(Number(colAfter.amount.toString())).toBe(800);
    expect(colAfter.status).toBe("active");

    // R5 identity (integer cents): Σcollection − Σreversal == effectiveAllocated − frozenCollected.
    const toC = (s: string) => Math.round(Number(s) * 100);
    const sumC = (rs: { amount: { toString(): string } }[]) => rs.reduce((a, r) => a + toC(r.amount.toString()), 0);
    const collectedForwardC = sumC(await collectionRows(C_RENT)) - sumC(await reversalRows(C_RENT));
    const effectiveAllocatedC = 80000 - 80000; // Σalloc(800) − Σreversal(800)
    const frozenCollectedC = 0; // the frozen normal row collected 0
    expect(collectedForwardC).toBe(effectiveAllocatedC - frozenCollectedC); // 0 == 0

    // Open-month payout nets to zero (+800 income − 800 expense).
    const bal = await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M);
    expect(bal.netThisPeriod).toBe("0.00");
    expect(frozen.firstFrozenAt).toBeTruthy();
  });

  // ── B21 (review C1 — event-driven disjointness, NOT status): a post-freeze ───────
  // allocation REVERSAL on a charge credited after freeze is booked HERE as the
  // compensating prior_period_collection_reversal, driven by the append-only event
  // stream (independent of charge status). No double-debit results because the sibling
  // postForwardReversalForFrozenMonth NETS this reversal off (frozen_collected − Σppc_
  // reversal = 0), proven in owner-statement-forward-correction (F1/F2). The pre-fix
  // "posts NOTHING here" contract was the Bug-1 defect: it stranded this reversal for
  // a charge that voided AFTER forwarding, over-crediting the owner.
  it("B21: a post-freeze allocation reversal on a credited-after-freeze charge posts ONE event-driven prior_period_collection_reversal here (net-off left to the sibling)", async () => {
    const db = getDb();
    // Paid IN FULL before freeze → frozen normal row collected 800, paymentStatus paid.
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "800.00", outstanding: "0.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-B21" });
    const allocId = await payCharge({ chargeId: C_RENT, amount: "800.00", allocatedAt: frozenDue, createdAt: frozenDue });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // Cancel-and-replace after freeze: reverse the allocation AND credit the charge.
    const revId = await reverseAllocation({ allocationId: allocId, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "credited", outstandingAmount: "800.00" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    // No NEW post-freeze collection (the allocation was pre-freeze); the post-freeze
    // REVERSAL event books one compensating (−) row, event-keyed — regardless of status.
    expect(await collectionRows(C_RENT)).toHaveLength(0);
    const revs = await reversalRows(C_RENT);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.direction).toBe("expense");
    expect(Number(revs[0]!.amount.toString())).toBe(800);
    expect(revs[0]!.sourceAllocationEventId).toBe(revId);
  });

  // ── C1 (Bug 1 — CONFIRMED silent OVER-CREDIT): a post-freeze allocation REVERSAL ──
  // event must post its compensating (−) row REGARDLESS of the charge's later
  // void/credited status. Cascade (verified): voiding a charge does NOT create a
  // PaymentAllocationReversal — the reversal (bounce/reroute) is an INDEPENDENT
  // append-only event. Keying disjointness on charge status stranded the −800
  // claw-back, over-crediting the owner by the bounced amount.
  it("C1: an unpaid-at-freeze rent paid in full post-freeze, then bounced AND voided, posts the compensating reversal (owner not over-credited)", async () => {
    const db = getDb();
    const { firstFrozenAt } = await freezeUnpaidRent({ id: C_RENT, amount: "800.00", number: "PPC-C1" });

    // (1) Tenant pays in full after freeze → +800 forward collection posts.
    const allocId = await payCharge({ chargeId: C_RENT, amount: "800.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    expect(await collectionRows(C_RENT)).toHaveLength(1); // the +800 is booked forward

    // (2) Payment BOUNCES: its allocation is reversed (SEPARATE event) AND the charge
    //     is voided. Neither the void nor the reversal is derivable from the other.
    await reverseAllocation({ allocationId: allocId, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 120_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void", outstandingAmount: "800.00" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    // The reversal EVENT is booked despite the void → exactly one compensating −800.
    const revs = await reversalRows(C_RENT);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.direction).toBe("expense"); // income → expense, nets the collection
    expect(Number(revs[0]!.amount.toString())).toBe(800);
    expect(revs[0]!.sourceAllocationEventId).toBeTruthy(); // keyed on the reversal event

    // Net forward = +800 − 800 = 0: the owner keeps NONE of the bounced cash.
    const bal = await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M);
    expect(bal.netThisPeriod).toBe("0.00");
  });

  // ── Bwire: the REAL frozen sync-hook branch posts the collection; idempotent ─────
  it("Bwire: syncOwnerLedgerForCharges posts the forward collection for a frozen-month charge and re-running is idempotent (one row)", async () => {
    const db = getDb();
    const { firstFrozenAt } = await freezeUnpaidRent({ id: C_RENT, amount: "800.00", number: "PPC-WIRE" });
    await payCharge({ chargeId: C_RENT, amount: "800.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });

    // Drive the REAL post-commit hook, twice — the second run must be a no-op.
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    const cols = await collectionRows(C_RENT);
    expect(cols).toHaveLength(1);
    expect(Number(cols[0]!.amount.toString())).toBe(800);
    expect(cols[0]!.statementMonth.getTime()).toBe(curStart.getTime());
  });

  // ── B2 (mandated #2): two distinct post-freeze partials each post their own row ──
  it("B2: two distinct post-freeze partial allocations each post their own increment (event-sourced)", async () => {
    const db = getDb();
    const { firstFrozenAt } = await freezeUnpaidRent({ id: C_RENT, amount: "800.00", number: "PPC-B2" });
    await payCharge({ chargeId: C_RENT, amount: "500.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "partially_paid", outstandingAmount: "300.00" } });
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    await payCharge({ chargeId: C_RENT, amount: "300.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 120_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    const cols = await collectionRows(C_RENT);
    expect(cols).toHaveLength(2);
    expect(cols.map((c) => Number(c.amount.toString()))).toEqual([300, 500]); // ordered asc
    const bal = await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M);
    expect(bal.netThisPeriod).toBe("800.00");
  });

  // ── B5 (mandated #5): attribution + payout treatment inherited from normal row ───
  it("B5: the forward row inherits paidBy/includeInPayout/category + owner attribution from the frozen normal row", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-B5" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT } });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    await payCharge({ chargeId: C_RENT, amount: "800.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    const col = (await collectionRows(C_RENT))[0]!;
    expect(col.paidBy).toBe(normal.paidBy);
    expect(col.includeInPayout).toBe(normal.includeInPayout);
    expect(col.category).toBe(normal.category);
    expect(col.propertyId).toBe(normal.propertyId);
    expect(col.apartmentId).toBe(APT);
    expect(col.listingId).toBe(UNIT);
    expect(col.tenancyId).toBe(TEN);
  });

  // ── B12 (audit #1): partial-at-freeze completion; R5 identity in integer cents ───
  it("B12: a charge partially collected AT freeze posts only the post-freeze increments; Σcoll−Σrev == effectiveAllocated−frozenCollected (cents)", async () => {
    const db = getDb();
    // Rent 1000; 300 collected before freeze → frozen collected 300.
    await makeRentCharge({ id: C_RENT, status: "partially_paid", amount: "1000.00", outstanding: "700.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-B12" });
    await payCharge({ chargeId: C_RENT, amount: "300.00", allocatedAt: frozenDue, createdAt: frozenDue });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT } });
    expect(Number(normal.amount.toString())).toBe(300); // frozen collected
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // Two post-freeze increments complete it: +400 then +300.
    await payCharge({ chargeId: C_RENT, amount: "400.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await payCharge({ chargeId: C_RENT, amount: "300.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 120_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    const cols = await collectionRows(C_RENT);
    expect(cols).toHaveLength(2); // NEVER the pre-freeze 300 as a 3rd row
    expect(cols.map((c) => Number(c.amount.toString()))).toEqual([300, 400]);
    const toC = (s: string) => Math.round(Number(s) * 100);
    const fwdC = cols.reduce((a, c) => a + toC(c.amount.toString()), 0);
    expect(fwdC).toBe(100000 - 30000); // effectiveAllocated 1000 − frozenCollected 300 = 700
  });

  // ── B13 (audit #3): the freeze boundary is strict `>` (equality excluded) ────────
  it("B13: an allocation at EXACTLY firstFrozenAt is excluded; +1ms is included", async () => {
    const db = getDb();
    const { firstFrozenAt } = await freezeUnpaidRent({ id: C_RENT, amount: "800.00", number: "PPC-B13" });
    await payCharge({ chargeId: C_RENT, amount: "100.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime()) }); // tie → excluded
    await payCharge({ chargeId: C_RENT, amount: "200.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 1) }); // after → included
    await db.charge.update({ where: { id: C_RENT }, data: { status: "partially_paid", outstandingAmount: "500.00" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    const cols = await collectionRows(C_RENT);
    expect(cols).toHaveLength(1);
    expect(Number(cols[0]!.amount.toString())).toBe(200);
  });

  // ── B14 (audit #4): post-freeze reversal of a PRE-freeze allocation compensates ──
  it("B14: a post-freeze reversal of a pre-freeze allocation posts a compensating (−) row (charge still live)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "partially_paid", amount: "800.00", outstanding: "500.00", billingMonth: frozenStart, dueDate: frozenDue, number: "PPC-B14" });
    const preAllocId = await payCharge({ chargeId: C_RENT, amount: "300.00", allocatedAt: frozenDue, createdAt: frozenDue });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    const revId = await reverseAllocation({ allocationId: preAllocId, amount: "300.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "posted", outstandingAmount: "800.00" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    const revs = await reversalRows(C_RENT);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.direction).toBe("expense");
    expect(Number(revs[0]!.amount.toString())).toBe(300);
    expect(revs[0]!.sourceAllocationEventId).toBe(revId);
    expect(await collectionRows(C_RENT)).toHaveLength(0); // only the reversal
  });

  // ── B15 (audit #5/#6): direction + includeInPayout inherited VERBATIM (never hardcoded) ─
  it("B15: an EXPENSE-direction source preserves direction (not flipped) and includeInPayout:false", async () => {
    const db = getDb();
    // An owner-borne EXPENSE charge frozen at collected 0, includeInPayout:false, paidBy owner.
    await db.charge.create({
      data: { id: C_EXP, organizationId: ORG, chargeNumber: "PPC-EXP", partyId: TENANT, tenancyId: TEN, unitId: UNIT, chargeType: "utility", status: "posted", postedAt: new Date(), dueDate: frozenDue, amount: "200.00", currency: "MYR", outstandingAmount: "200.00", billingMonth: frozenStart },
    });
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, tenancyId: TEN, statementMonth: frozenStart, transactionDate: frozenStart, direction: "expense", category: "maintenance_fee", amount: "0.00", paidBy: "owner", paymentStatus: "pending", includeInPayout: false, sourceType: "statement", sourceChargeId: C_EXP, status: "active", createdById: USER, updatedById: USER },
    });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    await payCharge({ chargeId: C_EXP, amount: "200.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    const cols = await collectionRows(C_EXP);
    expect(cols).toHaveLength(1);
    expect(cols[0]!.direction).toBe("expense"); // PRESERVED, never flipped to income
    expect(cols[0]!.includeInPayout).toBe(false); // INHERITED, never defaulted true
    expect(cols[0]!.paidBy).toBe("owner");
    expect(cols[0]!.category).toBe("maintenance_fee");
  });

  // ── B16 (audit #7): a PARTIAL reversal posts reversal.amount, not the alloc amount ─
  it("B16: reversing 100 of a 300 forward-collection posts a 100 reversal (not 300)", async () => {
    const db = getDb();
    const { firstFrozenAt } = await freezeUnpaidRent({ id: C_RENT, amount: "800.00", number: "PPC-B16" });
    const allocId = await payCharge({ chargeId: C_RENT, amount: "300.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "partially_paid", outstandingAmount: "500.00" } });
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    await reverseAllocation({ allocationId: allocId, amount: "100.00", createdAt: new Date(firstFrozenAt.getTime() + 120_000) });
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);

    const revs = await reversalRows(C_RENT);
    expect(revs).toHaveLength(1);
    expect(Number(revs[0]!.amount.toString())).toBe(100);
    const bal = await resolveOwnerBalance(ORG, OWNER, CUR_M, CUR_M);
    expect(bal.netThisPeriod).toBe("200.00"); // 300 collected − 100 reversed
  });

  // ── B17 (audit #10): incremental re-run adds only the new event ──────────────────
  it("B17: re-running after a NEW allocation arrives adds only the new row (never drops or re-adds)", async () => {
    const db = getDb();
    const { firstFrozenAt } = await freezeUnpaidRent({ id: C_RENT, amount: "800.00", number: "PPC-B17" });
    await payCharge({ chargeId: C_RENT, amount: "400.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "partially_paid", outstandingAmount: "400.00" } });
    expect((await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M)).posted).toBe(1);

    await payCharge({ chargeId: C_RENT, amount: "400.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 120_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });
    expect((await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M)).posted).toBe(1); // only the new one

    const cols = await collectionRows(C_RENT);
    expect(cols).toHaveLength(2);
    expect(cols.map((c) => Number(c.amount.toString()))).toEqual([400, 400]);
  });

  // ── B18 (audit #11): concurrent runs are ON CONFLICT DO NOTHING-safe ─────────────
  it("B18: two concurrent runs over the same event post exactly one row and surface no error", async () => {
    const db = getDb();
    const { firstFrozenAt } = await freezeUnpaidRent({ id: C_RENT, amount: "800.00", number: "PPC-B18" });
    await payCharge({ chargeId: C_RENT, amount: "800.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });

    const [a, b] = await Promise.all([
      postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M),
      postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M),
    ]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(await collectionRows(C_RENT)).toHaveLength(1); // never duplicated
  });

  // ── B19 (audit #12): a CARPARK owner charge is discovered + collected ────────────
  it("B19: a carpark charge (unitId null) is discovered via carpark.ownerPartyId and posts its own collection", async () => {
    const db = getDb();
    await db.carpark.create({ data: { id: CARPARK, organizationId: ORG, propertyId: PROP, apartmentId: APT, ownerPartyId: OWNER, label: "P-1", monthlyRate: "150.00", status: "rented" } });
    await db.charge.create({ data: { id: CP_CHARGE, organizationId: ORG, chargeNumber: "PPC-CP", partyId: TENANT, carparkId: CARPARK, chargeType: "carpark", status: "posted", postedAt: new Date(), dueDate: frozenDue, amount: "150.00", currency: "MYR", outstandingAmount: "150.00", billingMonth: frozenStart } });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "carpark", sourceChargeId: CP_CHARGE } });
    expect(normal.category).toBe("carpark_income");
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    await payCharge({ chargeId: CP_CHARGE, amount: "150.00", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: CP_CHARGE }, data: { status: "paid", outstandingAmount: "0.00" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    const cols = await collectionRows(CP_CHARGE);
    expect(cols).toHaveLength(1);
    expect(cols[0]!.direction).toBe("income");
    expect(cols[0]!.category).toBe("carpark_income");
    expect(Number(cols[0]!.amount.toString())).toBe(150);
    expect(cols[0]!.apartmentId).toBe(APT);
  });

  // ── B20 (audit #13): many small events → exact integer-cent totals, no drift ─────
  it("B20: ten RM0.10 + one RM0.01 post-freeze allocations post 11 rows summing to exactly 101 cents", async () => {
    const db = getDb();
    const { firstFrozenAt } = await freezeUnpaidRent({ id: C_RENT, amount: "800.00", number: "PPC-B20" });
    for (let i = 0; i < 10; i++) {
      await payCharge({ chargeId: C_RENT, amount: "0.10", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 1000 * (i + 1)) });
    }
    await payCharge({ chargeId: C_RENT, amount: "0.01", allocatedAt: RECEIVED, createdAt: new Date(firstFrozenAt.getTime() + 1000 * 11) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "partially_paid", outstandingAmount: "798.99" } });

    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    const cols = await collectionRows(C_RENT);
    expect(cols).toHaveLength(11); // one row per event, incl. the RM0.01
    const totalC = cols.reduce((a, c) => a + Math.round(Number(c.amount.toString()) * 100), 0);
    expect(totalC).toBe(101);
  });

  // ── B11: never throws into the caller (post-commit contract) ────────────────────
  it("B11: an internal DB failure is swallowed — the function resolves, never rejects (the payment tx already committed)", async () => {
    // A syntactically-invalid orgId makes the very first Prisma query throw; the
    // contract is swallow + console.error, NEVER reject (a throw here could abort the
    // sync-hook's loop over other owner-months). Stands in for any internal failure.
    const badActor: OwnerLedgerActorCtx = { orgId: "not-a-uuid", actorUserId: USER, actorRole: "admin" };
    await expect(postPriorPeriodCollections(badActor, OWNER, FROZEN_M)).resolves.toEqual({ posted: 0 });
  });
});
