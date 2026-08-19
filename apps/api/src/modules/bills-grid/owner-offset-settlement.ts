/**
 * WHICH re-Bill-reclaimable documents may be CANCELLED.
 *
 * ⚠️ MONEY. Step 9 of `rebillSupersedeTx` used to cancel EVERY reclaimable document
 * unconditionally. That is safe for a TENANT proforma — its paid lines have already
 * graduated onto a real tax invoice (IVTEN), so the PI is an empty shell by then — and
 * catastrophic for an OWNER invoice, which has no graduation route: the IVOWN is the only
 * document those charges will ever sit on. Cancelling a settled IVOWN is what re-billed
 * money the owner's payable had already absorbed (UAT IVOWN-0008 → IVOWN-0009,
 * 2026-08-18); see `../../owner-remittance/owner-offset-reader.ts` for the settlement rail
 * that made the grid's paid-guard blind to it.
 *
 * Deliberately stated in terms of what happens to the CHARGES, not in terms of
 * counterparty: a rule keyed on "owner" would miss the next document type that settles
 * without graduating.
 */

/**
 * PURE — no I/O. Partition the reclaimable documents into those the re-Bill may cancel
 * and those it must leave ISSUED.
 *
 * **A DOCUMENT OF RECORD may be cancelled only when the re-Bill is replacing every one of
 * its live charges.** A document of record still carrying a charge the re-Bill
 * deliberately KEPT — settled money, protected from both the credit sweep and the
 * re-mint — stays ISSUED, because that charge has nowhere else to live.
 *
 * A PROFORMA is exempt, and that exemption is what keeps the tenant path byte-identical.
 * A PI is a draft, not a receivable of record: cancelling one strands nothing — the
 * charge stays live with its allocation intact, and the tenant's real tax invoice is
 * issued by graduation on its own schedule. It MUST still be superseded, or the unit-month
 * is left with two live proformas and the tenant reads the stale one. The reclaim set can
 * hold `proforma`, `invoice`, `debit_note` and `owner_expense_advice` (service.ts's
 * head-of-chain allowlist); only the first is a draft.
 *
 * Consequences, both intended:
 *   • fully-settled owner invoice → untouched. Nothing credited, nothing re-minted, not
 *     cancelled. The tenant's side of the same re-Bill proceeds normally.
 *   • partly-settled owner invoice → also stays ISSUED, carrying its settled lines; the
 *     unsettled ones are credited off it and re-minted onto a fresh document, exactly as
 *     a credit note would leave it. Never a cancel that strands settled money.
 *
 * `protectedChargeIds` is empty whenever partial re-Bill is off — the flag-off path hard-
 * blocks on any settled charge long before this — so every document partitions into
 * `cancel` and the behaviour is byte-identical to before.
 */
const DRAFT_DOC_TYPES = new Set(["proforma"]);

export function docsSafeToCancel<D extends { id: string; docType: string }>(input: {
  docs: readonly D[];
  /** Live charges, each tagged with the id of its OWN document (`documentId`). */
  charges: readonly { id: string; documentId?: string | null }[];
  /** Charge ids the re-Bill is KEEPING — settled money, never credited, never re-minted. */
  protectedChargeIds: ReadonlySet<string>;
}): { cancel: D[]; kept: D[] } {
  const { docs, charges, protectedChargeIds } = input;
  const pinnedDocIds = new Set<string>();
  for (const c of charges) {
    if (c.documentId != null && protectedChargeIds.has(c.id)) pinnedDocIds.add(c.documentId);
  }
  const cancel: D[] = [];
  const kept: D[] = [];
  for (const d of docs) {
    (pinnedDocIds.has(d.id) && !DRAFT_DOC_TYPES.has(d.docType) ? kept : cancel).push(d);
  }
  return { cancel, kept };
}
