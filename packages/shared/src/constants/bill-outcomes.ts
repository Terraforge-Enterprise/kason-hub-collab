// packages/shared/src/constants/bill-outcomes.ts
//
// THE single declaration of the bills-grid Bill/re-Bill result contract.
//
// WHY THIS FILE EXISTS. `BillOutcome` and `PaidBlocker` used to be declared TWICE — once in
// apps/api (service.ts / rebill-assessment.ts) and again, hand-copied, in apps/web
// (api/bills-grid.ts). The API side has an assertNever exhaustiveness test, but that test is
// blind to the web's copy, so adding an outcome type-checked on the API and silently left the
// web union short. That is exactly how `blocked_future_period` slipped through until a
// downstream typecheck caught it. One declaration, imported by both, makes the drift impossible.
//
// BILL_OUTCOMES is the runtime source of truth; BillOutcome is derived from it, so a
// `Record<BillOutcome, …>` or a switch + assertNever anywhere in either app fails to compile
// the moment a member is added here and not handled there.

export const BILL_OUTCOMES = [
  // Terminal success / no-op states.
  "billed",
  "stale",
  "already_billed",
  "compute_error",
  "no_entry",
  "save_failed",
  "invoiced",
  "reinvoiced",
  "already_invoiced",
  "pax_blocked",
  "paid_locked",
  "occupancy_changed",

  // Re-Bill preflight/guard outcomes (billing-mechanism rework).
  //  • rebill_confirmation_required — live grid invoices exist for this unit-month; the admin
  //    must confirm the void-and-reissue. Returned WITHOUT any mutation.
  //  • rebill_blocked_previous_period — the period is before the org-local current month;
  //    re-Bill is refused (use the accounting correction process).
  //  • rebill_blocked_payment_exists — the existing invoice carries an active (non-reversed)
  //    payment allocation; refused for the WHOLE row. The grid never reverses received payment.
  //  • conflicting_invoice — a live utility invoice for this unit-month is NOT from this grid
  //    workflow (or is ambiguous) → fail closed.
  "rebill_confirmation_required",
  "rebill_blocked_previous_period",
  "rebill_blocked_payment_exists",
  "conflicting_invoice",

  // Pre-lock recurring-charge conflicts (fail closed; nothing minted).
  "recurring_unresolved",
  "nature_unresolved",

  // The period is beyond the one-month advance-billing window. Rule 1 refuses a PAST
  // re-Bill; this closes the far-future end for BOTH first issuance and re-Bill.
  "blocked_future_period",
] as const;

export type BillOutcome = (typeof BILL_OUTCOMES)[number];

/**
 * One blocked document behind a `rebill_blocked_payment_exists` outcome.
 *
 * `documentId` is what lets the UI hand the admin off to the correction flow instead of
 * dead-ending on "blocked". It is NULL only for the doc-less fallback group (a legacy charge
 * carrying no documentId), where there is genuinely no document to correct.
 */
export type PaidBlocker = {
  counterparty: "tenant" | "owner";
  documentId: string | null;
  invoiceNumber: string | null;
  paidAmount: number;
  invoiceTotal: number;
  paymentState: "paid" | "partial";
};
