import { getDb, Prisma } from "@kason/db";
import {
  isTenantPayableChargeStatus, TENANT_PAYABLE_CHARGE_STATUSES, BLOCKS_FURTHER_PAYMENT_WHERE,
  foldPayableTaxSiblings,
} from "@kason/shared";
import { recordAudit } from "../../../lib/audit";
import { resolveTenantBillReferences } from "../charges/tenant-charge-reference";
import { resolveTaxSiblingFold, displayWhere, pageSiblingWhere } from "../charges/tax-sibling-fold";
import { FPX_PROVIDER_IDS, type FpxProviderId } from "../../../lib/fpx/providers";

function toNumber(value: { toString(): string } | string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

type SessionScope = { partyId: string; orgId: string };

export async function listPayments(session: SessionScope, page: number, limit: number) {
  const db = getDb();
  // `expired` is hidden from the tenant.
  //
  // It means a payment attempt that never became anything: no money moved, no
  // charge was settled, and nothing is owed against the row itself. Every
  // surveyed payment provider keeps that record on the merchant's side only —
  // an abandoned attempt is an operational fact, not something the payer needs.
  //
  // Leaving them visible is what prompted this work: a tenant saw two dead
  // attempts sitting under a heading implying someone was reviewing their money,
  // days after they had successfully paid. The charge they relate to is already
  // shown, accurately, under Invoices & Charges.
  //
  // Everything else stays: `failed` and `rejected` are real events the tenant
  // lived through (and `rejected` carries the reason they need in order to
  // re-submit), and `needs_reconciliation` is money that HAS left their account.
  const where = {
    partyId: session.partyId,
    organizationId: session.orgId,
    status: { not: "expired" },
  };

  const [rows, total] = await Promise.all([
    db.payment.findMany({
      where,
      select: {
        id: true,
        paymentNumber: true,
        paymentMethod: true,
        status: true,
        amount: true,
        currency: true,
        receivedAt: true,
        referenceNote: true,
        rejectionReason: true,
      },
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.payment.count({ where }),
  ]);

  return {
    data: rows.map((r) => ({
      id: r.id,
      paymentNumber: r.paymentNumber,
      paymentMethod: r.paymentMethod,
      status: r.status,
      amount: toNumber(r.amount),
      currency: r.currency,
      receivedAt: r.receivedAt.toISOString(),
      referenceNote: r.referenceNote,
      // Tenant-VISIBLE by design: a refused slip is useless to the tenant
      // without the reason, since re-submitting the same bad slip is the only
      // other option. `referenceNote` beside it stays internal — this is a
      // separate column precisely so the two never get confused.
      rejectionReason: r.rejectionReason,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ── C2 additions ──────────────────────────────────────────────────────────────

export async function findPaymentByIdempotencyKey(orgId: string, key: string) {
  const db = getDb();
  return db.payment.findFirst({ where: { organizationId: orgId, idempotencyKey: key }, select: { id: true, paymentNumber: true } });
}

// Payability now comes from the shared TENANT_CHARGE_PAYABILITY map
// (@kason/shared tenant-visibility) rather than a local list. The local
// deny-list here and the local allow-list further down (PAYABLE_STATUSES)
// disagreed on `credited`, and neither was checked against CHARGE_STATUSES.

/**
 * Validate a basket of payment lines INSIDE the caller's transaction: every
 * charge must belong to the tenant (party + org scoped), be payable, carry a
 * positive amount (`BAD_AMOUNT`), and allocate its FULL outstanding balance —
 * rejecting both over-payment (`ALLOC_EXCEEDS_OUTSTANDING`) and under-payment
 * (`ALLOC_BELOW_OUTSTANDING`) — within a ±0.005 tolerance for decimal
 * rounding. Returns the basket total. Throws a tagged Error the service maps
 * to an HTTP status.
 *
 * Shared by BOTH the manual `/pay` path (submitMultiPaymentTx) and the FPX
 * initiate path (initiateFpxPaymentTx) so the ownership/payable/outstanding
 * rules can never drift between them.
 */
export async function validatePaymentAllocationsTx(
  tx: Prisma.TransactionClient,
  params: { organizationId: string; partyId: string; lines: { chargeId: string; allocatedAmount: number }[] },
): Promise<number> {
  let total = 0;
  for (const l of params.lines) {
    // FOR UPDATE FIRST — before the read, not after it. Everything below is a
    // read-then-write on this charge: the outstanding comparisons decide whether
    // to accept the money, and the double-submit check decides whether someone
    // already claimed it. Reading `outstandingAmount` unlocked and validating
    // against that stale figure is how an accepted allocation later blows up in
    // `applyAllocationToChargeTx` with ALLOC_EXCEEDS_OUTSTANDING — by which point
    // the payer has been debited at the bank and the settle can only fail.
    //
    // Lock ordering is unchanged (still one charge at a time, in line order), and
    // in the uncontended path — which is every path today — taking the same row
    // lock 35 lines earlier is invisible.
    await tx.$queryRaw`SELECT id FROM "Charge" WHERE id = ${l.chargeId}::uuid FOR UPDATE`;

    const charge = await tx.charge.findFirst({
      where: { id: l.chargeId, partyId: params.partyId, organizationId: params.organizationId },
      select: { id: true, status: true, outstandingAmount: true, chargeNumber: true },
    });
    if (!charge) throw new Error("CHARGE_NOT_FOUND");
    // Allow-list, so an unrecognised/legacy status fails CLOSED — settling money
    // against a charge in an unknown state is a mutation, not a display nit.
    if (!isTenantPayableChargeStatus(charge.status)) throw new Error("CHARGE_NOT_PAYABLE");
    const outstanding = Number(charge.outstandingAmount.toString());
    if (l.allocatedAmount <= 0) throw new Error("BAD_AMOUNT");
    if (l.allocatedAmount > outstanding + 0.005) throw new Error("ALLOC_EXCEEDS_OUTSTANDING");
    if (l.allocatedAmount < outstanding - 0.005) throw new Error("ALLOC_BELOW_OUTSTANDING");

    // Double-submit guard. An unverified payment settles nothing, so
    // `outstandingAmount` above still reads the FULL amount — without this, a
    // tenant who submits a slip and comes back an hour later (or just
    // double-taps) can stack a second claim on money they already claimed, and
    // an admin sees two slips for one transfer with no way to tell whether it
    // was paid once or twice.
    //
    // Sits in the shared validator so it also covers slip-then-FPX. It blocks
    // ONLY claims awaiting a human (AWAITING_VERIFICATION_WHERE — manual slips,
    // `gatewayStatus: null`). An in-flight FPX attempt is deliberately NOT a
    // blocker: it is waiting on the gateway, and an earlier version of this
    // guard that matched it took the primary payment rail offline for 30
    // minutes after any abandoned bank redirect. "rejected"/"expired"/"failed"
    // never block either — freeing the charge is the whole point of telling a
    // tenant why their slip was refused.
    //
    // The charge row lock taken at the top of this iteration is what makes the
    // check below safe: PaymentAllocation's unique key is (org, paymentId,
    // chargeId, allocatedAt) — keyed on paymentId, so two DIFFERENT payments
    // claiming one charge do not collide. Under READ COMMITTED two concurrent
    // submissions would each see no pending row and both commit. The lock
    // serialises them, so the second sees the first's committed allocation.
    const pending = await tx.paymentAllocation.findFirst({
      where: {
        organizationId: params.organizationId,
        chargeId: l.chargeId,
        // Blocks a slip awaiting a human AND a payment the gateway already
        // confirmed but that we have not applied yet (`needs_reconciliation`).
        // The second is the stronger case: the payer has almost certainly been
        // debited, and the copy on that payment tells them not to pay again — so
        // the charge must not simultaneously present itself as payable.
        ...BLOCKS_FURTHER_PAYMENT_WHERE,
      },
      select: { id: true },
    });
    if (pending) throw new Error("CHARGE_PENDING_VERIFICATION");

    total += l.allocatedAmount;
  }
  return total;
}

export async function submitMultiPaymentTx(params: {
  organizationId: string; partyId: string; actorUserId: string;
  paymentNumber: string; idempotencyKey: string; paymentMethod: string;
  referenceNumber: string; notes: string | null;
  /** Transfer-slip storage keys. Prefix-verified against the session by the caller. */
  attachmentKeys: string[];
  lines: { chargeId: string; allocatedAmount: number; prorateRatio: string | null }[];
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    // Validate every charge belongs to the tenant, is payable, and within outstanding.
    const total = await validatePaymentAllocationsTx(tx, {
      organizationId: params.organizationId, partyId: params.partyId, lines: params.lines,
    });

    const payment = await tx.payment.create({
      data: {
        organizationId: params.organizationId, paymentNumber: params.paymentNumber,
        partyId: params.partyId, paymentType: "incoming", paymentMethod: params.paymentMethod,
        status: "pending_approval", amount: total, currency: "MYR", receivedAt: new Date(),
        referenceNote: params.notes, externalReference: params.referenceNumber,
        idempotencyKey: params.idempotencyKey,
        attachmentKeys: params.attachmentKeys,
      },
      select: { id: true, paymentNumber: true },
    });

    const allocatedAt = new Date();
    for (const l of params.lines) {
      await tx.paymentAllocation.create({
        data: {
          organizationId: params.organizationId, paymentId: payment.id, chargeId: l.chargeId,
          allocatedAmount: l.allocatedAmount, prorateRatio: l.prorateRatio, allocatedAt,
        },
      });
    }

    await tx.notification.create({
      data: {
        organizationId: params.organizationId, domain: "finance",
        title: `Payment submitted: ${payment.paymentNumber}`,
        body: `Tenant submitted ${params.paymentMethod} payment of MYR ${total.toFixed(2)} across ${params.lines.length} charge(s). Reference: ${params.referenceNumber}`,
        actionUrl: "/billing/payments",
      },
    });

    await recordAudit(tx, {
      organizationId: params.organizationId, actorUserId: params.actorUserId, actorRole: "tenant",
      action: "payment.submitted", entityType: "Payment", entityId: payment.id,
      diff: { amount: total, lines: params.lines.length },
    });

    return { id: payment.id, paymentNumber: payment.paymentNumber };
  });
}

// ── FPX initiate (sub-project A) ────────────────────────────────────────────

/**
 * Idempotency lookup for the FPX path. Returns the existing FPX payment's id,
 * providerTxnId and amount so a replay can re-mint a redirect for the SAME
 * gateway transaction instead of creating a second Payment. Scoped to rows that
 * actually carry a providerTxnId (i.e. FPX-initiated), so a manual payment that
 * happened to reuse the key is ignored here.
 */
export async function findFpxPaymentByIdempotencyKey(orgId: string, key: string) {
  const db = getDb();
  const row = await db.payment.findFirst({
    where: { organizationId: orgId, idempotencyKey: key, providerTxnId: { not: null } },
    select: { id: true, providerTxnId: true, amount: true },
  });
  if (!row || !row.providerTxnId) return null;
  return { id: row.id, providerTxnId: row.providerTxnId, amount: toNumber(row.amount) };
}

/**
 * Lazy GC of a tenant's OWN abandoned in-flight FPX attempts. When the same
 * tenant re-initiates, any of THEIR earlier FPX payments still stuck
 * pending_approval + gatewayStatus "pending" past `olderThan` are flipped to
 * status/gatewayStatus "expired". Charges are NEVER touched — a pending FPX
 * payment never settled any (the callback settles), so expiring it reverses
 * nothing; it just stops an abandoned attempt from lingering as in-flight.
 *
 * Scoped to (organizationId, partyId) so a tenant can only ever expire their own
 * rows. `exceptIdempotencyKey` excludes THIS request's key so a racing same-key
 * initiate (resolved by the P2002 re-fetch in the service) is never expired out
 * from under itself. A bulk `updateMany` — no per-row audit (housekeeping, no
 * money moved); the explicit admin cancel path records its own audit.
 *
 * Returns the number of rows expired.
 */
export async function expireStaleInFlightFpxPayments(params: {
  organizationId: string;
  partyId: string;
  olderThan: Date;
  exceptIdempotencyKey?: string;
}): Promise<number> {
  const db = getDb();
  const res = await db.payment.updateMany({
    where: {
      organizationId: params.organizationId,
      partyId: params.partyId,
      // Any FPX provider's abandoned rows expire — a provider swap must not
      // leave the previous provider's in-flight attempts lingering forever.
      provider: { in: [...FPX_PROVIDER_IDS] },
      gatewayStatus: "pending",
      status: "pending_approval",
      createdAt: { lt: params.olderThan },
      ...(params.exceptIdempotencyKey ? { idempotencyKey: { not: params.exceptIdempotencyKey } } : {}),
    },
    data: { status: "expired", gatewayStatus: "expired" },
  });
  return res.count;
}

/**
 * Create a PENDING FPX payment + its allocations in one transaction. NO charge
 * is settled (outstanding untouched) — the signed gateway callback (Task 3)
 * does that. NO admin notification — the gateway, not an admin, reconciles. The
 * caller mints `providerTxnId` (it must be known before the gateway redirect)
 * and `paymentNumber`. Reuses validatePaymentAllocationsTx so the payable rules
 * match the manual path exactly.
 */
export async function initiateFpxPaymentTx(params: {
  organizationId: string; partyId: string; actorUserId: string;
  /** The ACTIVE gateway's id (`getFpxGateway().provider`) — stamped on the row. */
  provider: FpxProviderId;
  paymentNumber: string; providerTxnId: string; idempotencyKey: string;
  lines: { chargeId: string; allocatedAmount: number; prorateRatio: string | null }[];
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const total = await validatePaymentAllocationsTx(tx, {
      organizationId: params.organizationId, partyId: params.partyId, lines: params.lines,
    });

    const payment = await tx.payment.create({
      data: {
        organizationId: params.organizationId, paymentNumber: params.paymentNumber,
        partyId: params.partyId, paymentType: "incoming", paymentMethod: "fpx",
        provider: params.provider, providerTxnId: params.providerTxnId, gatewayStatus: "pending",
        status: "pending_approval", amount: total, currency: "MYR", receivedAt: new Date(),
        externalReference: params.providerTxnId, idempotencyKey: params.idempotencyKey,
      },
      select: { id: true },
    });

    const allocatedAt = new Date();
    for (const l of params.lines) {
      await tx.paymentAllocation.create({
        data: {
          organizationId: params.organizationId, paymentId: payment.id, chargeId: l.chargeId,
          allocatedAmount: l.allocatedAmount, prorateRatio: l.prorateRatio, allocatedAt,
        },
      });
    }

    await recordAudit(tx, {
      organizationId: params.organizationId, actorUserId: params.actorUserId, actorRole: "tenant",
      action: "payment.fpx_initiated", entityType: "Payment", entityId: payment.id,
      diff: { amount: total, lines: params.lines.length, providerTxnId: params.providerTxnId },
    });

    return { id: payment.id, providerTxnId: params.providerTxnId, amount: total };
  });
}

/**
 * Tenant billing details for the gateway's hosted payment page. Nullable
 * contact fields fall through as undefined — the adapter renders its own
 * fallbacks; nothing here is validated or money-bearing.
 */
export async function findPartyBillingInfo(orgId: string, partyId: string) {
  const db = getDb();
  const row = await db.party.findFirst({
    where: { id: partyId, organizationId: orgId },
    select: { displayName: true, primaryEmail: true, primaryPhone: true },
  });
  if (!row) return undefined;
  return {
    name: row.displayName,
    email: row.primaryEmail ?? undefined,
    mobile: row.primaryPhone ?? undefined,
  };
}

export async function getPaymentReceipt(session: SessionScope, paymentId: string) {
  const db = getDb();
  return db.payment.findFirst({
    where: { id: paymentId, partyId: session.partyId, organizationId: session.orgId },
    select: {
      id: true,
      paymentNumber: true,
      paymentMethod: true,
      status: true,
      amount: true,
      currency: true,
      receivedAt: true,
      referenceNote: true,
      externalReference: true,
      allocations: {
        select: {
          allocatedAmount: true,
          charge: { select: { chargeNumber: true, chargeType: true } },
        },
      },
    },
  });
}

/** The columns a payable row needs. Shared by the page query and the SST-sibling
 * pull-in below, so the two can never select different shapes. */
const PAYABLE_CHARGE_SELECT = {
  id: true,
  chargeNumber: true,
  chargeType: true,
  description: true,
  dueDate: true,
  amount: true,
  outstandingAmount: true,
  currency: true,
  invoiceId: true,
  parentChargeId: true,
  invoice: { select: { invoiceNumber: true } },
} as const;

export async function listPayableCharges(session: SessionScope, page: number, limit: number) {
  const db = getDb();
  // TENANT_PAYABLE_CHARGE_STATUSES replaces the local PAYABLE_STATUSES list,
  // which had drifted three ways: it disagreed with this file's own
  // NON_PAYABLE list about `credited`, and it carried "overdue"/"pending" —
  // values nothing in the repo has ever written to Charge.status. The legacy
  // "partial" alias IS preserved by the shared list.
  const where = {
    partyId: session.partyId,
    organizationId: session.orgId,
    status: { in: TENANT_PAYABLE_CHARGE_STATUSES },
    outstandingAmount: { gt: 0 },
  };

  // ─── Which SST siblings will FOLD, decided before paginating ───────────────
  //
  // An SST-bearing expense is TWO Charges (base + a sibling whose amount IS the
  // tax — see foldPayableTaxSiblings' header). Both are payable, so this list used
  // to show the tenant two bills for one thing: "test ten exp sst RM 0.50" and
  // "test ten exp sst — SST 8% RM 0.04", where their invoice showed one line of
  // RM 0.54. Worse, the two were independently tickable, so paying only the base
  // left the document four sen short of settled forever.
  //
  // The decision, the display filter and the pull-in all live in tax-sibling-fold.ts
  // so this endpoint and `listCharges` cannot drift — they had already drifted once,
  // when only this one folded.
  const { taxIds, foldableTaxIds } = await resolveTaxSiblingFold(db, where);
  const pagedWhere = displayWhere(where, foldableTaxIds);

  const [rows, total] = await Promise.all([
    db.charge.findMany({
      where: pagedWhere,
      select: PAYABLE_CHARGE_SELECT,
      orderBy: { dueDate: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.charge.count({ where: pagedWhere }),
  ]);

  const siblingFilter = pageSiblingWhere(where, foldableTaxIds, rows.map((r) => r.id));
  const siblingRows = siblingFilter
    ? await db.charge.findMany({ where: siblingFilter, select: PAYABLE_CHARGE_SELECT })
    : [];
  const allRows = [...rows, ...siblingRows];

  // Which of THIS page's charges already carry an unverified payment. Such a
  // charge still reads outstanding (an unverified payment settles nothing), so
  // without this flag it would render as freely payable and the tenant would be
  // invited to pay a second time — the exact double-submit the validator
  // rejects. Surfacing it here turns a confusing 409 into a visible state.
  //
  // MUST use the same predicate as the validator's guard, or the two disagree
  // and the UI hides a charge the server would happily accept (or vice versa).
  // In particular an in-flight FPX attempt must NOT mark a charge pending —
  // doing so removed the charge from the payable list entirely while the tenant
  // was still mid-checkout at their bank.
  //
  // One grouped query for the page, not one per row. Covers the pulled-in SST
  // siblings too: a claim on EITHER half must mark the folded row pending, or the
  // tenant is invited to pay money they have already claimed and the validator
  // rejects the whole basket.
  const pendingRows = allRows.length
    ? await db.paymentAllocation.groupBy({
        by: ["chargeId"],
        where: {
          organizationId: session.orgId,
          chargeId: { in: allRows.map((r) => r.id) },
          // Must match the submit-time guard exactly. If this flag is narrower,
          // the charge renders as freely payable and the tenant only discovers
          // otherwise when their submission is refused — the worst place to find
          // out, since by then they believe they are paying.
          ...BLOCKS_FURTHER_PAYMENT_WHERE,
        },
      })
    : [];
  const pendingChargeIds = new Set(pendingRows.map((p) => p.chargeId));

  // The number printed on the bill the tenant was actually sent. Grid mints never
  // set Charge.invoiceId — they attach to BillingDocuments — so without this every
  // grid row fell through to `chargeNumber` and showed the tenant an internal id
  // like `GRIDEXP-202608-360f0307-…-SST`. See tenant-charge-reference.ts.
  const billRefs = await resolveTenantBillReferences(db, session.orgId, allRows.map((r) => r.id));

  // The fold itself is a pure function in @kason/shared, unit-tested there against
  // every orphan and out-of-step shape. Everything above only decides WHICH rows it
  // gets to see; the money merge and the `components` split live in one place.
  const data = foldPayableTaxSiblings(
    allRows.map((r) => ({
      id: r.id,
      chargeNumber: r.chargeNumber,
      chargeType: r.chargeType,
      description: r.description,
      dueDate: r.dueDate.toISOString(),
      amount: toNumber(r.amount),
      outstandingAmount: toNumber(r.outstandingAmount),
      currency: r.currency,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoice?.invoiceNumber ?? null,
      /** The bill number to show the tenant, or null when this charge is on no
       * bill yet. Clients MUST NOT fall back to `chargeNumber`. */
      documentNumber: billRefs.get(r.id) ?? null,
      pendingVerification: pendingChargeIds.has(r.id),
      parentChargeId: r.parentChargeId,
      isTax: taxIds.has(r.id),
    })),
  );

  return {
    // `total` counts display rows (folded siblings excluded from displayWhere), so
    // it stays consistent with what `data` actually returns per page.
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
