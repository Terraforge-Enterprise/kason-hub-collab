// The SINGLE definition of which credit/debit-note lifecycle states are financially
// ACTIVE — i.e. affect adjusted total, settlement/OVERPAID, outstanding balance,
// per-line adjustments, and void recalculation. Every money derivation that aggregates
// adjustment notes MUST use this predicate, so Formula A (status.service) and Formula B
// (derive-document-badges) can never disagree on WHICH notes count.
//
// Allowlist, not denylist: only ISSUED notes move money.
//  - DRAFT      → not yet real (no code writes it today; excluded defensively).
//  - CANCELLED  → voided/cancelled note; must not affect money.
//  - SUPERSEDED → replaced document; must not affect money.
// "Applied" is NOT a documentStatus — a credit note stays ISSUED when its credit is spent
// (CreditApplication is a separate link), so ISSUED covers both issued and applied.
export const ACTIVE_ADJUSTMENT_NOTE_STATUSES = ["ISSUED"] as const;

export function isActiveAdjustmentNote(documentStatus: string): boolean {
  return (ACTIVE_ADJUSTMENT_NOTE_STATUSES as readonly string[]).includes(documentStatus);
}
