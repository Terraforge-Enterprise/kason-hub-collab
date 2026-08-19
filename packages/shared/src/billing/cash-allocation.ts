// ONE declaration of "this PaymentAllocation represents money that actually arrived".
//
// ── Why this file exists ─────────────────────────────────────────────────────
// The predicate existed as three hand-copied literals — billing-documents/
// status.service.ts, billing-documents/repository.ts and portal/charges/
// portal.charges.repository.ts each carried its own `payment: { status: "posted" }`
// — and was MISSING entirely from three bills-grid reads (service.ts's
// entriesWithPaidInvoice, settlementByEntry, and the in-transaction re-Bill
// guard). So the grid and the documents disagreed about whether a line was
// settled: status.service.ts derives `settlementStatus`, the persisted payment
// axis for EVERY BillingDocument, so "posted-only" was already the system-wide
// definition of paid. The grid was the outlier.
//
// ── What the grid's omission caused ──────────────────────────────────────────
// Portal FPX mints a Payment(status "pending_approval") AND its allocations at
// initiate, settling nothing (portal.payments.repository.ts — "NO charge is
// settled"). Expiry flips the payment to "expired"; a gateway failure to
// "failed". Neither removes the allocations. So a tenant who opened the bank
// page and walked away left a permanent allocation that the grid read as money:
// a false part-paid tick, a locked row, and a blocked re-Bill.
//
// ── Why an allow-list on "posted", not a deny-list ───────────────────────────
// A deny-list on the not-real statuses would give the grid a BROADER notion of
// paid than the documents have, so the grid could read "paid" where the document
// reads "unpaid". One definition, imported by every reader, is the only shape
// that cannot drift. The cost of the allow-list is that a legacy status nobody
// anticipated reads as unpaid — which is why enabling this is gated on a
// legacy-status query against UAT and prod (see the slice-0 spec).
//
// ── Deliberately NOT here: "void" / "refunded" ───────────────────────────────
// Reversals are netted separately by sumReversalsForAllocations
// (payments.repository.ts). Excluding reversed payments here as well would
// subtract the same reversal twice.
//
// ── SCOPE: allocation READS only ─────────────────────────────────────────────
// Do NOT route Payment WRITE paths through this. `payments.repository.ts` and
// `payments.service.ts` legitimately SET status "posted" when settling; those
// are state transitions, not cash-meaning reads.
import { PAYMENT_STATUSES } from "../constants/statuses";

/**
 * The LIVE `Payment.status` write-set, derived from the constant.
 *
 * ⚠️ Deliberately NOT the `PaymentStatus` exported by `../types/billing.ts`.
 * That older hand-written union reads
 *     "recorded" | "allocated" | "void" | "refunded"
 * — two values the code never writes, and MISSING all four it does
 * (pending_approval, posted, expired, failed). It has zero consumers, so it is
 * left in place rather than deleted here; removing it is a separate cleanup.
 *
 * The `Live` prefix is the pattern `tenant-visibility.ts` already established
 * for exactly this collision (`LiveChargeStatus` vs the stale `ChargeStatus` in
 * that same types/billing.ts). Naming this `PaymentStatus` would make BOTH
 * names reachable through the barrel's two `export *` lines (./types/billing
 * and ./constants/statuses) — TypeScript drops an ambiguous star export, so
 * every consumer's `import type { PaymentStatus } from "@kason/shared"` would
 * fail TS2305, and it would fail only at the CONSUMER, never inside this
 * package.
 */
export type LivePaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** The only `Payment.status` that means money actually arrived. */
export const CASH_PAYMENT_STATUS = "posted" as const;

/**
 * Does this `Payment.status` mean money actually arrived?
 *
 * A `Record` over the full union rather than a bare `=== "posted"`: adding a
 * status to PAYMENT_STATUSES becomes a BUILD FAILURE that has to be answered
 * here, instead of silently defaulting to "not cash" (which under-counts
 * settled money) or "cash" (which over-counts it). This map is the union's only
 * consumer — it is what makes correcting PAYMENT_STATUSES load-bearing rather
 * than documentation.
 */
export const IS_CASH_PAYMENT_STATUS: Record<LivePaymentStatus, boolean> = {
  // FPX initiated, tenant never completed — allocations exist, charges untouched.
  pending_approval: false,
  // The only status meaning money arrived.
  posted: true,
  // Initiate swept after 30 minutes without a callback.
  expired: false,
  // Gateway declined.
  failed: false,
  // Reversed — also netted by sumReversalsForAllocations.
  void: false,
  // Returned to the payer.
  refunded: false,
  // An admin reviewed the tenant's transfer slip and refused it. The claimed
  // money never arrived, so this is emphatically NOT cash — the allocations are
  // left in place (inert, exactly like "expired"/"failed") rather than deleted,
  // so the rejected attempt stays auditable.
  rejected: false,
  // A signed gateway success arrived for a payment a human had already
  // cancelled (or the gateway had already failed). The bank very likely DID
  // debit the payer — but nothing has been applied to any charge yet, and until
  // an admin resolves it nothing should be. Counting it as cash here would
  // report money as collected that no charge has actually received.
  //
  // This is the one status where "not cash" is a statement about our books, not
  // about the payer's bank account. That asymmetry is the whole reason the row
  // is queued for a human instead of settled automatically.
  needs_reconciliation: false,
};

/**
 * Prisma `where` fragment for any `PaymentAllocation` read whose result is
 * interpreted as cash. Spread into the where clause:
 *
 *   where: { organizationId: orgId, chargeId: { in: ids }, ...CASH_ALLOCATION_WHERE }
 *
 * Shape-locked by test: exactly one top-level key. A sibling key added here
 * would silently widen every consumer's filter with no type error.
 */
export const CASH_ALLOCATION_WHERE = {
  payment: { status: CASH_PAYMENT_STATUS },
} as const;

// ── Deliberately NOT here: a "was it EVER cash" status fragment ──────────────
// An earlier revision added one (posted | void | refunded) to decide whether an
// owner-ledger CLAWBACK may post. It caused a Critical bug and was removed, so
// that nobody re-derives it: payment status answers "did money ever ARRIVE",
// which is NOT the question a clawback asks. The question is "was the owner ever
// CREDITED", and only the ledger's own rows answer that — an active
// `prior_period_collection` for the allocation, or the frozen collected figure.
//
// Using status as the proxy is wrong in BOTH directions: `posted`-only hides a
// voided allocation so the clawback never posts (owner keeps money the org
// returned), while widening to void|refunded lets a reversal on a NEVER-credited
// allocation post a clawback against nothing (owner debited out of thin air —
// reachable with no failure at all: reverseAllocationInTx writes the reversal
// row unconditionally, consulting payment.status only afterwards to decide
// whether to restore the charge, and correction-replace reads a charge's
// allocations with no payment filter at all).
// See prior-period-collection.ts `recognisedCreditAllocIds`.

/**
 * Prisma `where` fragment for "a human still has to decide about this claim" —
 * a tenant-submitted transfer slip sitting in the verification queue.
 *
 * ⚠️ `gatewayStatus: null` is the load-bearing half, and it is NOT redundant
 * with the status. `pending_approval` alone also matches an FPX attempt that is
 * mid-flight at the bank (`initiateFpxPaymentTx` writes exactly that, with
 * `gatewayStatus: "pending"`). Those two states look identical on the status
 * column and mean opposite things:
 *
 *   - manual slip  → gatewayStatus null    → waiting on a PERSON. Block further
 *                                            payment; show it to an admin.
 *   - in-flight FPX → gatewayStatus "pending" → waiting on the GATEWAY. The
 *                                            callback or the 30-minute stale
 *                                            sweep resolves it; no admin can
 *                                            action it (the routes 409 on
 *                                            isInFlightFpx).
 *
 * Conflating them cost the primary payment rail: a tenant who abandoned a bank
 * redirect could not pay that charge by ANY method until their dead row aged
 * out, and the admin queue filled with phantom claims neither button could
 * clear. Every reader that means "awaiting verification" MUST use this fragment
 * rather than an inline `status: "pending_approval"`.
 *
 * Shape-locked by test, same as CASH_ALLOCATION_WHERE.
 */
export const AWAITING_VERIFICATION_WHERE = {
  payment: { status: "pending_approval", gatewayStatus: null },
} as const;

/**
 * Prisma `where` fragment for "this charge already has a claim on it that the
 * tenant must not pay over the top of" — the DOUBLE-SUBMIT guard.
 *
 * Broader than AWAITING_VERIFICATION_WHERE by exactly one status, and the
 * difference matters in money:
 *
 *   - `pending_approval` + `gatewayStatus: null` → a manual slip awaiting a
 *     human. Blocks, so one transfer is not claimed twice.
 *   - `needs_reconciliation` → the GATEWAY confirmed the payment; the payer has
 *     almost certainly been debited and we simply have not applied it yet.
 *
 * The second is the stronger case of the two and was originally missed. Such a
 * charge still reads its full outstanding (nothing has been applied), so without
 * this it renders as freely payable — while the tenant-facing copy on that exact
 * payment promises "you don't need to pay again". A tenant who believes us is
 * fine; a tenant who pays anyway is charged twice for one debt.
 *
 * An in-flight FPX attempt is still deliberately NOT here: it waits on the
 * gateway, nobody can action it, and blocking on it took the primary payment
 * rail offline for 30 minutes after any abandoned redirect.
 */
// Deliberately NOT `as const`, unlike its siblings above. `as const` would make
// the OR array `readonly`, and Prisma's generated relation-filter types accept
// only a mutable array — the fragment would fail to typecheck at every consumer
// rather than here. The tuple is still frozen in shape by its test.
export const BLOCKS_FURTHER_PAYMENT_WHERE: {
  payment: { OR: ({ status: string; gatewayStatus?: null } | { status: string })[] };
} = {
  payment: {
    OR: [
      { status: "pending_approval", gatewayStatus: null },
      { status: "needs_reconciliation" },
    ],
  },
};
