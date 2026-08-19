/**
 * adjustmentSumsByChargeId — batched per-charge CN/DN totals for CUSTOMER-FACING
 * surfaces (tenant portal readers, PDF model). The owner-payout math already has
 * its netted sibling (owner-ledger/net-adjustments-by-charge.ts); this variant
 * keeps the two directions SEPARATE because a customer display must say
 * "Debit notes +X / Credit notes −X", not a single opaque net.
 *
 * "Active" mirrors the exact filter charge-adjustment.service.ts's credit-cap
 * check uses (docType ∈ {credit_note, debit_note} AND documentStatus ∈
 * ACTIVE_ADJUSTMENT_NOTE_STATUSES) — DRAFT, CANCELLED/voided, SUPERSEDED and
 * REVERSED notes are excluded by construction. ONE batched query over all
 * charge ids, never one per charge.
 *
 * ⚠️ MONEY — `originalDocumentId: { not: null }` is LOAD-BEARING, not a tidy-up.
 * `docType` alone does NOT mean "this is a correction". Every `pay_back_landlord`
 * charge — rent, carpark, deposits, tenant-borne utilities — has a PRIMARY bill
 * whose docType IS `debit_note` (seed-categories.ts: family pay_back_landlord →
 * docType debit_note, series RB/DEP). Without this clause a rent charge's own bill
 * is summed as an adjustment against itself and every reader doubles it: a RM 2.42
 * prorated rent rendered RM 4.84 on the owner statement, the tenant portal's
 * `adjustedAmount` doubled, and — via the netted sibling in
 * owner-ledger/net-adjustments-by-charge.ts — `collectedString` booked RM 2.42 of
 * COLLECTED rent on a charge with zero payments against it, paying the owner and
 * charging a management fee on cash that never arrived.
 *
 * The discriminator is the one charge-adjustment.service.ts:167 already uses to
 * find "the charge's ORIGINAL invoice/debit_note" (originalDocumentId: null) and
 * that repository.ts:51-55 documents as primary-bill scoping: an adjustment note
 * REFERENCES the document it adjusts; a primary bill references nothing. Every
 * mint path agrees — CN/DN/RN series always set it (credit-notes.service.ts:185/498,
 * charge-adjustment.service.ts:225/340, overpayment-cn.service.ts:79,
 * correction-replace.service.ts:279/299), primary bills never do.
 */
import type { Prisma } from "@kason/db";
import { getDb } from "@kason/db";
import { ACTIVE_ADJUSTMENT_NOTE_STATUSES, toCents } from "@kason/shared";

export type ChargeAdjustmentSums = { debitCents: number; creditCents: number };

/**
 * chargeId → {debitCents, creditCents} over active note lines. A chargeId with
 * no active notes is ABSENT from the map — callers treat absent as zeros.
 */
export async function adjustmentSumsByChargeId(
  client: Prisma.TransactionClient | ReturnType<typeof getDb>,
  orgId: string,
  chargeIds: string[],
): Promise<Map<string, ChargeAdjustmentSums>> {
  const sums = new Map<string, ChargeAdjustmentSums>();
  if (chargeIds.length === 0) return sums;

  const lines = await client.billingDocumentLine.findMany({
    where: {
      chargeId: { in: chargeIds },
      document: {
        organizationId: orgId,
        docType: { in: ["credit_note", "debit_note"] },
        // See the ⚠️ MONEY note in the header: a primary bill that happens to be a
        // debit_note (rent, carpark, deposits, tenant utilities) is NOT an adjustment.
        originalDocumentId: { not: null },
        documentStatus: { in: [...ACTIVE_ADJUSTMENT_NOTE_STATUSES] },
      },
    },
    select: { chargeId: true, amount: true, document: { select: { docType: true } } },
  });

  for (const line of lines) {
    if (!line.chargeId) continue;
    const cents = toCents(line.amount.toString(), "adjustmentSumsByChargeId.line");
    const entry = sums.get(line.chargeId) ?? { debitCents: 0, creditCents: 0 };
    if (line.document.docType === "debit_note") entry.debitCents += cents;
    else entry.creditCents += cents;
    sums.set(line.chargeId, entry);
  }
  return sums;
}
