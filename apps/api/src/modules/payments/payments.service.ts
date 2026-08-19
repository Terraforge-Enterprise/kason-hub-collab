import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { getDb, Prisma } from "@kason/db";
import type { PaymentsSession } from "./payments.types";
import {
  allocatePaymentTx,
  createPayment,
  createPaymentWithAllocationsTx,
  findChargeById,
  findPaymentById,
  findPaymentByNumber,
  findPaymentForMutation,
  findPaymentByIdempotencyKeyAdmin,
  findRecentDuplicatePayment,
  allocatePaymentBatchTx,
  paymentsSummary,
  postPaymentTx,
  rejectPaymentTx,
  voidPaymentTx,
  reverseAllocationTx,
  StaleError,
  AlreadyAllocatedError,
  PartyMismatchError,
  listPayments,
  listInFlightFpxPayments,
  cancelInFlightFpxPaymentTx,
  type ListPaymentsOpts,
} from "./payments.repository";
import {
  listPaymentsNeedingReconciliation,
  resolveNeedsReconciliationTx,
  returnToReconciliationQueueTx,
} from "./fpx-callback.repository";
import {
  allocatePaymentSchema,
  allocatePaymentBatchSchema,
  createPaymentSchema,
  updatePaymentStatusSchema,
  postPaymentSchema,
  rejectPaymentSchema,
  reverseAllocationSchema,
  recordAndAllocatePaymentSchema,
  recordInvoicePaymentSchema,
} from "./payments.validation";
import { dashboardCache } from "../../lib/cache";
import { notifyOwnersOfChargesPaid } from "./payments.owner-notify";
import { afterPaymentSettled } from "./after-payment-settled";
import { refreshDocumentStatusForCharges } from "../billing-documents/status.service";

export async function getPaymentsService(session: PaymentsSession, opts?: ListPaymentsOpts) {
  return listPayments(session.orgId, opts);
}

/** Month-scoped header metrics for the payments v2 page (spec §4). */
export async function getPaymentsSummaryService(session: PaymentsSession, input: { month: string }) {
  const [y, m] = input.month.split("-").map(Number);
  return paymentsSummary(session.orgId, new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 1)));
}

export async function createPaymentService(session: PaymentsSession, input: z.infer<typeof createPaymentSchema>) {
  const duplicate = await findPaymentByNumber(session.orgId, input.paymentNumber);
  if (duplicate) return { ok: false as const, status: 409, error: "Payment number already exists" };

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false as const, status: 400, error: "Amount must be a valid positive number" };

  const payment = await createPayment({
    organizationId: session.orgId,
    paymentNumber: input.paymentNumber,
    partyId: input.partyId,
    paymentType: input.paymentType,
    paymentMethod: input.paymentMethod,
    amount,
    currency: input.currency || "MYR",
    receivedAt: new Date(input.receivedAt),
    referenceNote: input.referenceNote || null,
    externalReference: input.externalReference || null,
  });

  dashboardCache.invalidate(`dashboard:${session.orgId}`);
  return { ok: true as const, status: 201, data: payment };
}

export async function allocatePaymentService(session: PaymentsSession, input: z.infer<typeof allocatePaymentSchema>) {
  const [payment, charge] = await Promise.all([
    findPaymentForMutation(session.orgId, input.paymentId),
    findChargeById(session.orgId, input.chargeId),
  ]);

  if (!payment) return { ok: false as const, status: 404, error: "Payment not found" };
  if (!charge) return { ok: false as const, status: 404, error: "Charge not found" };
  if (charge.status === "void") return { ok: false as const, status: 400, error: "Cannot allocate to void charge" };

  const allocatedAmount = Number(input.allocatedAmount);
  if (!Number.isFinite(allocatedAmount) || allocatedAmount <= 0) {
    return { ok: false as const, status: 400, error: "Allocated amount must be positive" };
  }

  // B7 reroute: no pre-read outstanding cap here — the guarded rail
  // (applyAllocationToChargeTx, inside allocatePaymentTx) re-reads outstanding
  // AND asserts party-match AND guards updatedAt, all inside the transaction.
  //
  // The error-mapping try covers ONLY the tx call: the post-commit hooks below
  // must NOT be inside it, or a hook throwing one of the mapped classes AFTER
  // the allocation committed would surface as a misleading 4xx → client retry →
  // double allocation (single-allocate has no idempotency key).
  let allocation: Awaited<ReturnType<typeof allocatePaymentTx>>;
  try {
    allocation = await allocatePaymentTx({
      organizationId: session.orgId,
      paymentId: input.paymentId,
      chargeId: input.chargeId,
      allocatedAmount,
      expectedPartyId: payment.partyId,
    });
  } catch (err) {
    if (err instanceof PartyMismatchError) {
      return { ok: false as const, status: 400, error: "Charge does not belong to the payment's payer." };
    }
    if (err instanceof StaleError) {
      return { ok: false as const, status: 409, error: "Changed since you loaded it. Refresh and retry." };
    }
    const msg = err instanceof Error ? err.message : "";
    if (msg.startsWith("ALLOC_EXCEEDS_OUTSTANDING")) {
      return { ok: false as const, status: 400, error: "Allocated amount exceeds outstanding charge amount" };
    }
    throw err;
  }

  dashboardCache.invalidate(`dashboard:${session.orgId}`);
  // PART 3: tx committed → notify the owner ONLY if this allocation fully paid the charge.
  if (allocation.becamePaid) {
    await notifyOwnersOfChargesPaid(session.orgId, [allocation.chargeId]);
  }
  // I-1: ALWAYS re-sync the owner-ledger for the touched charge — a PARTIAL payment
  // (becamePaid:false) still reduced outstanding, so the owner's "collected"
  // projection must refresh immediately, not wait for some later trigger.
  await afterPaymentSettled(session.orgId, session.userId, session.role, [allocation.chargeId], {
    paymentId: input.paymentId,
    partyId: payment.partyId,
    // Only a FULLY-settled charge graduates — a part-allocation mints no tax invoice.
    paidChargeIds: allocation.becamePaid ? [allocation.chargeId] : [],
  });
  // Accounting docs: re-derive the linked document's settlement status (flag-gated, never throws).
  await refreshDocumentStatusForCharges([allocation.chargeId]);
  return { ok: true as const, status: 201, data: { id: allocation.id } };
}

export async function updatePaymentStatusService(session: PaymentsSession, input: z.infer<typeof updatePaymentStatusSchema>) {
  const existing = await findPaymentById(session.orgId, input.paymentId);
  if (!existing) return { ok: false as const, status: 404, error: "Payment not found" };
  if (existing.status === "void") return { ok: false as const, status: 400, error: "Void payment cannot be changed" };

  const historyLine = `[status:${input.status} at ${new Date().toISOString()}]${input.note ? ` ${input.note}` : ""}`;
  const referenceNote = existing.referenceNote ? `${existing.referenceNote}\n${historyLine}` : historyLine;

  try {
    const r = await voidPaymentTx({
      organizationId: session.orgId,
      paymentId: input.paymentId,
      status: input.status,
      referenceNote,
      actorUserId: session.userId,
      actorRole: session.role,
    });
    if ("notFound" in r) return { ok: false as const, status: 404, error: "Payment not found" };
    if ("alreadyVoid" in r) return { ok: false as const, status: 400, error: "Void payment cannot be changed" };
    dashboardCache.invalidate(`dashboard:${session.orgId}`);
    // Post-commit: a void restored the charges' outstanding — re-sync the owner
    // ledger AND re-derive linked documents (both flag-gated + never-throw).
    await afterPaymentSettled(session.orgId, session.userId, session.role, r.chargeIds);
    await refreshDocumentStatusForCharges(r.chargeIds);
    return { ok: true as const, status: 200, data: { id: input.paymentId } };
  } catch (err) {
    if (err instanceof StaleError) return { ok: false as const, status: 409, error: "Changed since you loaded it. Refresh and retry." };
    throw err;
  }
}

export async function allocatePaymentBatchService(
  session: PaymentsSession,
  input: z.infer<typeof allocatePaymentBatchSchema>,
) {
  const payment = await findPaymentForMutation(session.orgId, input.paymentId);
  if (!payment) return { ok: false as const, status: 404, error: "Payment not found" };

  // allocate-batch APPLIES immediately so the payment MUST already be posted.
  // pending_approval payments are applied only by POST /post — never here.
  if (payment.status !== "posted") {
    return { ok: false as const, status: 400, error: `Only posted payments can be allocated (was ${payment.status})` };
  }

  // Sequential idempotency: if this payment already carries a key, it was
  // allocated once. Same key → safe replay. Different key → conflict.
  if (payment.idempotencyKey) {
    return payment.idempotencyKey === input.idempotencyKey
      ? { ok: true as const, status: 200, data: { id: payment.id, replayed: true } }
      : { ok: false as const, status: 409, error: "This payment has already been allocated." };
  }

  // A charge may appear only once per batch (else it collides on the allocation
  // @@unique key — never a legitimate request).
  const seen = new Set<string>();
  for (const a of input.allocations) {
    if (seen.has(a.chargeId)) return { ok: false as const, status: 400, error: "Each charge may appear only once per batch." };
    seen.add(a.chargeId);
  }

  let allocations: { chargeId: string; allocatedAmount: number; prorateRatio: string | null }[];
  try {
    allocations = input.allocations.map((a) => {
      const n = Number(a.allocatedAmount);
      if (!Number.isFinite(n) || n <= 0) throw new Error("BAD_AMOUNT");
      return { chargeId: a.chargeId, allocatedAmount: n, prorateRatio: a.prorateRatio ?? null };
    });
  } catch {
    return { ok: false as const, status: 400, error: "Allocated amounts must be positive" };
  }

  try {
    const result = await allocatePaymentBatchTx({
      organizationId: session.orgId,
      paymentId: input.paymentId,
      payerPartyId: payment.partyId,
      paymentAmount: Number(payment.amount.toString()),
      idempotencyKey: input.idempotencyKey,
      actorUserId: session.userId,
      actorRole: session.role,
      allocations,
    });
    dashboardCache.invalidate(`dashboard:${session.orgId}`);
    // PART 3: tx committed → notify the owner of every charge this batch FULLY paid.
    await notifyOwnersOfChargesPaid(session.orgId, result.paidChargeIds);
    // I-1: re-sync the owner-ledger for EVERY charge this batch touched (partial OR
    // full) so a partial allocation refreshes the owner's "collected" immediately.
    await afterPaymentSettled(session.orgId, session.userId, session.role, result.allocatedChargeIds, {
      paymentId: input.paymentId,
      partyId: payment.partyId,
      paidChargeIds: result.paidChargeIds,
    });
    // Accounting docs: re-derive linked documents' settlement status (flag-gated, never throws).
    await refreshDocumentStatusForCharges(result.allocatedChargeIds);
    return result.replayed
      ? { ok: true as const, status: 200, data: { id: input.paymentId, replayed: true } }
      : { ok: true as const, status: 201, data: { id: input.paymentId, allocations: result.allocations } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // idempotencyKey already used by ANOTHER payment in this org.
      const owner = await findPaymentByIdempotencyKeyAdmin(session.orgId, input.idempotencyKey);
      if (owner && owner.id === input.paymentId) return { ok: true as const, status: 200, data: { id: owner.id, replayed: true } };
      return { ok: false as const, status: 409, error: "Idempotency key already used by another payment." };
    }
    if (err instanceof AlreadyAllocatedError) return { ok: false as const, status: 409, error: "This payment has already been allocated." };
    if (err instanceof PartyMismatchError) return { ok: false as const, status: 400, error: "A charge does not belong to the payment's payer." };
    if (err instanceof StaleError) return { ok: false as const, status: 409, error: "A charge changed since you loaded it. Refresh and retry." };
    const msg = err instanceof Error ? err.message : "";
    if (msg.startsWith("ALLOC_EXCEEDS_OUTSTANDING")) return { ok: false as const, status: 400, error: "An allocation exceeds the charge's outstanding amount" };
    if (msg === "ALLOC_EXCEEDS_PAYMENT") return { ok: false as const, status: 400, error: "Allocations exceed the payment amount" };
    throw err;
  }
}

/**
 * Atomic record+allocate (spec B3): create the payment AND apply every
 * allocation in ONE transaction (createPaymentWithAllocationsTx). amount is
 * derived server-side as Σ(allocations) so it always foots. Error mapping
 * mirrors allocatePaymentBatchService — see that function for the same
 * StaleError/PartyMismatchError/ALLOC_EXCEEDS_OUTSTANDING/P2002 cases.
 */
export async function recordAndAllocatePaymentService(
  session: PaymentsSession,
  input: z.infer<typeof recordAndAllocatePaymentSchema>,
) {
  // Whole-operation replay: the key was written at payment-create, so its
  // presence means the previous attempt fully committed (tx is atomic).
  const replayed = await findPaymentByIdempotencyKeyAdmin(session.orgId, input.idempotencyKey);
  if (replayed) return { ok: true as const, status: 200, data: { id: replayed.id, replayed: true } };

  const duplicate = await findPaymentByNumber(session.orgId, input.paymentNumber);
  if (duplicate) return { ok: false as const, status: 409, error: "Payment number already exists" };

  const seen = new Set<string>();
  for (const a of input.allocations) {
    if (seen.has(a.chargeId)) return { ok: false as const, status: 400, error: "Each charge may appear only once per batch." };
    seen.add(a.chargeId);
  }

  let allocations: { chargeId: string; allocatedAmount: number; prorateRatio: string | null }[];
  try {
    allocations = input.allocations.map((a) => {
      const n = Number(a.allocatedAmount);
      if (!Number.isFinite(n) || n <= 0) throw new Error("BAD_AMOUNT");
      return { chargeId: a.chargeId, allocatedAmount: n, prorateRatio: a.prorateRatio ?? null };
    });
  } catch {
    return { ok: false as const, status: 400, error: "Allocated amounts must be positive" };
  }
  const amount = allocations.reduce((s, a) => s + a.allocatedAmount, 0);

  // Spec2 R9: best-effort in-window duplicate-payment guard. NOT a DB
  // constraint — identical payments outside the window are legitimate (e.g.
  // next month's rent), so this only catches accidental double-submits
  // (double-click, browser back+resubmit) within a short window.
  const WINDOW_MIN = 10;
  const softDup = await findRecentDuplicatePayment(session.orgId, {
    partyId: input.partyId,
    // Pass the raw summed amount straight through — findRecentDuplicatePayment
    // rounds it via Prisma.Decimal, identically to how the amount is actually
    // stored (Postgres numeric(12,2) half-up), not via float Math.round. A
    // float Math.round here (the previous approach) disagreed with that
    // storage rounding for 3dp inputs (e.g. 1.005 -> Math.round gives 1.00,
    // but the stored row is 1.01), silently missing a real duplicate.
    amount,
    paymentMethod: input.paymentMethod,
    chargeIds: input.allocations.map((a) => a.chargeId),
    sinceMinutes: WINDOW_MIN,
  });
  if (softDup) {
    return { ok: false as const, status: 409, error: "DUPLICATE_PAYMENT", existingPaymentId: softDup.id };
  }

  try {
    const result = await createPaymentWithAllocationsTx({
      organizationId: session.orgId,
      paymentNumber: input.paymentNumber,
      partyId: input.partyId,
      paymentType: input.paymentType,
      paymentMethod: input.paymentMethod,
      amount,
      currency: input.currency || "MYR",
      receivedAt: new Date(input.receivedAt),
      referenceNote: input.referenceNote || null,
      externalReference: input.externalReference || null,
      idempotencyKey: input.idempotencyKey,
      attachmentKeys: input.attachmentKeys ?? [],
      actorUserId: session.userId,
      actorRole: session.role,
      allocations,
    });
    dashboardCache.invalidate(`dashboard:${session.orgId}`);
    await notifyOwnersOfChargesPaid(session.orgId, result.paidChargeIds);
    // Graduation + receipt now live INSIDE afterPaymentSettled (see that file) so no
    // settlement path can skip them — which is what happened to receipt issuance while
    // it was wired only here.
    await afterPaymentSettled(session.orgId, session.userId, session.role, result.allocatedChargeIds, {
      paymentId: result.paymentId,
      partyId: input.partyId,
      paidChargeIds: result.paidChargeIds,
    });
    await refreshDocumentStatusForCharges(result.allocatedChargeIds);
    return { ok: true as const, status: 201, data: { id: result.paymentId, allocations: result.allocations } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const owner = await findPaymentByIdempotencyKeyAdmin(session.orgId, input.idempotencyKey);
      if (owner) return { ok: true as const, status: 200, data: { id: owner.id, replayed: true } };
      return { ok: false as const, status: 409, error: "Payment number or idempotency key already used." };
    }
    if (err instanceof PartyMismatchError) return { ok: false as const, status: 400, error: "A charge does not belong to the payment's payer." };
    if (err instanceof StaleError) return { ok: false as const, status: 409, error: "A charge changed since you loaded it. Refresh and retry." };
    const msg = err instanceof Error ? err.message : "";
    if (msg.startsWith("ALLOC_EXCEEDS_OUTSTANDING")) return { ok: false as const, status: 400, error: "An allocation exceeds the charge's outstanding amount" };
    throw err;
  }
}

/**
 * Invoice-scoped "Record payment" (manual bank transfer received outside the app).
 * Thin, safe wrapper over recordAndAllocatePaymentService that adds the invoice-only
 * guarantees the accounting UI relies on — WITHOUT forking the proven record path:
 *
 *   1. Loads the target document and confirms it is a payable (invoice/debit_note)
 *      of this org that is NOT cancelled/superseded.
 *   2. Confirms EVERY allocation targets a charge that is actually a line on THIS
 *      document (no cross-invoice allocation, even if the charge shares the payer).
 *   3. Payer + method are DERIVED here (doc.partyId / bank_transfer) — never trusted
 *      from the client — and the transfer slip is mandatory (schema attachmentKeys
 *      min 1, so a bypassed client is rejected at validation).
 *
 * The payment total, per-charge outstanding caps, receipt issuance, settlement-status
 * refresh, owner-ledger sync, and whole-operation idempotency all come from
 * recordAndAllocatePaymentService unchanged.
 */
export async function recordInvoicePaymentService(
  session: PaymentsSession,
  input: z.infer<typeof recordInvoicePaymentSchema>,
) {
  const db = getDb();
  const doc = await db.billingDocument.findFirst({
    where: { id: input.documentId, organizationId: session.orgId },
    select: {
      partyId: true,
      docType: true,
      documentStatus: true,
      lines: { select: { chargeId: true } },
    },
  });
  if (!doc) return { ok: false as const, status: 404, error: "Invoice not found" };
  // `proforma` included (spec's "one narrow exception"). With the flag on the proforma IS
  // the tenant's document for the month, so refusing it here left an admin unable to
  // record a bank transfer against the only document the tenant was ever sent. Payment
  // still settles CHARGES, not the document — the allocation check below is unchanged, and
  // graduation mints the real invoice from the lines this payment settles.
  if (doc.docType !== "invoice" && doc.docType !== "debit_note" && doc.docType !== "proforma") {
    return { ok: false as const, status: 400, error: "This document cannot take a payment." };
  }
  if (doc.documentStatus === "CANCELLED" || doc.documentStatus === "SUPERSEDED") {
    return { ok: false as const, status: 400, error: "This invoice is no longer active." };
  }
  // Every allocation must reference a charge that belongs to THIS invoice.
  const docChargeIds = new Set(doc.lines.map((l) => l.chargeId).filter((x): x is string => x !== null));
  for (const a of input.allocations) {
    if (!docChargeIds.has(a.chargeId)) {
      return { ok: false as const, status: 400, error: "An allocation does not belong to this invoice." };
    }
  }

  // Delegate: amount = Σ(allocations), per-charge outstanding caps, receipt, status
  // refresh, dedup + idempotency all handled there. Payer/method derived from the doc.
  return recordAndAllocatePaymentService(session, {
    paymentNumber: input.paymentNumber,
    partyId: doc.partyId,
    paymentType: "rental_payment",
    paymentMethod: "bank_transfer",
    currency: "MYR",
    receivedAt: input.receivedAt,
    idempotencyKey: input.idempotencyKey,
    attachmentKeys: input.attachmentKeys,
    externalReference: input.externalReference,
    referenceNote: input.referenceNote,
    allocations: input.allocations,
  });
}

export async function reverseAllocationService(session: PaymentsSession, input: z.infer<typeof reverseAllocationSchema>) {
  // R4 idempotency: the tx is idempotent on (organizationId, idempotencyKey) via a
  // DB unique index. A pre-generated key makes a concurrent-replay recoverable —
  // both racing requests need the SAME key so the loser's P2002 can re-read the
  // winner's committed reversal (a fresh randomUUID per attempt would not collide).
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const txParams = {
    organizationId: session.orgId,
    paymentId: input.paymentId,
    allocationId: input.allocationId,
    reason: input.reason,
    idempotencyKey,
    amount: input.amount != null ? Number(input.amount) : null,
    actorUserId: session.userId,
    actorRole: session.role,
  };
  try {
    const r = await reverseAllocationTx(txParams);
    if ("notFound" in r) return { ok: false as const, status: 404, error: "Allocation not found" };
    if ("exceeded" in r) return { ok: false as const, status: 400, error: "REVERSAL_EXCEEDS_ALLOCATED" };
    dashboardCache.invalidate(`dashboard:${session.orgId}`);
    // Post-commit: outstanding restored — re-sync ledger + re-derive documents.
    await afterPaymentSettled(session.orgId, session.userId, session.role, [r.chargeId]);
    await refreshDocumentStatusForCharges([r.chargeId]);
    return {
      ok: true as const,
      status: 200,
      data: {
        reversalId: r.reversalId,
        chargeId: r.chargeId,
        effectiveAllocated: "effectiveAllocated" in r ? r.effectiveAllocated : 0,
      },
    };
  } catch (err) {
    if (err instanceof StaleError) return { ok: false as const, status: 409, error: "Changed since you loaded it. Refresh and retry." };
    // Concurrent-replay loser: a TRUE concurrent replay (same org+idempotencyKey)
    // has both requests pass the in-tx `prior` pre-check (READ COMMITTED hides the
    // uncommitted sibling), both reach create(); the loser hits the unique index →
    // P2002. The winner is already committed, so re-invoke the tx ONCE: the retry
    // hits the `prior` fast-path and returns the idempotent echo WITHOUT a second
    // write. Mirrors recordAndAllocatePaymentService / allocatePaymentBatchService.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const r = await reverseAllocationTx(txParams);
      // Defensive: on a replay these should not occur (the winning reversal exists),
      // but map them to the same contract rather than assume the success shape.
      if ("notFound" in r) return { ok: false as const, status: 404, error: "Allocation not found" };
      if ("exceeded" in r) return { ok: false as const, status: 400, error: "REVERSAL_EXCEEDS_ALLOCATED" };
      return {
        ok: true as const,
        status: 200,
        data: {
          reversalId: r.reversalId,
          chargeId: r.chargeId,
          effectiveAllocated: "effectiveAllocated" in r ? r.effectiveAllocated : 0,
        },
      };
    }
    throw err;
  }
}

export async function postPaymentService(session: PaymentsSession, input: z.infer<typeof postPaymentSchema>) {
  try {
    const r = await postPaymentTx({ organizationId: session.orgId, paymentId: input.paymentId, actorUserId: session.userId, actorRole: session.role });
    if ("notFound" in r) return { ok: false as const, status: 404, error: "Payment not found" };
    if ("badStatus" in r) return { ok: false as const, status: 400, error: `Only pending_approval payments can be posted (was ${r.status})` };
    dashboardCache.invalidate(`dashboard:${session.orgId}`);
    // PART 3: tx committed → notify the owner of every charge this post FULLY paid.
    await notifyOwnersOfChargesPaid(session.orgId, r.paidChargeIds ?? []);
    // I-1: re-sync the owner-ledger for EVERY charge this post touched (partial OR
    // full) so a partial settlement refreshes the owner's "collected" immediately.
    //
    // THE path a tenant's portal FPX payment settles through (fpx-callback.service.ts →
    // here), the requery sweep, and an admin approving a bank-transfer slip. Passing the
    // payment is what finally gives all three a receipt: this call site had the ledger
    // follow-ons but never the receipt hook, so paying online minted no receipt at all.
    await afterPaymentSettled(session.orgId, session.userId, session.role, r.allocatedChargeIds ?? [], {
      paymentId: input.paymentId,
      partyId: r.partyId,
      paidChargeIds: r.paidChargeIds ?? [],
    });
    // Accounting docs: re-derive linked documents' settlement status (flag-gated, never throws).
    await refreshDocumentStatusForCharges(r.allocatedChargeIds ?? []);
    return { ok: true as const, status: 200, data: { id: input.paymentId, status: "posted" } };
  } catch (err) {
    if (err instanceof StaleError) return { ok: false as const, status: 409, error: "Changed since you loaded it. Refresh and retry." };
    if (err instanceof Error && err.message.startsWith("ALLOC_EXCEEDS_OUTSTANDING")) return { ok: false as const, status: 409, error: "A charge's outstanding amount changed; this payment can no longer be applied as recorded." };
    if (err instanceof Error && err.message === "ALLOC_EXCEEDS_PAYMENT") return { ok: false as const, status: 409, error: "Recorded allocations exceed the payment amount." };
    throw err;
  }
}

/**
 * Refuse a tenant-submitted transfer slip, with a reason the tenant will read.
 *
 * Intentionally does NOT call afterPaymentSettled / refreshDocumentStatusForCharges
 * the way post and void do. Both of those exist to re-derive projections after
 * settled money moved; a rejection moves none — the charges were never touched
 * (see rejectPaymentTx) and the payment was never cash. Re-deriving here would
 * burn queries to recompute values that cannot have changed.
 */
export async function rejectPaymentService(session: PaymentsSession, input: z.infer<typeof rejectPaymentSchema>) {
  try {
    const r = await rejectPaymentTx({
      organizationId: session.orgId,
      paymentId: input.paymentId,
      reason: input.reason,
      actorUserId: session.userId,
      actorRole: session.role,
    });
    if ("notFound" in r) return { ok: false as const, status: 404, error: "Payment not found" };
    if ("badStatus" in r) {
      return {
        ok: false as const,
        status: 400,
        error: `Only a payment awaiting verification can be rejected (was ${r.status})`,
      };
    }
    return { ok: true as const, status: 200, data: { id: input.paymentId, status: "rejected" } };
  } catch (err) {
    if (err instanceof StaleError) return { ok: false as const, status: 409, error: "Changed since you loaded it. Refresh and retry." };
    throw err;
  }
}

// ── In-flight FPX ops (admin) ───────────────────────────────────────────────

/** Admin view of the org's stuck in-flight FPX payments (payer, amount, age). */
export async function listInFlightFpxService(session: PaymentsSession) {
  const data = await listInFlightFpxPayments(session.orgId);
  return { data };
}

/**
 * The `needs_reconciliation` queue — payments the gateway confirmed that we
 * could not apply automatically, because a human had already cancelled them or
 * the gateway had already failed them.
 *
 * Every row is money the payer's bank has most likely taken and our books do not
 * yet show. Left unattended it becomes a refund demand with a 60-day clock.
 */
export async function listNeedsReconciliationService(session: PaymentsSession) {
  const data = await listPaymentsNeedingReconciliation(session.orgId);
  return { data };
}

/**
 * Resolve one queued payment, either way.
 *
 * `settle` hands it back to the ordinary settle path rather than writing money
 * here; `dismiss` closes it as genuinely-not-received. Both require a reason and
 * are audited — a person is overriding an automated decision about money.
 *
 * 409 rather than 404 when the row has moved on, because the realistic cause is
 * another admin working the same list, not a bad id.
 */
export async function resolveNeedsReconciliationService(
  session: PaymentsSession,
  input: { paymentId: string; action: "settle" | "dismiss"; reason: string },
) {
  const applied = await resolveNeedsReconciliationTx({
    organizationId: session.orgId,
    paymentId: input.paymentId,
    action: input.action,
    reason: input.reason,
    actorUserId: session.userId,
    actorRole: session.role,
  });
  if (!applied) {
    return {
      ok: false as const,
      status: 409,
      error: "This payment is no longer awaiting reconciliation — someone may have just resolved it. Refresh and check.",
    };
  }

  if (input.action === "settle") {
    // Reuse the ONE settle path. If it cannot apply (a charge's outstanding
    // drifted while the payment sat in the queue), say so plainly instead of
    // reporting a success that did not move any money.
    const posted = await postPaymentService(session, { paymentId: input.paymentId });
    if (!posted.ok) {
      // Put it BACK in the queue. The status change committed in its own
      // transaction above, so without this the row is left `pending_approval` —
      // out of the reconciliation list entirely, and visible only in the
      // in-flight FPX panel whose sole action is Cancel. Money the bank took
      // would quietly stop being tracked as a liability at exactly the moment we
      // learned it needs a human.
      await returnToReconciliationQueueTx({
        organizationId: session.orgId,
        paymentId: input.paymentId,
        actorUserId: session.userId,
        actorRole: session.role,
        error: posted.error,
      });
      return {
        ok: false as const,
        status: 409,
        error: `Could not be applied automatically, so it stays in the queue: ${posted.error}`,
      };
    }
  }

  dashboardCache.invalidate(`dashboard:${session.orgId}`);
  return { ok: true as const, status: 200, data: { id: input.paymentId, action: input.action } };
}

/**
 * Admin cancel of a stuck in-flight FPX payment → "expired". 404 if missing, 400
 * if the payment is not in-flight FPX (already settled/posted/failed — never
 * reverse collected money here), 409 if a concurrent callback raced the update.
 */
export async function cancelInFlightFpxService(session: PaymentsSession, paymentId: string) {
  try {
    const r = await cancelInFlightFpxPaymentTx({
      organizationId: session.orgId,
      paymentId,
      actorUserId: session.userId,
      actorRole: session.role,
    });
    if ("notFound" in r) return { ok: false as const, status: 404, error: "Payment not found" };
    if ("notInFlight" in r) {
      const detail = r.gatewayStatus ? `${r.status}/${r.gatewayStatus}` : r.status;
      return { ok: false as const, status: 400, error: `Only an in-flight FPX payment can be cancelled (was ${detail}).` };
    }
    dashboardCache.invalidate(`dashboard:${session.orgId}`);
    return { ok: true as const, status: 200, data: { id: paymentId, status: "expired" } };
  } catch (err) {
    if (err instanceof StaleError) return { ok: false as const, status: 409, error: "Changed since you loaded it. Refresh and retry." };
    throw err;
  }
}
