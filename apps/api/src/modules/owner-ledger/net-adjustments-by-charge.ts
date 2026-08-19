/**
 * netAdjustmentsByChargeId — batched Formula-B netting for the owner-statement
 * payout (seam #1).
 *
 * expectedStatementLedgerRows (owner-ledger.sync.ts) derives each owner
 * Source-2 expense row from charge.amount alone, so an active charge-backed
 * credit/debit note on that charge is invisible to the payout. This is the
 * ONE batched query — over ALL relevant charge IDs at once, never one query
 * per charge — that both the sync loop and R5 recon call to net those active
 * notes in: Σ(active DN line cents) − Σ(active CN line cents) per charge.
 *
 * "Active" mirrors the EXACT filter charge-adjustment.service.ts's own
 * credit-cap check uses (docType ∈ {credit_note, debit_note} AND
 * documentStatus ∈ ACTIVE_ADJUSTMENT_NOTE_STATUSES) — DRAFT, CANCELLED/voided,
 * SUPERSEDED and REVERSED notes are excluded by construction.
 *
 * ⚠️ MONEY — `originalDocumentId: { not: null }` is LOAD-BEARING. It is the same
 * clause, for the same reason, as its customer-facing sibling
 * billing-documents/adjustment-sums.ts (see that file's header for the full
 * account). Short version: a `pay_back_landlord` charge's PRIMARY bill has docType
 * `debit_note`, so filtering on docType alone made a rent charge its own +100%
 * adjustment. Here that fed `collectedString` (owner-ledger.sync.ts:343), which
 * booked collected = max(0, (amount + amount) − outstanding) = the full rent on a
 * charge nobody had paid — phantom cash in the payout and a management fee levied
 * on it.
 */
import type { Prisma } from "@kason/db";
import { getDb } from "@kason/db";
import { ACTIVE_ADJUSTMENT_NOTE_STATUSES, toCents } from "@kason/shared";

/**
 * Returns chargeId → net cents (Σ active DN line cents − Σ active CN line
 * cents) over note lines whose parent BillingDocument is an active
 * credit_note/debit_note in this org. A chargeId with no active notes is
 * ABSENT from the map — callers treat absent as 0 (no adjustment).
 */
export async function netAdjustmentsByChargeId(
  client: Prisma.TransactionClient | ReturnType<typeof getDb>,
  orgId: string,
  chargeIds: string[],
): Promise<Map<string, number>> {
  const net = new Map<string, number>();
  if (chargeIds.length === 0) return net;

  const lines = await loadActiveNoteLines(client, orgId, chargeIds);

  for (const line of lines) {
    if (!line.chargeId) continue;
    const lineCents = toCents(line.amount.toString(), "netAdjustmentsByChargeId.line");
    const signedCents = line.document.docType === "debit_note" ? lineCents : -lineCents;
    net.set(line.chargeId, (net.get(line.chargeId) ?? 0) + signedCents);
  }
  return net;
}

/**
 * chargeId → net SST cents (Σ active DN line sstAmount − Σ active CN line
 * sstAmount). Absent = 0, same contract as its `amount` sibling above.
 *
 * ⚠️ MONEY. Separate from the amount netting because SST does NOT follow from the
 * adjusted base by recomputation: what the payer owes in tax is what the NOTE
 * DECLARED, and that figure is already persisted on the note line (issue.service
 * computes it as round(line.amount × the charge's own sstRate) at mint). Deriving
 * `adjustedBase × rate` at read time instead would silently disagree with the
 * document KAEN issued and LHDN received the moment a rate changed or a note was
 * raised at a bespoke figure — the statement must report the tax that was
 * documented, never a re-derivation of it.
 *
 * Shares `loadActiveNoteLines` with the amount netting so the definition of an
 * "active adjustment" can never drift between the two.
 */
export async function netAdjustmentSstByChargeId(
  client: Prisma.TransactionClient | ReturnType<typeof getDb>,
  orgId: string,
  chargeIds: string[],
): Promise<Map<string, number>> {
  const net = new Map<string, number>();
  if (chargeIds.length === 0) return net;

  const lines = await loadActiveNoteLines(client, orgId, chargeIds);

  for (const line of lines) {
    if (!line.chargeId) continue;
    const sstCents = toCents(line.sstAmount.toString(), "netAdjustmentSstByChargeId.line");
    const signedCents = line.document.docType === "debit_note" ? sstCents : -sstCents;
    net.set(line.chargeId, (net.get(line.chargeId) ?? 0) + signedCents);
  }
  return net;
}

/** Per-charge CN/DN totals kept SEPARATE by direction, base and tax alike. */
export type ChargeAdjustmentSplit = {
  debitCents: number;
  creditCents: number;
  debitSstCents: number;
  creditSstCents: number;
};

/**
 * chargeId → the same active note lines the two netting helpers above consume, but
 * kept SPLIT by direction so a display can say "Debit note +RM 80.00 · Credit note
 * -RM 30.00" rather than an opaque "+RM 50.00". Absent = no active notes.
 *
 * ⚠️ MONEY — this is not a display-only convenience bolted beside the netting. The
 * owner-statement receivable path derives BOTH its netted amount and the note text
 * it prints from ONE call to this helper (debit − credit IS the net), so the
 * sentence the owner reads is arithmetically the movement applied to the row. The
 * alternative — netting through one helper and annotating through another — is the
 * drift this file's siblings keep warning about: two queries, two filters, and a
 * statement that eventually explains a figure it did not produce.
 *
 * Shares `loadActiveNoteLines` with the netting helpers for the same reason they
 * share it with each other: "an active adjustment" has exactly one definition.
 */
export async function adjustmentSplitByChargeId(
  client: Prisma.TransactionClient | ReturnType<typeof getDb>,
  orgId: string,
  chargeIds: string[],
): Promise<Map<string, ChargeAdjustmentSplit>> {
  const split = new Map<string, ChargeAdjustmentSplit>();
  if (chargeIds.length === 0) return split;

  const lines = await loadActiveNoteLines(client, orgId, chargeIds);

  for (const line of lines) {
    if (!line.chargeId) continue;
    const cents = toCents(line.amount.toString(), "adjustmentSplitByChargeId.line");
    const sstCents = toCents(line.sstAmount.toString(), "adjustmentSplitByChargeId.lineSst");
    const entry = split.get(line.chargeId) ?? {
      debitCents: 0,
      creditCents: 0,
      debitSstCents: 0,
      creditSstCents: 0,
    };
    if (line.document.docType === "debit_note") {
      entry.debitCents += cents;
      entry.debitSstCents += sstCents;
    } else {
      entry.creditCents += cents;
      entry.creditSstCents += sstCents;
    }
    split.set(line.chargeId, entry);
  }
  return split;
}

/** The ONE definition of "an active adjustment note line against these charges". */
async function loadActiveNoteLines(
  client: Prisma.TransactionClient | ReturnType<typeof getDb>,
  orgId: string,
  chargeIds: string[],
) {
  return client.billingDocumentLine.findMany({
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
    select: {
      chargeId: true,
      amount: true,
      sstAmount: true,
      document: { select: { docType: true } },
    },
  });
}
