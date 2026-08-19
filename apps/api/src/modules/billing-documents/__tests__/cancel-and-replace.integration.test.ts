/**
 * CANCEL_AND_REPLACE — supersede the original + MOVE the allocation (R3) — real
 * LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * Proves (spec §4.3 / R3), all in ONE transaction:
 *  - (a) "supersede and move": issued INV-1001 RM1000 with RM400 collected →
 *    CANCEL_AND_REPLACE { replacement: { lines:[RM900] } } → INV-1001
 *    documentStatus=CANCELLED, a NEW invoice RM900 issued, INV-1001
 *    supersededByDocumentId = new doc id, an append-only PaymentAllocationReversal
 *    (RM400) on the original allocation + a NEW PaymentAllocation on the
 *    replacement's charge for RM400. The Payment row is byte-identical (R5), and
 *    the original PaymentAllocation row is NEVER mutated/deleted.
 *  - (b) "non-issued 409": original documentStatus already CANCELLED → 409
 *    DOCUMENT_NOT_ISSUED, nothing mutated.
 *  - (c) "tax submitted 409": original taxStatus SUBMITTED → 409 TAX_SUBMITTED,
 *    nothing mutated.
 *  - (d) "atomic rollback": a mid-tx failure minting the replacement (an invalid
 *    line — category not in this org) rolls the WHOLE tx back — the original stays
 *    ISSUED, no reversal / new allocation / cancel landed.
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/cancel-and-replace.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { voidPostedChargeWithCreditNote, CreditNoteVoidError } from "../credit-notes.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (prefix b6; unused by any other suite). Two orgs: A (the
// acting org) + B (the IDOR victim), each fully self-contained.
const ORG_A = "b6000000-0000-4000-8000-000000000001";
const USER_A = "b6000000-0000-4000-8000-000000000002";
const TENANT_A = "b6000000-0000-4000-8000-000000000003";
const CAT_A = "b6000000-0000-4000-8000-000000000004";
const SERIES_DEP_A = "b6000000-0000-4000-8000-000000000005";
const SERIES_CN_A = "b6000000-0000-4000-8000-000000000006";
const SERIES_IV_A = "b6000000-0000-4000-8000-000000000007";

const ORG_B = "b6000000-0000-4000-8000-000000000101";
const USER_B = "b6000000-0000-4000-8000-000000000102";
const TENANT_B = "b6000000-0000-4000-8000-000000000103";
const CAT_B = "b6000000-0000-4000-8000-000000000104";
const SERIES_DEP_B = "b6000000-0000-4000-8000-000000000105";
const SERIES_CN_B = "b6000000-0000-4000-8000-000000000106";
const SERIES_IV_B = "b6000000-0000-4000-8000-000000000107";

// (a) supersede-and-move
const C_MOVE = "b6000000-0000-4000-8000-000000000011";
const D_MOVE = "b6000000-0000-4000-8000-000000000012";
const PAY_MOVE = "b6000000-0000-4000-8000-000000000013";
const ALLOC_MOVE = "b6000000-0000-4000-8000-000000000014";

// (b) non-issued (already CANCELLED)
const C_NI = "b6000000-0000-4000-8000-000000000021";
const D_NI = "b6000000-0000-4000-8000-000000000022";
const PAY_NI = "b6000000-0000-4000-8000-000000000023";
const ALLOC_NI = "b6000000-0000-4000-8000-000000000024";

// (c) tax submitted
const C_TAX = "b6000000-0000-4000-8000-000000000031";
const D_TAX = "b6000000-0000-4000-8000-000000000032";
const PAY_TAX = "b6000000-0000-4000-8000-000000000033";
const ALLOC_TAX = "b6000000-0000-4000-8000-000000000034";

// (d) atomic rollback
const C_ROLL = "b6000000-0000-4000-8000-000000000041";
const D_ROLL = "b6000000-0000-4000-8000-000000000042";
const PAY_ROLL = "b6000000-0000-4000-8000-000000000043";
const ALLOC_ROLL = "b6000000-0000-4000-8000-000000000044";

// (e) a REFUSED transfer slip's retained allocation must not move
const C_REJ = "b6000000-0000-4000-8000-000000000051";
const D_REJ = "b6000000-0000-4000-8000-000000000052";
const PAY_REJ = "b6000000-0000-4000-8000-000000000053";
const ALLOC_REJ = "b6000000-0000-4000-8000-000000000054";

// (f) an UNVERIFIED (pending_approval) slip's allocation must not move either
const C_PEND = "b6000000-0000-4000-8000-000000000061";
const D_PEND = "b6000000-0000-4000-8000-000000000062";
const PAY_PEND = "b6000000-0000-4000-8000-000000000063";
const ALLOC_PEND = "b6000000-0000-4000-8000-000000000064";

async function cleanupOrg(orgId: string, userId: string) {
  const db = getDb();
  const org = { organizationId: orgId };
  // FK-safe order: children before parents. PaymentAllocationReversal keys off
  // allocation ids via a plain column, so purge it first.
  await db.paymentAllocationReversal.deleteMany({ where: org });
  await db.refund.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: userId } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: orgId } });
}

async function cleanup() {
  await cleanupOrg(ORG_A, USER_A);
  await cleanupOrg(ORG_B, USER_B);
}

async function seedOrg(opts: {
  orgId: string;
  userId: string;
  tenantId: string;
  catId: string;
  seriesDepId: string;
  seriesCnId: string;
  seriesIvId: string;
  email: string;
}) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: opts.orgId, name: `Repl Test Org ${opts.orgId.slice(-3)}`, slug: `org-${opts.orgId}`,
      status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: opts.userId, organizationId: opts.orgId, email: opts.email, passwordHash: "x",
      role: "admin", fullName: "Repl Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: {
      id: opts.tenantId, organizationId: opts.orgId, displayName: "Repl Tenant",
      partyType: "individual", status: "active",
    },
  });
  await db.documentSeries.create({
    data: { id: opts.seriesDepId, organizationId: opts.orgId, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: opts.seriesCnId, organizationId: opts.orgId, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: opts.seriesIvId, organizationId: opts.orgId, code: "IV", prefix: "INV", padding: 4, includeYear: false, active: true },
  });
  // Category routes replacement invoices to the IV series.
  await db.chargeCategory.create({
    data: {
      id: opts.catId, organizationId: opts.orgId, code: "rental", name: "Monthly rental",
      family: "tenant_income", docType: "invoice", seriesId: opts.seriesIvId,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
}

/**
 * Seed a posted charge + its ISSUED DEP invoice document (1 line,
 * documentStatus/taxStatus overridable) + a real Payment and PaymentAllocation
 * (collected = amount − outstanding).
 */
async function seedChargeWithPayment(opts: {
  orgId: string;
  tenantId: string;
  catId: string;
  seriesDepId: string;
  userId: string;
  chargeId: string;
  docId: string;
  documentNumber: string;
  paymentId: string;
  paymentNumber: string;
  allocId: string;
  amount: string;
  outstanding: string;
  collected: string;
  status: string;
  documentStatus?: string;
  taxStatus?: string;
  /**
   * Payment status for the seeded allocation. Defaults to "posted" — the ONLY
   * status meaning money actually arrived. Pass "rejected"/"pending_approval" to
   * seed a tenant transfer slip whose allocation is live but carries no cash:
   * the portal creates the allocation at pending_approval time, and
   * rejectPaymentTx refuses a slip WITHOUT removing it.
   */
  paymentStatus?: string;
}) {
  const db = getDb();
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: opts.orgId, chargeNumber: `RPL-${opts.chargeId.slice(-6)}`,
      partyId: opts.tenantId, chargeType: "rental", categoryId: opts.catId, status: opts.status,
      postedAt: new Date(), description: "Rent June", dueDate: new Date("2026-06-30"),
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.outstanding,
      billingMonth: new Date("2026-06-01"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: opts.orgId, docType: "invoice",
      documentNumber: opts.documentNumber, seriesId: opts.seriesDepId, status: "issued",
      documentStatus: opts.documentStatus ?? "ISSUED",
      taxStatus: opts.taxStatus ?? "NOT_REQUIRED",
      issuedById: opts.userId, counterpartyType: "tenant", partyId: opts.tenantId,
      billingMonth: new Date("2026-06-01"),
      subtotal: opts.amount, sstAmount: 0, total: opts.amount,
      lines: {
        create: [{
          chargeId: opts.chargeId, categoryId: opts.catId, description: "Rent June",
          amount: opts.amount, sstRate: 0, sstAmount: 0,
        }],
      },
    },
  });
  await db.payment.create({
    data: {
      id: opts.paymentId, organizationId: opts.orgId, paymentNumber: opts.paymentNumber,
      partyId: opts.tenantId, paymentType: "incoming", paymentMethod: "bank_transfer",
      status: opts.paymentStatus ?? "posted", amount: opts.collected, currency: "MYR", receivedAt: new Date("2026-06-15T00:00:00.000Z"),
    },
  });
  await db.paymentAllocation.create({
    data: {
      id: opts.allocId, organizationId: opts.orgId, paymentId: opts.paymentId,
      chargeId: opts.chargeId, allocatedAmount: opts.collected,
      allocatedAt: new Date("2026-06-15T00:00:00.000Z"),
    },
  });
}

dn("CANCEL_AND_REPLACE — supersede + move the allocation (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrg({
      orgId: ORG_A, userId: USER_A, tenantId: TENANT_A, catId: CAT_A,
      seriesDepId: SERIES_DEP_A, seriesCnId: SERIES_CN_A, seriesIvId: SERIES_IV_A,
      email: "repl-a@test.local",
    });
    await seedOrg({
      orgId: ORG_B, userId: USER_B, tenantId: TENANT_B, catId: CAT_B,
      seriesDepId: SERIES_DEP_B, seriesCnId: SERIES_CN_B, seriesIvId: SERIES_IV_B,
      email: "repl-b@test.local",
    });
  });
  afterAll(cleanup);

  it("supersede and move: issued INV RM1000/RM400-paid → CANCEL_AND_REPLACE RM900 → original CANCELLED, replacement RM900 issued, RM400 reversed + re-allocated, Payment untouched", async () => {
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_MOVE, docId: D_MOVE, documentNumber: "INV-1001",
      paymentId: PAY_MOVE, paymentNumber: "PAY-MV-1", allocId: ALLOC_MOVE,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
    });

    const db = getDb();
    const payBefore = await db.payment.findUniqueOrThrow({ where: { id: PAY_MOVE } });
    const allocBefore = await db.paymentAllocation.findUniqueOrThrow({ where: { id: ALLOC_MOVE } });

    const r = await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_MOVE, reason: "corrected line-set",
      strategy: "CANCEL_AND_REPLACE",
      replacement: { lines: [{ categoryId: CAT_A, description: "Rent June (corrected)", amount: "900.00" }] },
      actorUserId: USER_A, actorRole: "admin",
    });

    // A replacement invoice was minted (new number).
    expect(r.replacementNumber).toMatch(/^INV-\d{4}$/);
    expect(r.replacementDocumentId).toBeTruthy();

    // The original document is CANCELLED and points at its replacement.
    const original = await db.billingDocument.findUniqueOrThrow({ where: { id: D_MOVE } });
    expect(original.documentStatus).toBe("CANCELLED");
    expect(original.supersededByDocumentId).toBe(r.replacementDocumentId);

    // The replacement is a fresh ISSUED invoice for RM900.
    const replacement = await db.billingDocument.findUniqueOrThrow({ where: { id: r.replacementDocumentId! } });
    expect(replacement.docType).toBe("invoice");
    expect(replacement.documentStatus).toBe("ISSUED");
    expect(Number(replacement.total.toString())).toBe(900);
    expect(replacement.id).not.toBe(D_MOVE);

    // The moved allocation: an append-only reversal for RM400 on the ORIGINAL
    // allocation (never mutated) + a NEW PaymentAllocation on the replacement's
    // charge for RM400.
    const reversals = await db.paymentAllocationReversal.findMany({
      where: { organizationId: ORG_A, originalAllocationId: ALLOC_MOVE },
    });
    expect(reversals.length).toBe(1);
    expect(Number(reversals[0].amount.toString())).toBe(400);

    // The original PaymentAllocation row is UNCHANGED (append-only: never mutated).
    const allocAfter = await db.paymentAllocation.findUniqueOrThrow({ where: { id: ALLOC_MOVE } });
    expect(allocAfter.chargeId).toBe(C_MOVE);
    expect(allocAfter.allocatedAmount.toString()).toBe(allocBefore.allocatedAmount.toString());
    expect(allocAfter.paymentId).toBe(PAY_MOVE);

    // A NEW PaymentAllocation exists on the replacement's charge for RM400 (same
    // Payment). Find the replacement's charge via its document line.
    const replLine = await db.billingDocumentLine.findFirstOrThrow({
      where: { documentId: r.replacementDocumentId! },
    });
    expect(replLine.chargeId).toBeTruthy();
    expect(replLine.chargeId).not.toBe(C_MOVE);
    const newAllocs = await db.paymentAllocation.findMany({
      where: { organizationId: ORG_A, chargeId: replLine.chargeId! },
    });
    expect(newAllocs.length).toBe(1);
    expect(newAllocs[0].paymentId).toBe(PAY_MOVE);
    expect(Number(newAllocs[0].allocatedAmount.toString())).toBe(400);

    // The Payment row is byte-identical (R5 — payment NEVER touched).
    const payAfter = await db.payment.findUniqueOrThrow({ where: { id: PAY_MOVE } });
    expect(payAfter.amount.toString()).toBe(payBefore.amount.toString());
    expect(payAfter.status).toBe(payBefore.status);
    expect(payAfter.updatedAt.getTime()).toBe(payBefore.updatedAt.getTime());

    // Replacement's charge outstanding = 900 − 400 moved = 500 (money conserved).
    const replCharge = await db.charge.findUniqueOrThrow({ where: { id: replLine.chargeId! } });
    expect(Number(replCharge.outstandingAmount.toString())).toBe(500);
    expect(replCharge.parentChargeId).toBe(C_MOVE);
  });

  // ── A NON-CASH allocation must never be moved ─────────────────────────────
  // "MOVE the allocations" means moving MONEY, and only a posted payment is
  // money. An allocation can be live while carrying no cash at all: the portal
  // creates one the moment a tenant uploads a transfer slip (pending_approval),
  // and rejectPaymentTx refuses that slip by flipping the Payment to "rejected"
  // while RETAINING the allocation row.
  //
  // Reading them unfiltered moved those phantoms — applyAllocationToChargeTx drew
  // the replacement's outstanding DOWN by money that never arrived, under-billing
  // the tenant with nothing to notice it, and minted a reversal against credit no
  // one ever posted.
  //
  // Reachable with no failure at all: this strategy applies to paid AND unpaid
  // posted charges, and a refused slip leaves collected = 0, so no strategy guard
  // stands in the way. Two ordinary admin actions, in order.
  for (const [label, badStatus, chargeId, docId, payId, allocId, docNum] of [
    ["a REFUSED slip", "rejected", C_REJ, D_REJ, PAY_REJ, ALLOC_REJ, "INV-5001"],
    ["an UNVERIFIED slip", "pending_approval", C_PEND, D_PEND, PAY_PEND, ALLOC_PEND, "INV-6001"],
  ] as const) {
    it(`${label} is NOT moved onto the replacement — its outstanding stays whole`, async () => {
      await seedChargeWithPayment({
        orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
        chargeId, docId, documentNumber: docNum,
        paymentId: payId, paymentNumber: `PAY-${badStatus}-1`, allocId,
        // outstanding === amount: the slip settled NOTHING, which is exactly what
        // reject/pending leave behind (neither touches the charge).
        amount: "1000.00", outstanding: "1000.00", collected: "400.00", status: "posted",
        paymentStatus: badStatus,
      });

      const db = getDb();
      const r = await voidPostedChargeWithCreditNote({
        organizationId: ORG_A, chargeId, reason: "corrected line", actorUserId: USER_A,
        actorRole: "admin", strategy: "CANCEL_AND_REPLACE",
        replacement: { lines: [{ categoryId: CAT_A, description: "Rent June (corrected)", amount: "1000.00" }] },
      });

      const replLine = await db.billingDocumentLine.findFirstOrThrow({
        where: { documentId: r.replacementDocumentId! },
      });

      // THE MONEY ASSERTION: the replacement bills the full RM1000. A moved
      // phantom allocation would have drawn it down to RM600.
      const replCharge = await db.charge.findUniqueOrThrow({ where: { id: replLine.chargeId! } });
      expect(Number(replCharge.outstandingAmount.toString())).toBe(1000);

      // No allocation follows a non-cash slip onto the replacement...
      const newAllocs = await db.paymentAllocation.findMany({
        where: { organizationId: ORG_A, chargeId: replLine.chargeId! },
      });
      expect(newAllocs).toHaveLength(0);

      // ...and no reversal is minted against credit that was never posted (the
      // orphan-clawback shape that poisons the owner ledger downstream).
      const reversals = await db.paymentAllocationReversal.findMany({
        where: { organizationId: ORG_A, originalAllocationId: allocId },
      });
      expect(reversals).toHaveLength(0);

      // DECIDED: the dead allocation is LEFT BEHIND on the cancelled charge,
      // never mutated. For a refused slip that is simply correct — it is dead.
      // For one still awaiting verification it is the lesser evil: blocking the
      // correction outright would add a brand-new way for the feature to fail.
      // The residue is that approving it later settles a superseded charge —
      // visible and fixable, unlike silently under-billing.
      const allocAfter = await db.paymentAllocation.findUniqueOrThrow({ where: { id: allocId } });
      expect(allocAfter.chargeId).toBe(chargeId);
      expect(Number(allocAfter.allocatedAmount.toString())).toBe(400);
    });
  }

  it("non-issued 409: original documentStatus already CANCELLED → 409 DOCUMENT_NOT_ISSUED, nothing mutated", async () => {
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_NI, docId: D_NI, documentNumber: "INV-2001",
      paymentId: PAY_NI, paymentNumber: "PAY-NI-1", allocId: ALLOC_NI,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
      documentStatus: "CANCELLED",
    });

    const db = getDb();
    const docCountBefore = await db.billingDocument.count({ where: { organizationId: ORG_A } });
    const reversalsBefore = await db.paymentAllocationReversal.count({ where: { organizationId: ORG_A } });

    await expect(
      voidPostedChargeWithCreditNote({
        organizationId: ORG_A, chargeId: C_NI, reason: "retry",
        strategy: "CANCEL_AND_REPLACE",
        replacement: { lines: [{ categoryId: CAT_A, description: "x", amount: "900.00" }] },
        actorUserId: USER_A, actorRole: "admin",
      }),
    ).rejects.toMatchObject({ status: 409, code: "DOCUMENT_NOT_ISSUED" });

    // Nothing mutated: no new document, no reversal, no new allocation, original
    // still CANCELLED (unchanged), alloc still on the original charge.
    expect(await db.billingDocument.count({ where: { organizationId: ORG_A } })).toBe(docCountBefore);
    expect(await db.paymentAllocationReversal.count({ where: { organizationId: ORG_A } })).toBe(reversalsBefore);
    const original = await db.billingDocument.findUniqueOrThrow({ where: { id: D_NI } });
    expect(original.documentStatus).toBe("CANCELLED");
    expect(original.supersededByDocumentId).toBeNull();
    const alloc = await db.paymentAllocation.findUniqueOrThrow({ where: { id: ALLOC_NI } });
    expect(alloc.chargeId).toBe(C_NI);
  });

  it("tax submitted 409: original taxStatus SUBMITTED → 409 TAX_SUBMITTED, nothing mutated", async () => {
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_TAX, docId: D_TAX, documentNumber: "INV-3001",
      paymentId: PAY_TAX, paymentNumber: "PAY-TX-1", allocId: ALLOC_TAX,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
      taxStatus: "SUBMITTED",
    });

    const db = getDb();
    const docCountBefore = await db.billingDocument.count({ where: { organizationId: ORG_A } });
    const reversalsBefore = await db.paymentAllocationReversal.count({ where: { organizationId: ORG_A } });

    await expect(
      voidPostedChargeWithCreditNote({
        organizationId: ORG_A, chargeId: C_TAX, reason: "too late",
        strategy: "CANCEL_AND_REPLACE",
        replacement: { lines: [{ categoryId: CAT_A, description: "x", amount: "900.00" }] },
        actorUserId: USER_A, actorRole: "admin",
      }),
    ).rejects.toMatchObject({ status: 409, code: "TAX_SUBMITTED" });

    // Nothing mutated.
    expect(await db.billingDocument.count({ where: { organizationId: ORG_A } })).toBe(docCountBefore);
    expect(await db.paymentAllocationReversal.count({ where: { organizationId: ORG_A } })).toBe(reversalsBefore);
    const original = await db.billingDocument.findUniqueOrThrow({ where: { id: D_TAX } });
    expect(original.documentStatus).toBe("ISSUED");
    expect(original.supersededByDocumentId).toBeNull();
  });

  it("atomic rollback: a mid-tx failure minting the replacement (invalid line — category not in org) rolls the WHOLE tx back — original stays ISSUED, no reversal/new-alloc/cancel wrote", async () => {
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_ROLL, docId: D_ROLL, documentNumber: "INV-4001",
      paymentId: PAY_ROLL, paymentNumber: "PAY-RL-1", allocId: ALLOC_ROLL,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
    });

    const db = getDb();
    const docCountBefore = await db.billingDocument.count({ where: { organizationId: ORG_A } });
    const chargeCountBefore = await db.charge.count({ where: { organizationId: ORG_A } });
    const allocCountBefore = await db.paymentAllocation.count({ where: { organizationId: ORG_A } });
    const reversalsBefore = await db.paymentAllocationReversal.count({ where: { organizationId: ORG_A } });

    // A replacement line whose categoryId is org-B's category (not in org A) →
    // issueDocumentTx's category→series resolve throws CATEGORY_NOT_FOUND mid-tx.
    await expect(
      voidPostedChargeWithCreditNote({
        organizationId: ORG_A, chargeId: C_ROLL, reason: "bad category",
        strategy: "CANCEL_AND_REPLACE",
        replacement: { lines: [{ categoryId: CAT_B, description: "x", amount: "900.00" }] },
        actorUserId: USER_A, actorRole: "admin",
      }),
    ).rejects.toThrow();

    // The WHOLE tx rolled back — nothing landed. Counts identical.
    expect(await db.charge.count({ where: { organizationId: ORG_A } })).toBe(chargeCountBefore);
    expect(await db.billingDocument.count({ where: { organizationId: ORG_A } })).toBe(docCountBefore);
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG_A } })).toBe(allocCountBefore);
    expect(await db.paymentAllocationReversal.count({ where: { organizationId: ORG_A } })).toBe(reversalsBefore);
    // The original document stays ISSUED (not CANCELLED), no supersededBy.
    const original = await db.billingDocument.findUniqueOrThrow({ where: { id: D_ROLL } });
    expect(original.documentStatus).toBe("ISSUED");
    expect(original.supersededByDocumentId).toBeNull();
  });

  it("effective-allocated netting: a prior partial reversal (RM100) on the alloc → move only RM300 (not the full RM400)", async () => {
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_MOVE, docId: D_MOVE, documentNumber: "INV-5001",
      paymentId: PAY_MOVE, paymentNumber: "PAY-EF-1", allocId: ALLOC_MOVE,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
    });

    const db = getDb();
    // A prior partial reversal of RM100 already exists on this allocation.
    await db.paymentAllocationReversal.create({
      data: {
        organizationId: ORG_A, originalAllocationId: ALLOC_MOVE, amount: "100.00",
        reason: "prior partial", reversedById: USER_A, idempotencyKey: "prior:partial:ef",
      },
    });

    const r = await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_MOVE, reason: "corrected after partial reversal",
      strategy: "CANCEL_AND_REPLACE",
      replacement: { lines: [{ categoryId: CAT_A, description: "corrected", amount: "900.00" }] },
      actorUserId: USER_A, actorRole: "admin",
    });

    // The replace reversal moved only the REMAINING effective-allocated RM300.
    const replaceRev = await db.paymentAllocationReversal.findFirstOrThrow({
      where: { organizationId: ORG_A, idempotencyKey: `replace:${D_MOVE}:${ALLOC_MOVE}` },
    });
    expect(Number(replaceRev.amount.toString())).toBe(300);

    // The new allocation on the replacement's charge is RM300 (not RM400).
    const replLine = await db.billingDocumentLine.findFirstOrThrow({
      where: { documentId: r.replacementDocumentId! },
    });
    const newAllocs = await db.paymentAllocation.findMany({
      where: { organizationId: ORG_A, chargeId: replLine.chargeId! },
    });
    expect(newAllocs.length).toBe(1);
    expect(Number(newAllocs[0].allocatedAmount.toString())).toBe(300);
    // Replacement outstanding = 900 − 300 = 600.
    const replCharge = await db.charge.findUniqueOrThrow({ where: { id: replLine.chargeId! } });
    expect(Number(replCharge.outstandingAmount.toString())).toBe(600);
  });

  it("replay guard: a 2nd identical CANCEL_AND_REPLACE → 409 DOCUMENT_NOT_ISSUED (original now CANCELLED), exactly ONE replacement + ONE reversal (no double-move)", async () => {
    await seedChargeWithPayment({
      orgId: ORG_A, tenantId: TENANT_A, catId: CAT_A, seriesDepId: SERIES_DEP_A, userId: USER_A,
      chargeId: C_MOVE, docId: D_MOVE, documentNumber: "INV-6001",
      paymentId: PAY_MOVE, paymentNumber: "PAY-RP-1", allocId: ALLOC_MOVE,
      amount: "1000.00", outstanding: "600.00", collected: "400.00", status: "partially_paid",
    });

    const db = getDb();
    const r1 = await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_MOVE, reason: "first replace",
      strategy: "CANCEL_AND_REPLACE",
      replacement: { lines: [{ categoryId: CAT_A, description: "corrected", amount: "900.00" }] },
      actorUserId: USER_A, actorRole: "admin",
    });
    expect(r1.replacementNumber).toMatch(/^INV-\d{4}$/);

    // Replay the byte-identical call — the original is now CANCELLED so the guard
    // blocks it BEFORE any second mint/move.
    await expect(
      voidPostedChargeWithCreditNote({
        organizationId: ORG_A, chargeId: C_MOVE, reason: "first replace",
        strategy: "CANCEL_AND_REPLACE",
        replacement: { lines: [{ categoryId: CAT_A, description: "corrected", amount: "900.00" }] },
        actorUserId: USER_A, actorRole: "admin",
      }),
    ).rejects.toMatchObject({ status: 409, code: "DOCUMENT_NOT_ISSUED" });

    // Exactly ONE replacement invoice was minted (INV-1002; no double-mint).
    const replacements = await db.billingDocument.findMany({
      where: { organizationId: ORG_A, docType: "invoice", supersededByDocumentId: null, id: { not: D_MOVE } },
    });
    expect(replacements.length).toBe(1);
    // Exactly ONE reversal on the original allocation (no double-move).
    expect(
      await db.paymentAllocationReversal.count({ where: { organizationId: ORG_A, originalAllocationId: ALLOC_MOVE } }),
    ).toBe(1);
  });

  it("unpaid original: no allocations to move → cancel + mint replacement, zero reversals, full replacement outstanding", async () => {
    // Unpaid posted invoice — no Payment/allocation seeded here.
    const db = getDb();
    await db.charge.create({
      data: {
        id: C_MOVE, organizationId: ORG_A, chargeNumber: "RPL-UNPAID", partyId: TENANT_A,
        chargeType: "rental", categoryId: CAT_A, status: "posted", postedAt: new Date(),
        description: "Rent June", dueDate: new Date("2026-06-30"), amount: "1000.00",
        currency: "MYR", outstandingAmount: "1000.00", billingMonth: new Date("2026-06-01"),
      },
    });
    await db.billingDocument.create({
      data: {
        id: D_MOVE, organizationId: ORG_A, docType: "invoice", documentNumber: "INV-7001",
        seriesId: SERIES_DEP_A, status: "issued", documentStatus: "ISSUED", taxStatus: "NOT_REQUIRED",
        issuedById: USER_A, counterpartyType: "tenant", partyId: TENANT_A,
        billingMonth: new Date("2026-06-01"), subtotal: "1000.00", sstAmount: 0, total: "1000.00",
        lines: { create: [{ chargeId: C_MOVE, categoryId: CAT_A, description: "Rent June", amount: "1000.00", sstRate: 0, sstAmount: 0 }] },
      },
    });

    // An unpaid charge has collected 0, so no strategy is required — but the
    // caller may still explicitly request CANCEL_AND_REPLACE.
    const r = await voidPostedChargeWithCreditNote({
      organizationId: ORG_A, chargeId: C_MOVE, reason: "unpaid correction",
      strategy: "CANCEL_AND_REPLACE",
      replacement: { lines: [{ categoryId: CAT_A, description: "corrected", amount: "900.00" }] },
      actorUserId: USER_A, actorRole: "admin",
    });

    // Original CANCELLED + superseded, replacement RM900 issued.
    const original = await db.billingDocument.findUniqueOrThrow({ where: { id: D_MOVE } });
    expect(original.documentStatus).toBe("CANCELLED");
    expect(original.supersededByDocumentId).toBe(r.replacementDocumentId);
    // ZERO reversals (nothing was allocated to move).
    expect(await db.paymentAllocationReversal.count({ where: { organizationId: ORG_A } })).toBe(0);
    // ZERO allocations anywhere in org A (none moved, none pre-existing).
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG_A } })).toBe(0);
    // The replacement charge keeps its FULL outstanding (nothing applied).
    const replLine = await db.billingDocumentLine.findFirstOrThrow({ where: { documentId: r.replacementDocumentId! } });
    const replCharge = await db.charge.findUniqueOrThrow({ where: { id: replLine.chargeId! } });
    expect(Number(replCharge.outstandingAmount.toString())).toBe(900);
  });
});
