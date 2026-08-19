/**
 * CN credit application (spec §4.3 B4) — REUSES the payment rails: applying
 * credit mints a Payment(method 'credit_note', status 'posted') + normal
 * PaymentAllocation, so outstanding math, settle logic, and ledger-sync hooks
 * stay single-sourced. CreditApplication links payment → CN for balance
 * derivation: available = creditAmount − Σ(linked payments).
 *
 * Idempotency: check-first on Payment.idempotencyKey `cnapply:<cnId>:<chargeId>`,
 * serialized by a `SELECT ... FOR UPDATE` row lock on the CN so two concurrent
 * appliers (auto or manual) against the SAME CN never both read a stale
 * available balance (spec invariant: spendable NEVER exceeds creditAmount —
 * see lockCreditNoteAndRecomputeAvailable). The charge decrement additionally
 * carries an updatedAt-in-WHERE guard (mirrors payments.repository.ts) so a
 * genuinely concurrent writer on the CHARGE aborts this application instead of
 * clobbering it. The auto (posting-tx) path lets that abort propagate and
 * roll back the whole posting; the manual endpoint catches it as a 409, along
 * with a defense-in-depth P2002 catch on the Payment unique key.
 */
import { getDb, Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { chargeStatusForOutstanding } from "../payments/payments.charge-status";
import { refreshDocumentStatusForCharges } from "./status.service";
import { syncOwnerLedgerForCharges } from "../owner-ledger/owner-ledger.sync-hook";
import { withStaleCheck } from "../../lib/optimistic-update";
import { StaleError } from "../payments/payments.repository";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Row-lock the CN (SELECT ... FOR UPDATE) then re-read Σ(applications) for it
 * UNDER the lock and recompute available credit. Concurrent appliers against
 * the SAME CN serialize on this row lock — the loser re-reads the reduced
 * balance instead of racing off a stale snapshot (spec invariant: spendable
 * NEVER exceeds creditAmount).
 */
export async function lockCreditNoteAndRecomputeAvailable(
  tx: Prisma.TransactionClient,
  organizationId: string,
  cnId: string,
  creditAmount: number,
): Promise<number> {
  await tx.$queryRaw`SELECT id FROM "BillingDocument" WHERE id = ${cnId}::uuid AND "organizationId" = ${organizationId}::uuid FOR UPDATE`;
  const applied = await appliedByCreditNote(tx, organizationId, [cnId]);
  return round2(creditAmount - (applied.get(cnId) ?? 0));
}

/** Apply one CN's credit to one charge inside an existing tx. Returns applied amount + the charge's post-update updatedAt (unchanged when nothing applied). */
async function applyOneTx(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    cn: { id: string; documentNumber: string; partyId: string };
    charge: { id: string; chargeNumber: string; partyId: string; amount: number; updatedAt: Date };
    outstanding: number;
    available: number;
    actorUserId: string;
  },
): Promise<{ applied: number; updatedAt: Date }> {
  const apply = round2(Math.min(params.available, params.outstanding));
  if (apply <= 0) return { applied: 0, updatedAt: params.charge.updatedAt };
  const idemKey = `cnapply:${params.cn.id}:${params.charge.id}`;
  const existing = await tx.payment.findFirst({
    where: { organizationId: params.organizationId, idempotencyKey: idemKey },
    select: { id: true },
  });
  if (existing) return { applied: 0, updatedAt: params.charge.updatedAt }; // already applied (re-run) — never double-apply

  const payment = await tx.payment.create({
    data: {
      organizationId: params.organizationId,
      paymentNumber: `CNA-${params.cn.documentNumber}-${params.charge.chargeNumber}`,
      partyId: params.charge.partyId,
      paymentType: "credit_application",
      paymentMethod: "credit_note",
      status: "posted",
      amount: apply,
      currency: "MYR",
      receivedAt: new Date(),
      referenceNote: `Credit applied — ${params.cn.documentNumber}`,
      idempotencyKey: idemKey,
    },
    select: { id: true },
  });
  await tx.paymentAllocation.create({
    data: {
      organizationId: params.organizationId,
      paymentId: payment.id,
      chargeId: params.charge.id,
      allocatedAmount: apply,
      allocatedAt: new Date(),
    },
  });
  const newOutstanding = round2(params.outstanding - apply);
  // updatedAt-in-WHERE guard (mirrors payments.repository.ts's
  // applyAllocationToChargeTx) — a concurrent writer that changed this charge
  // since we read `outstanding` aborts this application rather than silently
  // clobbering it. The posting-tx auto path re-reads charges in-tx, so
  // staleness here means a genuine concurrent writer: abort is correct.
  const updateRes = await withStaleCheck(() =>
    tx.charge.update({
      where: { id: params.charge.id, organizationId: params.organizationId, updatedAt: params.charge.updatedAt },
      data: {
        outstandingAmount: newOutstanding,
        status: chargeStatusForOutstanding(newOutstanding, params.charge.amount),
      },
      select: { updatedAt: true },
    }),
  );
  if (updateRes === null) throw new StaleError(params.charge.id);
  await tx.creditApplication.create({
    data: {
      organizationId: params.organizationId,
      creditDocumentId: params.cn.id,
      paymentId: payment.id,
      appliedById: params.actorUserId,
    },
  });
  await tx.chargeEvent.create({
    data: {
      organizationId: params.organizationId,
      chargeId: params.charge.id,
      eventType: "credit_applied",
      eventAt: new Date(),
      actorUserId: params.actorUserId,
      payloadJson: {
        creditNoteId: params.cn.id,
        creditNoteNumber: params.cn.documentNumber,
        amount: apply,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  return { applied: apply, updatedAt: updateRes.updatedAt };
}

/** Σ(applied) per CN, derived from CreditApplication → Payment.amount. */
async function appliedByCreditNote(
  tx: Prisma.TransactionClient,
  organizationId: string,
  creditDocumentIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (creditDocumentIds.length === 0) return out;
  const apps = await tx.creditApplication.findMany({
    where: { organizationId, creditDocumentId: { in: creditDocumentIds } },
    select: { creditDocumentId: true, paymentId: true },
  });
  if (apps.length === 0) return out;
  const payments = await tx.payment.findMany({
    where: { id: { in: apps.map((a) => a.paymentId) } },
    select: { id: true, amount: true },
  });
  const amountById = new Map(payments.map((p) => [p.id, Number(p.amount.toString())]));
  for (const a of apps) {
    out.set(a.creditDocumentId, round2((out.get(a.creditDocumentId) ?? 0) + (amountById.get(a.paymentId) ?? 0)));
  }
  return out;
}

/**
 * Auto-apply open CN credit for a tenancy to freshly-posted charges, FIFO by
 * issuedAt, inside the POSTING transaction (idempotent under the posting's own
 * guards + the check-first idempotency key). Partial applications are fine.
 * Returns the ids of charges that received at least one application this run,
 * so the caller can refresh their documents' settlement status post-commit.
 */
export async function autoApplyOpenCredits(
  tx: Prisma.TransactionClient,
  organizationId: string,
  tenancyId: string,
  newChargeIds: string[],
  actorUserId: string,
): Promise<string[]> {
  if (newChargeIds.length === 0) return [];
  const cns = await tx.billingDocument.findMany({
    where: {
      organizationId,
      docType: "credit_note",
      counterpartyType: "tenant",
      tenancyId,
      creditAmount: { gt: 0 },
    },
    orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
    select: { id: true, documentNumber: true, partyId: true, creditAmount: true },
  });
  if (cns.length === 0) return [];

  const charges = await tx.charge.findMany({
    where: {
      organizationId,
      id: { in: newChargeIds },
      status: { in: ["posted", "partially_paid"] },
      outstandingAmount: { gt: 0 },
    },
    orderBy: { dueDate: "asc" },
    select: { id: true, chargeNumber: true, partyId: true, amount: true, outstandingAmount: true, updatedAt: true },
  });
  if (charges.length === 0) return [];

  // Track outstanding + updatedAt locally — an earlier CN in the FIFO may
  // partially consume a charge (and bump its updatedAt) before a later CN
  // sees it.
  const outstandingById = new Map(charges.map((c) => [c.id, Number(c.outstandingAmount.toString())]));
  const updatedAtById = new Map(charges.map((c) => [c.id, c.updatedAt]));
  const appliedChargeIds = new Set<string>();

  for (const cn of cns) {
    // Row-lock the CN + re-read its applied balance UNDER the lock (Finding 1):
    // serializes concurrent appliers (auto + manual) against this exact CN.
    let available = await lockCreditNoteAndRecomputeAvailable(tx, organizationId, cn.id, Number(cn.creditAmount!.toString()));
    if (available <= 0) continue;
    for (const charge of charges) {
      if (available <= 0) break;
      if (charge.partyId !== cn.partyId) continue; // credit is the payer's, never cross-party
      const outstanding = outstandingById.get(charge.id) ?? 0;
      if (outstanding <= 0) continue;
      const { applied: appliedNow, updatedAt: nextUpdatedAt } = await applyOneTx(tx, {
        organizationId,
        cn: { id: cn.id, documentNumber: cn.documentNumber, partyId: cn.partyId },
        charge: {
          id: charge.id,
          chargeNumber: charge.chargeNumber,
          partyId: charge.partyId,
          amount: Number(charge.amount.toString()),
          updatedAt: updatedAtById.get(charge.id)!,
        },
        outstanding,
        available,
        actorUserId,
      });
      if (appliedNow > 0) {
        appliedChargeIds.add(charge.id);
        updatedAtById.set(charge.id, nextUpdatedAt);
      }
      available = round2(available - appliedNow);
      outstandingById.set(charge.id, round2(outstanding - appliedNow));
    }
  }
  return [...appliedChargeIds];
}

/**
 * Unapplied ("spendable") balance per credit note — `creditAmount − Σ(applied)`,
 * the SAME derivation the appliers enforce, so a displayed figure can never
 * disagree with what an apply call would actually spend.
 *
 * Exported because two surfaces need it and must not each re-derive it: the
 * tenant portal (so a tenant can see the voucher they hold, and watch it being
 * consumed) and the admin document view. Notes with no spendable amount are
 * omitted from the map rather than mapped to 0 — callers treat "absent" as
 * "nothing to show", which is the common case.
 *
 * Clamped at 0: a note can never show negative remaining credit, and the
 * appliers' own invariant is that spendable never exceeds creditAmount.
 */
export async function remainingCreditByNote(
  db: Prisma.TransactionClient,
  organizationId: string,
  notes: { id: string; creditAmount: number }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const spendable = notes.filter((n) => n.creditAmount > 0);
  if (spendable.length === 0) return out;
  const applied = await appliedByCreditNote(db, organizationId, spendable.map((n) => n.id));
  for (const note of spendable) {
    const remaining = round2(note.creditAmount - (applied.get(note.id) ?? 0));
    if (remaining > 0) out.set(note.id, remaining);
  }
  return out;
}

/**
 * Offset ONE just-minted credit note against its party's open receivables,
 * oldest due date first, inside the minting transaction.
 *
 * ── The bug this closes ──────────────────────────────────────────────────────
 * A credit note raised against an ALREADY-PAID charge reduces that charge's
 * outstanding by nothing (charge-adjustment.service.ts caps the reduction at the
 * outstanding, correctly) and routes the whole amount to `creditAmount` — a
 * spendable balance. Nothing then spent it. `autoApplyOpenCredits` only fires
 * from the meter posting path against charges created in THAT run, so credit
 * minted afterwards sat on the note indefinitely, invisible: the invoice showed
 * "Adjusted 600 / Paid 475 / Balance 175", the tenant owed 175 by the ledger and
 * 125 in substance, and the 50 difference existed only inside a CN nobody read.
 *
 * ── Why offset rather than show a negative ───────────────────────────────────
 * Once the customer has paid, a credit note makes KAEN owe THEM — a credit
 * balance on their account, a liability. It is not a negative receivable, so it
 * does not belong in `outstandingAmount` as a minus. Standard AR practice is to
 * contra it against that customer's other open items first and only refund (or
 * carry forward) what is left. Offsetting also fixes every balance in the system
 * at once, because applying credit mints a real Payment + allocation and
 * decrements `outstandingAmount` — which is the single source the invoice
 * balance, the tenant portal's netBalance, the settlement pills and the bills
 * grid all read.
 *
 * ── Scope, deliberately narrow ───────────────────────────────────────────────
 * Applies ONLY the note passed in, never other open notes for the same party.
 * `autoApplyOpenCredits` sweeps every open CN because a NEW receivable should
 * draw down whatever credit exists; minting one small note must not cascade into
 * spending unrelated credit the admin never mentioned.
 *
 * Returns the ids of charges that received an application, so the caller can
 * refresh their documents' settlement status post-commit.
 */
export async function offsetCreditNoteAgainstOpenCharges(
  tx: Prisma.TransactionClient,
  organizationId: string,
  cn: { id: string; documentNumber: string; partyId: string; creditAmount: number },
  actorUserId: string,
): Promise<string[]> {
  if (cn.creditAmount <= 0) return [];
  // Row-lock the note and recompute under the lock, exactly as the auto and
  // manual appliers do — this runs inside the mint tx, but a concurrent applier
  // against the same note must still serialize here.
  let available = await lockCreditNoteAndRecomputeAvailable(tx, organizationId, cn.id, cn.creditAmount);
  if (available <= 0) return [];

  const charges = await tx.charge.findMany({
    where: {
      organizationId,
      partyId: cn.partyId, // credit is the payer's — never crosses party
      status: { in: ["posted", "partially_paid"] },
      outstandingAmount: { gt: 0 },
    },
    // Oldest debt first: the AR convention, and it makes the outcome independent
    // of which invoice happened to trigger the note.
    orderBy: [{ dueDate: "asc" }, { chargeNumber: "asc" }],
    select: { id: true, chargeNumber: true, partyId: true, amount: true, outstandingAmount: true, updatedAt: true },
  });
  if (charges.length === 0) return [];

  const appliedChargeIds: string[] = [];
  for (const charge of charges) {
    if (available <= 0) break;
    const { applied } = await applyOneTx(tx, {
      organizationId,
      cn: { id: cn.id, documentNumber: cn.documentNumber, partyId: cn.partyId },
      charge: {
        id: charge.id,
        chargeNumber: charge.chargeNumber,
        partyId: charge.partyId,
        amount: Number(charge.amount.toString()),
        updatedAt: charge.updatedAt,
      },
      outstanding: Number(charge.outstandingAmount.toString()),
      available,
      actorUserId,
    });
    if (applied > 0) appliedChargeIds.push(charge.id);
    available = round2(available - applied);
  }
  return appliedChargeIds;
}

type ApplySession = { orgId: string; userId: string; role: string };

/**
 * Manual "Apply credit" escape hatch (admin): apply a specific amount of a CN's
 * open credit to a specific outstanding charge. Own tx + post-commit hooks.
 */
export async function applyCreditManuallyService(
  session: ApplySession,
  creditDocumentId: string,
  input: { chargeId: string; amount: string },
): Promise<
  | { ok: true; status: 200; data: { paymentId: string; applied: string } }
  | { ok: false; status: number; error: string }
> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false as const, status: 400, error: "AMOUNT_INVALID" };
  }
  const db = getDb();
  let paymentId: string | null = null;
  let result: { ok: true; status: 200; data: { paymentId: string; applied: string } } | { ok: false; status: number; error: string };
  try {
    result = await db.$transaction(async (tx) => {
      const cn = await tx.billingDocument.findFirst({
        where: { id: creditDocumentId, organizationId: session.orgId, docType: "credit_note" },
        select: { id: true, documentNumber: true, partyId: true, creditAmount: true },
      });
      if (!cn) return { ok: false as const, status: 404, error: "CREDIT_NOTE_NOT_FOUND" };
      if (cn.creditAmount === null || Number(cn.creditAmount.toString()) <= 0) {
        return { ok: false as const, status: 400, error: "NO_SPENDABLE_CREDIT" };
      }
      // Row-lock the CN + re-read its applied balance UNDER the lock (Finding
      // 1) — serializes this call against any other concurrent applier (auto
      // or manual) touching the SAME CN.
      const available = await lockCreditNoteAndRecomputeAvailable(tx, session.orgId, cn.id, Number(cn.creditAmount.toString()));
      if (amount > available + 0.005) {
        return { ok: false as const, status: 400, error: "AMOUNT_EXCEEDS_AVAILABLE_CREDIT" };
      }
      const charge = await tx.charge.findFirst({
        where: { id: input.chargeId, organizationId: session.orgId },
        select: { id: true, chargeNumber: true, partyId: true, status: true, amount: true, outstandingAmount: true, updatedAt: true },
      });
      if (!charge) return { ok: false as const, status: 404, error: "CHARGE_NOT_FOUND" };
      if (!["posted", "partially_paid"].includes(charge.status)) {
        return { ok: false as const, status: 400, error: "CHARGE_NOT_PAYABLE" };
      }
      if (charge.partyId !== cn.partyId) {
        return { ok: false as const, status: 400, error: "PARTY_MISMATCH" };
      }
      const outstanding = Number(charge.outstandingAmount.toString());
      if (amount > outstanding + 0.005) {
        return { ok: false as const, status: 400, error: "AMOUNT_EXCEEDS_OUTSTANDING" };
      }
      const { applied: appliedNow } = await applyOneTx(tx, {
        organizationId: session.orgId,
        cn: { id: cn.id, documentNumber: cn.documentNumber, partyId: cn.partyId },
        charge: {
          id: charge.id,
          chargeNumber: charge.chargeNumber,
          partyId: charge.partyId,
          amount: Number(charge.amount.toString()),
          updatedAt: charge.updatedAt,
        },
        outstanding,
        available: amount,
        actorUserId: session.userId,
      });
      if (appliedNow <= 0) return { ok: false as const, status: 409, error: "ALREADY_APPLIED" };
      const payment = await tx.payment.findFirst({
        where: { organizationId: session.orgId, idempotencyKey: `cnapply:${cn.id}:${charge.id}` },
        select: { id: true },
      });
      paymentId = payment?.id ?? null;
      await recordAudit(tx, {
        organizationId: session.orgId,
        actorUserId: session.userId,
        actorRole: session.role,
        action: "billing-docs.credit.apply",
        entityType: "BillingDocument",
        entityId: cn.id,
        meta: { chargeId: charge.id, amount: appliedNow.toFixed(2) } as unknown as Prisma.InputJsonValue,
      });
      return { ok: true as const, status: 200 as const, data: { paymentId: paymentId ?? "", applied: appliedNow.toFixed(2) } };
    });
  } catch (e) {
    // Defense-in-depth (same idiom as charge-categories service): the CN row
    // lock + check-first idempotency key should make this unreachable in
    // practice, but a unique-constraint violation on Payment.idempotencyKey
    // must never surface as an unhandled 500.
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2002") {
        return { ok: false as const, status: 409, error: "ALREADY_APPLIED" };
      }
      if (e.code === "P2028" || e.code === "P2034") {
        return { ok: false as const, status: 409, error: "BUSY_RETRY" };
      }
    }
    if (e instanceof StaleError) {
      return { ok: false as const, status: 409, error: "Changed since you loaded it. Refresh and retry." };
    }
    throw e;
  }
  if (result.ok) {
    await syncOwnerLedgerForCharges(session.orgId, session.userId, session.role, [input.chargeId]);
    await refreshDocumentStatusForCharges([input.chargeId]);
  }
  return result;
}
