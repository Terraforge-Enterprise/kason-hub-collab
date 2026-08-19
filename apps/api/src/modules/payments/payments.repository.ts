import { getDb } from "@kason/db";
import { findDocumentsByChargeIds } from "../billing/billing.repository";
import { FPX_PROVIDER_IDS, isFpxProviderId } from "../../lib/fpx/providers";

function toNumber(value: { toString(): string } | string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

export type ListPaymentsOpts = {
  status?: string;
  partyId?: string;
  method?: string;
  from?: string;
  to?: string;
  hasUnallocated?: boolean;
  cursor?: string;
  limit?: number;
};

export async function listPayments(orgId: string, opts: ListPaymentsOpts = {}) {
  const db = getDb();
  const limit = opts.limit ?? 50;

  // Build base where clause — always org-scoped.
  const where: Record<string, unknown> = { organizationId: orgId };
  if (opts.status) where.status = opts.status;
  // Exclude gateway-in-flight FPX payments from the admin listing so an admin can
  // never PREMATURELY post a tenant FPX payment that the bank has not yet
  // confirmed. An initiated FPX payment is pending_approval + gatewayStatus
  // "pending" and only settles via the signed gateway callback (which moves it to
  // "success"/"posted" or "failed"); the admin "Post (approve) payment" affordance
  // feeds off THIS listing (it filters pending_approval client-side from the
  // default unfiltered view), so the in-flight row must be hidden here.
  //
  // NULL-safe via an explicit OR: Prisma's `{ not: "pending" }` compiles to a bare
  // `gatewayStatus <> 'pending'`, and in SQL `NULL <> 'pending'` is NULL (not
  // TRUE), so a bare `not` would WRONGLY drop manual bank_transfer/cash payments
  // (gatewayStatus IS NULL). The `{ gatewayStatus: null }` branch keeps those — and
  // every settled row (gatewayStatus "success"/"failed") passes the `not` branch.
  //
  // The third `{ status: "posted" }` branch rescues a settle that COMMITTED but
  // whose separate setFpxGatewaySuccess stamp died in the window after
  // postPaymentService — leaving status "posted" + gatewayStatus still "pending".
  // That money is fully collected, so the row must NOT be hidden from every admin
  // view; it stays in-flight ONLY while still pending_approval (which this branch
  // does not match), so a genuinely in-flight FPX payment remains excluded.
  where.OR = [{ gatewayStatus: null }, { gatewayStatus: { not: "pending" } }, { status: "posted" }];
  if (opts.partyId) where.partyId = opts.partyId;
  if (opts.method) where.paymentMethod = opts.method;
  if (opts.from || opts.to) {
    where.receivedAt = {
      ...(opts.from ? { gte: new Date(opts.from) } : {}),
      ...(opts.to ? { lte: new Date(opts.to) } : {}),
    };
  }

  // Row mapper — identical shape used by both code paths below. docByCharge
  // resolves each allocation's charge to its minted (non-CN/RN) document
  // number (Spec1 R6) — passed in per-call since the two findMany paths below
  // fetch disjoint row sets and must resolve documents against THEIR OWN rows.
  function mapRow(
    row: {
      id: string;
      partyId: string;
      paymentNumber: string;
      party: { displayName: string };
      paymentType: string;
      paymentMethod: string;
      status: string;
      amount: Parameters<typeof toNumber>[0];
      currency: string;
      receivedAt: Date;
      referenceNote: string | null;
      idempotencyKey: string | null;
      allocations: {
        id: string;
        allocatedAmount: Parameters<typeof toNumber>[0];
        allocatedAt: Date;
        charge: { id: string; chargeNumber: string };
      }[];
    },
    docByCharge: Map<string, { id: string; documentNumber: string }>,
  ) {
    return {
      id: row.id,
      paymentNumber: row.paymentNumber,
      partyId: row.partyId,
      partyName: row.party.displayName,
      paymentType: row.paymentType,
      paymentMethod: row.paymentMethod,
      status: row.status,
      amount: toNumber(row.amount),
      currency: row.currency,
      receivedAt: row.receivedAt.toISOString(),
      // Additive (final-review fix wave): allocatePaymentBatchTx claims a payment's
      // idempotencyKey once via compare-and-set on null — a payment that already
      // carries a key (record-and-allocate, or a settled FPX payment) 409s on ANY
      // further allocate-batch attempt. The web row-menu uses this to hide "Allocate…"
      // for payments that can never accept one, instead of dead-ending the click.
      hasBatchKey: row.idempotencyKey != null,
      historySummary: [
        `received ${row.receivedAt.toISOString().slice(0, 16).replace("T", " ")}`,
        `current status: ${row.status}`,
        ...(row.referenceNote
          ? row.referenceNote
              .split("\n")
              .slice(-2)
              .map((line) => line.trim())
              .filter(Boolean)
          : []),
      ],
      allocations: row.allocations.map((alloc) => ({
        id: alloc.id,
        chargeNumber: alloc.charge.chargeNumber,
        documentNumber: docByCharge.get(alloc.charge.id)?.documentNumber ?? null,
        allocatedAmount: toNumber(alloc.allocatedAmount),
        allocatedAt: alloc.allocatedAt.toISOString(),
      })),
    };
  }

  // hasUnallocated cannot be pushed into SQL (it requires comparing payment.amount
  // against Σ(allocations.allocatedAmount) which Prisma cannot express as a WHERE
  // predicate directly). Keyset pagination would under-fill pages and produce a
  // nextCursor that skips over filtered-out rows, causing lost/duplicated records.
  // When hasUnallocated is set we therefore disable keyset pagination entirely:
  // fetch ALL rows matching the other (org + status/partyId/method/date) filters,
  // apply the unallocated check in-memory, and return the full result with
  // nextCursor=null. For finance triage this is acceptable — the result set is
  // typically small and must not be silently truncated.
  if (opts.hasUnallocated !== undefined) {
    const rows = await db.payment.findMany({
      where,
      include: {
        party: { select: { displayName: true } },
        allocations: {
          orderBy: [{ allocatedAt: "desc" }],
          include: { charge: { select: { chargeNumber: true, id: true } } },
        },
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      // No take limit — we need every matching row to apply the in-memory filter correctly.
    });

    const allocChargeIds = rows.flatMap((r) => r.allocations.map((a) => a.charge.id));
    const docByCharge = await findDocumentsByChargeIds(allocChargeIds);

    const wantUnallocated = opts.hasUnallocated;
    const filtered = rows.map((r) => mapRow(r, docByCharge)).filter((row) => {
      const allocatedSum = row.allocations.reduce((s, a) => s + a.allocatedAmount, 0);
      return wantUnallocated ? row.amount > allocatedSum : row.amount <= allocatedSum;
    });

    return { data: filtered, nextCursor: null };
  }

  // Standard keyset path (no hasUnallocated filter).
  // Cursor is encoded as "<receivedAt_iso>|<id>" — the id tiebreak ensures that
  // rows sharing the same receivedAt timestamp are never dropped or duplicated
  // across pages (the compound (receivedAt DESC, id DESC) order is unique per row).
  let cursorWhere: Record<string, unknown> | undefined;
  if (opts.cursor) {
    const [cursorDate, cursorId] = opts.cursor.split("|");
    if (cursorDate && cursorId) {
      cursorWhere = {
        OR: [
          { receivedAt: { lt: new Date(cursorDate) } },
          { receivedAt: new Date(cursorDate), id: { lt: cursorId } },
        ],
      };
    }
  }

  const combinedWhere = cursorWhere ? { AND: [where, cursorWhere] } : where;

  const rows = await db.payment.findMany({
    where: combinedWhere,
    include: {
      party: { select: { displayName: true } },
      allocations: {
        orderBy: [{ allocatedAt: "desc" }],
        include: { charge: { select: { chargeNumber: true, id: true } } },
      },
    },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  // Determine if there's a next page by checking the extra row.
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const allocChargeIds = pageRows.flatMap((r) => r.allocations.map((a) => a.charge.id));
  const docByCharge = await findDocumentsByChargeIds(allocChargeIds);

  const mapped = pageRows.map((r) => mapRow(r, docByCharge));

  // Compute nextCursor from the last row in the page.
  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = `${last.receivedAt.toISOString()}|${last.id}`;
  }

  return { data: mapped, nextCursor };
}

/** Month-scoped header metrics for the payments v2 page (spec §4). */
export async function paymentsSummary(orgId: string, monthStart: Date, monthEnd: Date) {
  const db = getDb();
  const rows = await db.payment.findMany({
    where: { organizationId: orgId, receivedAt: { gte: monthStart, lt: monthEnd } },
    select: {
      status: true,
      gatewayStatus: true,
      amount: true,
      allocations: { select: { allocatedAmount: true } },
    },
  });
  let receivedTotal = 0;
  let unallocatedCount = 0;
  let pendingApprovalCount = 0;
  let inFlightFpxCount = 0;
  for (const r of rows) {
    if (r.status === "posted") {
      const amt = toNumber(r.amount);
      receivedTotal += amt;
      const allocated = r.allocations.reduce((s, a) => s + toNumber(a.allocatedAmount), 0);
      if (amt > allocated + 0.005) unallocatedCount += 1;
    } else if (r.status === "pending_approval") {
      if (r.gatewayStatus === "pending") inFlightFpxCount += 1;
      else pendingApprovalCount += 1;
    }
  }
  return { receivedTotal, unallocatedCount, pendingApprovalCount, inFlightFpxCount };
}

export async function findPaymentByNumber(orgId: string, paymentNumber: string) {
  const db = getDb();
  return db.payment.findFirst({ where: { organizationId: orgId, paymentNumber }, select: { id: true } });
}

/**
 * Spec2 R9: best-effort in-window duplicate-payment lookup for
 * recordAndAllocatePaymentService. Matches a recent SUCCESSFUL ("posted")
 * payment by the same payer+amount+method that overlaps at least one of the
 * given charge(s). Best-effort by design — NOT a uniqueness constraint;
 * identical payments outside the window are legitimate (e.g. next month's
 * rent) and must never be blocked. status:"posted" excludes
 * failed/void/refunded/pending_approval payments so a payment that never
 * successfully collected money (or was reversed) can never block a re-pay.
 */
export async function findRecentDuplicatePayment(
  orgId: string,
  k: { partyId: string; amount: number; paymentMethod: string; chargeIds: string[]; sinceMinutes: number },
): Promise<{ id: string } | null> {
  const db = getDb();
  const since = new Date(Date.now() - k.sinceMinutes * 60000);
  return db.payment.findFirst({
    where: {
      organizationId: orgId,
      partyId: k.partyId,
      // Round IDENTICALLY to how the amount is stored: Payment.amount is
      // numeric(12,2), and the store path (createPayment /
      // createPaymentWithAllocationsTx) hands Prisma a raw JS number for a
      // Decimal column, which Postgres rounds half-up on write (e.g. 1.005 ->
      // 1.01 — verified directly against local Postgres). A plain float
      // Math.round(amount*100)/100 (the previous approach, at the service
      // call site) does NOT agree with that for 3dp inputs
      // (Math.round(1.005*100)/100 === 1.00, a JS float artifact), so a query
      // built from a 3dp allocation amount (proration/percentage UIs can
      // emit these — allocatedAmount is z.string().min(1), uncapped decimal
      // places) silently missed the real stored duplicate row -> the guard
      // never fired -> a second payment posted -> double-collection.
      // Prisma.Decimal walks the same decimal-string + half-up pipeline
      // Postgres uses, so query-time rounding here always matches store-time
      // rounding, for any input value. Rounding mode is passed EXPLICITLY
      // (not the ambient Prisma.Decimal.rounding default) because that
      // default is global mutable state shared by every other Decimal user
      // in the codebase (commissions, renovation-claims, owner-billing, ...)
      // — pinning it here keeps this guard correct even if something
      // elsewhere calls Prisma.Decimal.set({ rounding: ... }).
      amount: new Prisma.Decimal(k.amount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      paymentMethod: k.paymentMethod,
      status: "posted",
      createdAt: { gte: since },
      allocations: { some: { chargeId: { in: k.chargeIds } } },
    },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function createPayment(params: {
  organizationId: string;
  paymentNumber: string;
  partyId: string;
  paymentType: string;
  paymentMethod: string;
  amount: number;
  currency: string;
  receivedAt: Date;
  referenceNote: string | null;
  externalReference: string | null;
}) {
  const db = getDb();
  return db.payment.create({
    data: {
      ...params,
      status: "posted",
    },
    select: { id: true },
  });
}

export async function findPaymentById(orgId: string, paymentId: string) {
  const db = getDb();
  return db.payment.findFirst({ where: { organizationId: orgId, id: paymentId }, select: { id: true, amount: true, status: true, referenceNote: true } });
}

/**
 * Fetch a payment's gatewayStatus (org-scoped, by id) for the in-flight-FPX guard
 * on the by-id admin mutation endpoints. A separate minimal projection — kept apart
 * from findPaymentById so the existing mutation services are untouched. Returns
 * null when the payment does not exist (the handler then falls through to the
 * service, which yields the canonical 404).
 */
export async function findPaymentGatewayStatus(orgId: string, paymentId: string) {
  const db = getDb();
  return db.payment.findFirst({ where: { organizationId: orgId, id: paymentId }, select: { id: true, gatewayStatus: true } });
}

export async function findChargeById(orgId: string, chargeId: string) {
  const db = getDb();
  return db.charge.findFirst({ where: { organizationId: orgId, id: chargeId }, select: { id: true, outstandingAmount: true, status: true } });
}

/**
 * Single allocation — B7 reroute (2026-07-04 spec): rides the SAME guarded
 * helper as the batch path (party-match, outstanding re-read + cap,
 * updatedAt-in-WHERE, chargeStatusForOutstanding). Signature change:
 * expectedPartyId in, `outstanding` pre-read OUT (re-read inside the tx).
 */
export async function allocatePaymentTx(params: {
  organizationId: string;
  paymentId: string;
  chargeId: string;
  allocatedAmount: number;
  expectedPartyId: string;
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const applied = await applyAllocationToChargeTx(
      tx, params.organizationId, params.chargeId, params.allocatedAmount, params.expectedPartyId,
    );
    if (applied.exceeded) throw new Error(`ALLOC_EXCEEDS_OUTSTANDING:${params.chargeId}`);
    const row = await tx.paymentAllocation.create({
      data: {
        organizationId: params.organizationId,
        paymentId: params.paymentId,
        chargeId: params.chargeId,
        allocatedAmount: params.allocatedAmount,
        allocatedAt: new Date(),
      },
      select: { id: true },
    });
    return { ...row, becamePaid: applied.becamePaid, chargeId: params.chargeId };
  });
}

// `updatePaymentStatus` lived here and is DELETED. It had zero callers —
// `updatePaymentStatusService` routes through `voidPaymentTx` instead — and it
// was three hazards in four lines: a free-string status with no allow-list, no
// audit row, and no optimistic check, on the Payment table. Its `payment.update`
// also carried no `select`, so Prisma named every column and it would 500 with
// P2022 against any schema missing a newly-added one.
//
// Deleted rather than fixed: unreachable code cannot be tested, and the one
// thing worse than an unguarded money mutator is an unguarded money mutator
// nobody notices is wired up.

import { withStaleCheck } from "../../lib/optimistic-update";
import { recordAudit } from "../../lib/audit";
import { chargeStatusForOutstanding } from "./payments.charge-status";
// Value import (not `import type`): findRecentDuplicatePayment needs
// Prisma.Decimal at runtime (Spec2 R9 rounding fix), in addition to the
// existing Prisma.TransactionClient type usage below.
import { Prisma } from "@kason/db";

/** Thrown inside a $transaction when an optimistic-concurrency check fails. */
export class StaleError extends Error {
  constructor(public chargeOrPaymentId: string) {
    super("Record changed since you loaded it");
    this.name = "StaleError";
  }
}
/** Thrown when a posted payment has already been allocated (re-allocate attempt). */
export class AlreadyAllocatedError extends Error {
  constructor() { super("Payment already allocated"); this.name = "AlreadyAllocatedError"; }
}
/** Thrown when an allocated charge does not belong to the payment's payer party. */
export class PartyMismatchError extends Error {
  constructor(public chargeId: string) { super("Charge belongs to a different party"); this.name = "PartyMismatchError"; }
}

export async function findPaymentForMutation(orgId: string, paymentId: string) {
  const db = getDb();
  return db.payment.findFirst({
    where: { organizationId: orgId, id: paymentId },
    select: { id: true, amount: true, status: true, partyId: true, idempotencyKey: true, updatedAt: true },
  });
}

export async function findPaymentByIdempotencyKeyAdmin(orgId: string, key: string) {
  const db = getDb();
  return db.payment.findFirst({ where: { organizationId: orgId, idempotencyKey: key }, select: { id: true } });
}

// Apply ONE allocation's effect to its charge inside an existing tx:
// re-read outstanding+updatedAt, assert the charge belongs to expectedPartyId,
// validate <= outstanding, decrement with updatedAt-in-WHERE (StaleError -> 409).
// Exported (was module-private): a later task also consumes this guarded rail.
export async function applyAllocationToChargeTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  chargeId: string,
  allocatedAmount: number,
  expectedPartyId: string,
) {
  const charge = await tx.charge.findFirst({
    where: { organizationId: orgId, id: chargeId },
    select: { id: true, partyId: true, amount: true, outstandingAmount: true, status: true, updatedAt: true },
  });
  if (!charge) throw new StaleError(chargeId);
  if (charge.partyId !== expectedPartyId) throw new PartyMismatchError(chargeId);
  if (charge.status === "void") throw new StaleError(chargeId);
  const outstanding = Number(charge.outstandingAmount.toString());
  if (allocatedAmount > outstanding + 0.005) {
    return { exceeded: true as const, chargeId, outstanding };
  }
  const newOutstanding = Math.max(0, outstanding - allocatedAmount);
  const newStatus = chargeStatusForOutstanding(newOutstanding, Number(charge.amount.toString()));
  const res = await withStaleCheck(() =>
    tx.charge.update({
      where: { id: chargeId, organizationId: orgId, updatedAt: charge.updatedAt },
      data: {
        outstandingAmount: newOutstanding,
        status: newStatus,
      },
      select: { id: true },
    }),
  );
  if (res === null) throw new StaleError(chargeId);
  // PART 3: report whether THIS application transitioned the charge TO "paid"
  // (it wasn't already paid before) so the caller can notify the owner exactly
  // once per payment-application event.
  const becamePaid = newStatus === "paid" && charge.status !== "paid";
  return { exceeded: false as const, chargeId, newOutstanding, becamePaid };
}

/**
 * Atomic record+allocate (spec B3): create the payment AND apply every
 * allocation in ONE transaction on the guarded rail. amount is Σ(lines) —
 * validated by the service. idempotencyKey is set AT CREATE, so the
 * @@unique(organizationId, idempotencyKey) covers the whole operation:
 * a replayed request never creates a second payment (P2002 → service replay).
 */
export async function createPaymentWithAllocationsTx(params: {
  organizationId: string;
  paymentNumber: string;
  partyId: string;
  paymentType: string;
  paymentMethod: string;
  amount: number;
  currency: string;
  receivedAt: Date;
  referenceNote: string | null;
  externalReference: string | null;
  idempotencyKey: string;
  attachmentKeys: string[];
  actorUserId: string;
  actorRole: string;
  allocations: { chargeId: string; allocatedAmount: number; prorateRatio: string | null }[];
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        organizationId: params.organizationId,
        paymentNumber: params.paymentNumber,
        partyId: params.partyId,
        paymentType: params.paymentType,
        paymentMethod: params.paymentMethod,
        amount: params.amount,
        currency: params.currency,
        receivedAt: params.receivedAt,
        referenceNote: params.referenceNote,
        externalReference: params.externalReference,
        status: "posted",
        idempotencyKey: params.idempotencyKey,
        attachmentKeys: params.attachmentKeys,
      },
      select: { id: true },
    });

    const created: { id: string; chargeId: string; allocatedAmount: number }[] = [];
    const paidChargeIds: string[] = [];
    const base = Date.now();
    for (let i = 0; i < params.allocations.length; i++) {
      const line = params.allocations[i];
      const applied = await applyAllocationToChargeTx(
        tx, params.organizationId, line.chargeId, line.allocatedAmount, params.partyId,
      );
      if (applied.exceeded) throw new Error(`ALLOC_EXCEEDS_OUTSTANDING:${line.chargeId}`);
      if (applied.becamePaid) paidChargeIds.push(line.chargeId);
      const row = await tx.paymentAllocation.create({
        data: {
          organizationId: params.organizationId,
          paymentId: payment.id,
          chargeId: line.chargeId,
          allocatedAmount: line.allocatedAmount,
          prorateRatio: line.prorateRatio,
          allocatedAt: new Date(base + i),
        },
        select: { id: true },
      });
      created.push({ id: row.id, chargeId: line.chargeId, allocatedAmount: line.allocatedAmount });
    }

    await recordAudit(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "payment.record_and_allocate",
      entityType: "Payment",
      entityId: payment.id,
      diff: { paymentNumber: params.paymentNumber, amount: params.amount, allocations: created },
    });

    return {
      paymentId: payment.id,
      allocations: created,
      paidChargeIds,
      allocatedChargeIds: created.map((c) => c.chargeId),
    };
  });
}

export async function allocatePaymentBatchTx(params: {
  organizationId: string;
  paymentId: string;
  payerPartyId: string;
  paymentAmount: number;
  idempotencyKey: string;
  actorUserId: string;
  actorRole: string;
  allocations: { chargeId: string; allocatedAmount: number; prorateRatio: string | null }[];
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    // Atomic compare-and-set: claim the payment for THIS idempotencyKey only if
    // it has none yet. updateMany lets us guard on `idempotencyKey: null` (a
    // plain `update` requires a unique WHERE). The @@unique([organizationId,
    // idempotencyKey]) backstops a concurrent claim of the SAME key on a
    // different payment (P2002 -> whole tx rolls back -> service decides).
    const claim = await tx.payment.updateMany({
      where: { id: params.paymentId, organizationId: params.organizationId, idempotencyKey: null },
      data: { idempotencyKey: params.idempotencyKey },
    });
    if (claim.count === 0) {
      const cur = await tx.payment.findFirst({
        where: { id: params.paymentId, organizationId: params.organizationId },
        select: { idempotencyKey: true },
      });
      if (cur?.idempotencyKey === params.idempotencyKey) return { replayed: true as const, allocations: [], paidChargeIds: [] as string[], allocatedChargeIds: [] as string[] };
      throw new AlreadyAllocatedError();
    }

    const sum = params.allocations.reduce((s, a) => s + a.allocatedAmount, 0);
    if (sum > params.paymentAmount + 0.005) throw new Error("ALLOC_EXCEEDS_PAYMENT");

    const created: { id: string; chargeId: string; allocatedAmount: number }[] = [];
    const paidChargeIds: string[] = []; // PART 3: charges that reached "paid" here
    const base = Date.now();
    for (let i = 0; i < params.allocations.length; i++) {
      const line = params.allocations[i];
      const applied = await applyAllocationToChargeTx(tx, params.organizationId, line.chargeId, line.allocatedAmount, params.payerPartyId);
      if (applied.exceeded) throw new Error(`ALLOC_EXCEEDS_OUTSTANDING:${line.chargeId}`);
      if (applied.becamePaid) paidChargeIds.push(line.chargeId);
      const row = await tx.paymentAllocation.create({
        data: {
          organizationId: params.organizationId,
          paymentId: params.paymentId,
          chargeId: line.chargeId,
          allocatedAmount: line.allocatedAmount,
          prorateRatio: line.prorateRatio,
          allocatedAt: new Date(base + i), // distinct per line -> no @@unique self-collision
        },
        select: { id: true },
      });
      created.push({ id: row.id, chargeId: line.chargeId, allocatedAmount: line.allocatedAmount });
    }

    await recordAudit(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "payment.allocation.batch_create",
      entityType: "Payment",
      entityId: params.paymentId,
      diff: { allocations: created },
    });

    // I-1: paidChargeIds = charges that reached "paid" (drives owner notify);
    // allocatedChargeIds = EVERY charge this batch touched (partial OR full),
    // which drives the owner-ledger re-sync so a partial payment refreshes the
    // owner's "collected" projection immediately.
    return { replayed: false as const, allocations: created, paidChargeIds, allocatedChargeIds: created.map((c) => c.chargeId) };
  });
}

// Restore one charge by the given amount (used by void + single reverse).
// If the charge is void, it is left untouched (a voided charge stays void).
// Uses updatedAt-in-WHERE (StaleError on conflict).
// Exported (was module-private): the owner-remittance module's Task 9
// (owner-receivable-offset reversal) also consumes this guarded rail.
export async function restoreChargeTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  chargeId: string,
  amount: number,
) {
  const charge = await tx.charge.findFirst({
    where: { organizationId: orgId, id: chargeId },
    select: { id: true, amount: true, outstandingAmount: true, status: true, updatedAt: true },
  });
  if (!charge) throw new StaleError(chargeId);
  if (charge.status === "void") return; // voided charge stays void; nothing to restore
  const chargeAmount = Number(charge.amount.toString());
  const newOutstanding = Math.min(chargeAmount, Number(charge.outstandingAmount.toString()) + amount);
  const res = await withStaleCheck(() =>
    tx.charge.update({
      where: { id: chargeId, organizationId: orgId, updatedAt: charge.updatedAt },
      data: {
        outstandingAmount: newOutstanding,
        status: chargeStatusForOutstanding(newOutstanding, chargeAmount),
      },
      select: { id: true },
    }),
  );
  if (res === null) throw new StaleError(chargeId);
}

export async function voidPaymentTx(params: {
  organizationId: string;
  paymentId: string;
  status: "void" | "refunded";
  referenceNote: string | null;
  actorUserId: string;
  actorRole: string;
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { organizationId: params.organizationId, id: params.paymentId },
      select: { id: true, status: true, updatedAt: true },
    });
    if (!payment) return { notFound: true as const };
    if (payment.status === "void") return { alreadyVoid: true as const };

    // Reverse applied allocations only if the payment was posted.
    const wasApplied = payment.status === "posted";
    const allocations = await tx.paymentAllocation.findMany({
      where: { organizationId: params.organizationId, paymentId: params.paymentId },
      select: { chargeId: true, allocatedAmount: true },
    });
    if (wasApplied) {
      const allocRows = await tx.paymentAllocation.findMany({
        where: { organizationId: params.organizationId, paymentId: params.paymentId },
        select: { id: true, chargeId: true, allocatedAmount: true },
      });
      // Net any prior partial reversals (Task-4 reverse route) already written
      // against these allocations — one grouped query (no N+1). Voiding must
      // reverse only the REMAINING effective-allocated balance; reversing the
      // full allocatedAmount on top of a prior partial reversal double-counts,
      // pushing Σreversals past the allocated total and effectiveAllocated
      // negative (wedging the allocation).
      const already = await sumReversalsForAllocations(
        tx,
        params.organizationId,
        allocRows.map((a) => a.id),
      );
      for (const a of allocRows) {
        const amount = round2(Number(a.allocatedAmount.toString()) - (already.get(a.id) ?? 0));
        if (amount <= 0) continue; // fully reversed already — nothing to reverse/restore
        await restoreChargeTx(tx, params.organizationId, a.chargeId, amount);
        // Append-only reversal fact for the payment-void path (R5). Deterministic
        // key so a re-void never double-writes; create-only, swallow ONLY the
        // unique clash (P2002) — a genuine FK/connection error must propagate.
        await tx.paymentAllocationReversal
          .create({
            data: {
              organizationId: params.organizationId,
              originalAllocationId: a.id,
              amount,
              reason: `payment ${params.status}`,
              reversedById: params.actorUserId,
              idempotencyKey: `voidpay:${params.paymentId}:${a.id}`,
            },
          })
          .catch((e) => {
            // P2002 on re-void — the row already exists; anything else is real.
            if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
          });
      }
    }

    const res = await withStaleCheck(() =>
      tx.payment.update({
        where: {
          id: params.paymentId,
          organizationId: params.organizationId,
          updatedAt: payment.updatedAt,
        },
        data: { status: params.status, referenceNote: params.referenceNote },
        select: { id: true },
      }),
    );
    if (res === null) throw new StaleError(params.paymentId);

    await recordAudit(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: params.status === "void" ? "payment.voided" : "payment.refunded",
      entityType: "Payment",
      entityId: params.paymentId,
      diff: { reversed: wasApplied, allocations: allocations.length },
    });
    // Accounting docs: the caller re-derives document settlement post-commit for
    // the charges whose outstanding this void restored.
    return { ok: true as const, chargeIds: wasApplied ? allocations.map((a) => a.chargeId) : [] };
  });
}

// Half-up 2dp rounding for money math (mirrors credit-apply.service.ts:27-29).
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Σ(PaymentAllocationReversal.amount) grouped per originalAllocationId, single
// grouped query (no N+1). Consumed by reverse (effective-allocated) + Task 5.
export async function sumReversalsForAllocations(
  tx: Prisma.TransactionClient,
  orgId: string,
  allocationIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (allocationIds.length === 0) return out;
  const rows = await tx.paymentAllocationReversal.groupBy({
    by: ["originalAllocationId"],
    where: { organizationId: orgId, originalAllocationId: { in: allocationIds } },
    _sum: { amount: true },
  });
  for (const r of rows) out.set(r.originalAllocationId, Number((r._sum.amount ?? 0).toString()));
  return out;
}

type ReverseAllocationParams = {
  organizationId: string;
  paymentId: string;
  allocationId: string;
  reason: string;
  idempotencyKey: string;
  amount: number | null;
  actorUserId: string;
  actorRole: string;
};

// Append-only allocation reversal (R4), running INSIDE a caller-provided transaction.
// Extracted from reverseAllocationTx (below) so callers that must reverse AND do more
// work atomically — the bills-grid re-Bill supersede reverses each partial payment in
// the SAME $transaction as the reissue — share one rollback boundary (a failure
// anywhere un-does the reversal too, never orphaning it). Writes a
// PaymentAllocationReversal row; the original PaymentAllocation is NEVER mutated or
// deleted. Supports a partial `amount`, is idempotent on (organizationId,
// idempotencyKey), and rejects an amount that exceeds the remaining
// effective-allocated balance (over-cap / non-positive → `{ exceeded }`, no write).
export async function reverseAllocationInTx(tx: Prisma.TransactionClient, params: ReverseAllocationParams) {
  // Idempotent replay: an existing reversal for this key returns unchanged.
  const prior = await tx.paymentAllocationReversal.findFirst({
    where: { organizationId: params.organizationId, idempotencyKey: params.idempotencyKey },
    select: { id: true, originalAllocationId: true, amount: true },
  });
  const alloc = await tx.paymentAllocation.findFirst({
    where: { organizationId: params.organizationId, id: params.allocationId, paymentId: params.paymentId },
    select: { id: true, chargeId: true, allocatedAmount: true, payment: { select: { status: true } } },
  });
  if (!alloc) return { notFound: true as const };
  if (prior) return { ok: true as const, chargeId: alloc.chargeId, reversalId: prior.id, replayed: true as const };

  const allocated = Number(alloc.allocatedAmount.toString());
  const already = (await sumReversalsForAllocations(tx, params.organizationId, [alloc.id])).get(alloc.id) ?? 0;
  const effectiveAllocated = round2(allocated - already);
  const amount = params.amount ?? effectiveAllocated;
  // Bound-check BEFORE writing: reject over-cap or non-positive.
  if (amount > effectiveAllocated + 0.005 || amount <= 0) {
    return { exceeded: true as const, effectiveAllocated };
  }
  // Append-only: write the reversal row; NEVER mutate/delete the PaymentAllocation.
  const reversal = await tx.paymentAllocationReversal.create({
    data: {
      organizationId: params.organizationId,
      originalAllocationId: alloc.id,
      amount,
      reason: params.reason,
      reversedById: params.actorUserId,
      idempotencyKey: params.idempotencyKey,
    },
    select: { id: true },
  });
  // Keep the cached Charge.outstandingAmount in sync (only if the payment was applied).
  if (alloc.payment.status === "posted") {
    await restoreChargeTx(tx, params.organizationId, alloc.chargeId, amount);
  }
  await recordAudit(tx, {
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    action: "payment.allocation.reverse",
    entityType: "PaymentAllocation",
    entityId: params.allocationId,
    diff: { chargeId: alloc.chargeId, amount, reason: params.reason },
  });
  return {
    ok: true as const,
    chargeId: alloc.chargeId,
    reversalId: reversal.id,
    effectiveAllocated: round2(effectiveAllocated - amount),
  };
}

// Own-transaction wrapper (unchanged public contract): opens a $transaction and
// delegates the whole body to reverseAllocationInTx.
export async function reverseAllocationTx(params: ReverseAllocationParams) {
  const db = getDb();
  return db.$transaction((tx) => reverseAllocationInTx(tx, params));
}

/**
 * Refuse a tenant-submitted transfer slip. The mirror of postPaymentTx: same
 * `pending_approval`-only precondition and same stale-check, opposite outcome.
 *
 * Charges are deliberately NOT touched. A pending payment settled nothing in
 * the first place (submitMultiPaymentTx creates the Payment and its allocations
 * but leaves `outstandingAmount` alone), so there is nothing to give back —
 * "restoring" the charge here would CREDIT money that never arrived. This is
 * the whole reason rejection is a separate path from void, which does have to
 * unwind a real settlement.
 *
 * The allocation rows stay too, inert. Cash readers filter on status "posted"
 * (packages/shared/src/billing/cash-allocation.ts), so a rejected row counts
 * nowhere, and keeping it preserves what the tenant actually claimed — which is
 * the evidence trail if they dispute the refusal. Same treatment as
 * "expired"/"failed".
 */
export async function rejectPaymentTx(params: {
  organizationId: string;
  paymentId: string;
  reason: string;
  actorUserId: string;
  actorRole: string;
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { organizationId: params.organizationId, id: params.paymentId },
      select: { id: true, status: true, partyId: true, amount: true, paymentNumber: true, updatedAt: true },
    });
    if (!payment) return { notFound: true as const };
    // Only an unverified payment can be refused. A "posted" one is money the org
    // already took — unwinding that is void/refund, which restores charges and
    // nets reversals; silently routing it here would erase a receivable.
    if (payment.status !== "pending_approval") return { badStatus: true as const, status: payment.status };

    const res = await withStaleCheck(() =>
      tx.payment.update({
        where: { id: params.paymentId, organizationId: params.organizationId, updatedAt: payment.updatedAt },
        data: {
          status: "rejected",
          rejectionReason: params.reason,
          reviewedAt: new Date(),
          reviewedById: params.actorUserId,
        },
        select: { id: true },
      }),
    );
    if (res === null) throw new StaleError(params.paymentId);

    const allocations = await tx.paymentAllocation.findMany({
      where: { organizationId: params.organizationId, paymentId: params.paymentId },
      select: { chargeId: true },
    });

    await recordAudit(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "payment.rejected",
      entityType: "Payment",
      entityId: params.paymentId,
      diff: { reason: params.reason, claimedAmount: payment.amount.toString(), allocations: allocations.length },
    });

    return {
      ok: true as const,
      partyId: payment.partyId,
      paymentNumber: payment.paymentNumber,
      chargeIds: allocations.map((a) => a.chargeId),
    };
  });
}

export async function postPaymentTx(params: {
  organizationId: string;
  paymentId: string;
  actorUserId: string;
  actorRole: string;
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { organizationId: params.organizationId, id: params.paymentId },
      select: { id: true, status: true, amount: true, partyId: true, updatedAt: true },
    });
    if (!payment) return { notFound: true as const };
    if (payment.status !== "pending_approval") return { badStatus: true as const, status: payment.status };

    const allocations = await tx.paymentAllocation.findMany({
      where: { organizationId: params.organizationId, paymentId: params.paymentId },
      select: { id: true, chargeId: true, allocatedAmount: true },
    });

    // Payment-level invariant re-checked at apply time.
    const allocSum = allocations.reduce((s, a) => s + Number(a.allocatedAmount.toString()), 0);
    if (allocSum > Number(payment.amount.toString()) + 0.005) throw new Error("ALLOC_EXCEEDS_PAYMENT");

    const paidChargeIds: string[] = []; // PART 3: charges that reached "paid" here
    for (const a of allocations) {
      const applied = await applyAllocationToChargeTx(tx, params.organizationId, a.chargeId, Number(a.allocatedAmount.toString()), payment.partyId);
      if (applied.exceeded) throw new Error(`ALLOC_EXCEEDS_OUTSTANDING:${a.chargeId}`);
      if (applied.becamePaid) paidChargeIds.push(a.chargeId);
    }

    const res = await withStaleCheck(() =>
      tx.payment.update({
        where: { id: params.paymentId, organizationId: params.organizationId, updatedAt: payment.updatedAt },
        data: { status: "posted" },
        select: { id: true },
      }),
    );
    if (res === null) throw new StaleError(params.paymentId);

    await recordAudit(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "payment.posted",
      entityType: "Payment",
      entityId: params.paymentId,
      diff: { appliedAllocations: allocations.length },
    });
    // I-1: paidChargeIds drives owner notify (fully-paid only); allocatedChargeIds
    // = every charge this post applied an allocation to (partial OR full), driving
    // the owner-ledger re-sync so a partial settlement refreshes collected at once.
    // partyId is carried out so the caller's post-commit follow-ons (graduation +
    // receipt) know whose document to mint without re-reading the payment.
    return { ok: true as const, partyId: payment.partyId, paidChargeIds, allocatedChargeIds: allocations.map((a) => a.chargeId) };
  });
}

// ── In-flight FPX ops (admin) ───────────────────────────────────────────────
// The default admin listing HIDES gatewayStatus "pending" FPX rows (so an admin
// can't prematurely post one). That also hides genuinely STUCK attempts a tenant
// never returned from. These two helpers give an admin a dedicated view + a
// manual cancel for exactly those rows — never touching charges (a pending FPX
// payment never settled any).

/**
 * List the org's in-flight FPX payments: any known FPX provider, gatewayStatus
 * "pending", status "pending_approval". Oldest first (most-stuck at the top).
 * Returns payer name, amount, and an age in whole minutes for the admin surface.
 */
export async function listInFlightFpxPayments(orgId: string) {
  const db = getDb();
  const rows = await db.payment.findMany({
    where: { organizationId: orgId, provider: { in: [...FPX_PROVIDER_IDS] }, gatewayStatus: "pending", status: "pending_approval" },
    select: {
      id: true,
      paymentNumber: true,
      amount: true,
      currency: true,
      createdAt: true,
      party: { select: { displayName: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    paymentNumber: r.paymentNumber,
    partyName: r.party.displayName,
    amount: toNumber(r.amount),
    currency: r.currency,
    createdAt: r.createdAt.toISOString(),
    ageMinutes: Math.max(0, Math.floor((now - r.createdAt.getTime()) / 60_000)),
  }));
}

/**
 * Admin cancel of a single STUCK in-flight FPX payment → status/gatewayStatus
 * "expired". Rejects anything that is NOT in-flight FPX (settled/posted/failed/
 * manual), so collected money can never be reversed via this path. Charges are
 * UNTOUCHED (a pending FPX payment never settled any). updatedAt-in-WHERE guards
 * a concurrent gateway callback that settles the SAME row (StaleError → 409).
 */
export async function cancelInFlightFpxPaymentTx(params: {
  organizationId: string;
  paymentId: string;
  actorUserId: string;
  actorRole: string;
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { organizationId: params.organizationId, id: params.paymentId },
      select: { id: true, status: true, gatewayStatus: true, provider: true, updatedAt: true },
    });
    if (!payment) return { notFound: true as const };
    if (!isFpxProviderId(payment.provider) || payment.gatewayStatus !== "pending" || payment.status !== "pending_approval") {
      return { notInFlight: true as const, status: payment.status, gatewayStatus: payment.gatewayStatus };
    }

    const res = await withStaleCheck(() =>
      tx.payment.update({
        where: { id: params.paymentId, organizationId: params.organizationId, updatedAt: payment.updatedAt },
        // gatewayStatus "cancelled", NOT "expired" — this is the discriminator
        // the FPX callback path reads to tell a HUMAN's decision apart from our
        // automatic 30-minute sweep (which writes "expired"). A late signed
        // success revives a swept row and settles it, but parks a cancelled one
        // for review rather than overriding the person who cancelled it.
        //
        // Safe to change: every gatewayStatus reader keys on "pending",
        // "success" or NULL — none matches on "expired" — so "cancelled" behaves
        // identically everywhere else (admin listing, in-flight panel, summary).
        data: { status: "expired", gatewayStatus: "cancelled" },
        select: { id: true },
      }),
    );
    if (res === null) throw new StaleError(params.paymentId);

    await recordAudit(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "payment.fpx_cancelled",
      entityType: "Payment",
      entityId: params.paymentId,
      diff: { from: { status: "pending_approval", gatewayStatus: "pending" }, to: { status: "expired", gatewayStatus: "cancelled" } },
    });
    return { ok: true as const };
  });
}
