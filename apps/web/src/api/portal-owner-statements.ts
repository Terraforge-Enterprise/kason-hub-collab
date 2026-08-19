// Typed react-query hooks for the Owner-portal LIVE transactions + FROZEN
// statements surface (Task 10) — own-data-only, read-only.
//
// Binds to the Task 8 endpoints, which are mounted under the DISTINCT prefix
// /portal-api/owner-live (NOT /portal-api/owner). The sibling /owner prefix
// carries a `use("*")` owner-billing flag-gate that Hono would bleed onto a
// second router mounted there, so this feature lives at /owner-live so its own
// flag (ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER) is the only gate.
//
//   GET /owner-live/transactions?scope&apartmentId&from&to  → { balance, rows }
//   GET /owner-live/statements?scope&apartmentId&year        → { items }
//   GET /owner-live/statements/:id                           → frozen snapshot
//   GET /owner-live/statements/:id/pdf                        → { url } (signed)
//
// Money conventions (mirrors the backend serialisers):
//   - `balance.*` are accrual/deposit-aware 2-dp decimal STRINGS
//     (resolveOwnerBalance → centsToString), e.g. "1000.00".
//   - frozen-statement `*C` fields are INTEGER CENTS (schema Int), so divide by
//     100 for display.
import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";

// ─── Response types ─────────────────────────────────────────────────────────

/**
 * Authoritative running-balance SUMMARY for the transactions window (the
 * accrual/deposit-aware `resolveOwnerBalance` result). NOT a per-row running
 * total — it folds in unpaid-active rows + deposits, so a per-row cash tally of
 * `rows` will NOT reconcile to it. Render it as a summary header/card only.
 */
export type OwnerLiveBalance = {
  broughtForward: string;
  periodGross: string;
  periodExpenses: string;
  periodPayouts: string;
  netThisPeriod: string;
  depositCollected: string;
  carriedForward: string;
};

/** One SETTLED cash transaction row (active + paid only; unpaid/void excluded). */
export type OwnerTransactionRow = {
  id: string;
  /** First-of-month key "YYYY-MM". */
  statementMonth: string;
  /** ISO timestamp. */
  transactionDate: string;
  /** "income" | "expense" | "payout". */
  direction: string;
  category: string;
  description: string | null;
  /** 2-dp decimal string. */
  amount: string;
  paymentStatus: string;
  apartmentId: string | null;
};

export type OwnerTransactionsResponse = {
  scope: "combined" | "unit";
  apartmentId: string | null;
  balance: OwnerLiveBalance;
  rows: OwnerTransactionRow[];
};

/** One FROZEN statement document (list + detail share this DTO). */
export type OwnerFrozenStatement = {
  id: string;
  /** First-of-month key "YYYY-MM". */
  month: string;
  apartmentId: string | null;
  issuedAt: string | null;
  /** Integer cents. */
  openingBalanceC: number;
  /** Integer cents. */
  closingBalanceC: number;
  /** Integer cents. */
  netPayoutC: number;
  /** Storage key; null until the PDF has been rendered. */
  pdfKey: string | null;
};

export type OwnerStatementsResponse = {
  items: OwnerFrozenStatement[];
};

/** A single frozen statement's snapshot detail (GET /statements/:id). */
export type OwnerFrozenStatementDetail = OwnerFrozenStatement & {
  status: string;
  /** Frozen line items as of the freeze (opaque snapshot shape). */
  snapshot: unknown[];
};

// ─── Query params ───────────────────────────────────────────────────────────

export type PortalOwnerTransactionsParams = {
  scope?: "combined" | "unit";
  /** Only meaningful when scope === "unit". */
  apartmentId?: string | null;
  /** Inclusive lower bound "YYYY-MM". Omit for all-time (current month included). */
  from?: string;
  /** Inclusive upper bound "YYYY-MM". Omit to include the current open month. */
  to?: string;
};

export type PortalOwnerStatementsParams = {
  scope?: "combined" | "unit";
  /** Only meaningful when scope === "unit". */
  apartmentId?: string | null;
  /** Filter to a single calendar year "YYYY". */
  year?: string;
};

// ─── Hooks ──────────────────────────────────────────────────────────────────

/**
 * Fetch the owner's LIVE running transaction history — settled cash rows plus
 * the authoritative `balance` summary. The CURRENT open month is INCLUDED by
 * default (no upper bound unless `to` is passed). Own-data-only: NO owner/org id
 * is ever sent; the backend scopes to the portal session.
 *
 * Binds to: GET /portal-api/owner-live/transactions
 */
export function usePortalOwnerTransactions(params: PortalOwnerTransactionsParams = {}) {
  const { scope, apartmentId, from, to } = params;
  const qs = new URLSearchParams();
  if (scope) qs.set("scope", scope);
  if (scope === "unit" && apartmentId) qs.set("apartmentId", apartmentId);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const query = qs.toString();

  return useQuery({
    queryKey: [
      "portal-owner-live-transactions",
      scope ?? "combined",
      apartmentId ?? null,
      from ?? null,
      to ?? null,
    ],
    queryFn: () =>
      portalApiFetch<{ data: OwnerTransactionsResponse }>(
        `/owner-live/transactions${query ? `?${query}` : ""}`,
      ),
  });
}

/**
 * Fetch the owner's FROZEN statement documents only — the "bank statements".
 * The current open month is NEVER listed (the backend excludes it; it lives
 * under /transactions). Own-data-only.
 *
 * Binds to: GET /portal-api/owner-live/statements
 */
export function usePortalOwnerStatements(params: PortalOwnerStatementsParams = {}) {
  const { scope, apartmentId, year } = params;
  const qs = new URLSearchParams();
  if (scope) qs.set("scope", scope);
  if (scope === "unit" && apartmentId) qs.set("apartmentId", apartmentId);
  if (year) qs.set("year", year);
  const query = qs.toString();

  return useQuery({
    queryKey: [
      "portal-owner-live-statements",
      scope ?? "combined",
      apartmentId ?? null,
      year ?? null,
    ],
    queryFn: () =>
      portalApiFetch<{ data: OwnerStatementsResponse }>(
        `/owner-live/statements${query ? `?${query}` : ""}`,
      ),
  });
}

/**
 * Fetch a single frozen statement's snapshot detail. Throws PortalApiError
 * (409 STATEMENT_NOT_ISSUED for a non-frozen period, 404 for a cross-owner /
 * unknown id). Not consumed by the current list+PDF UI, but exposed so callers
 * can drill into the frozen snapshot without re-deriving the /owner-live path.
 *
 * Binds to: GET /portal-api/owner-live/statements/:id
 */
export async function fetchPortalOwnerStatement(
  id: string,
): Promise<OwnerFrozenStatementDetail> {
  const res = await portalApiFetch<{ data: OwnerFrozenStatementDetail }>(
    `/owner-live/statements/${id}`,
  );
  return res.data;
}

/**
 * Resolve the signed download URL for a frozen statement's PDF. Throws
 * PortalApiError (409 STATEMENT_NOT_ISSUED for a non-frozen / no-pdf period,
 * 404 for a cross-owner / unknown id). Called inside a user click gesture so the
 * caller can open a blank tab synchronously (popup-blocker-safe) and navigate it
 * once this resolves.
 *
 * Binds to: GET /portal-api/owner-live/statements/:id/pdf
 */
export async function fetchPortalOwnerStatementPdfUrl(id: string): Promise<string> {
  const res = await portalApiFetch<{ data: { url: string } }>(
    `/owner-live/statements/${id}/pdf`,
  );
  return res.data.url;
}

// ─── Task: Owner-payable reconciliation (Phase 3, R15/R18) ────────────────────

/**
 * Owner-payable reconciliation for one month — the R15 opening→closing
 * waterfall plus the R18 frozen-vs-remaining-now figures. All `*C` fields are
 * integer cents. `frozenNetPayableAtCloseC` is null until the period freezes.
 *
 * Source: docs/superpowers/specs/2026-07-20-rental-reclassification-owner-payable-completion-design.md
 * (R15/R18) via the Phase-3 backend contract.
 */
export type OwnerPayableReconciliation = {
  ownerPartyId: string;
  apartmentId: string | null;
  periodMonth: string;
  openingPayableC: number;
  collectionsC: number;
  offsetDeductionsC: number;
  passThroughExpensesC: number;
  grossRemittancesC: number;
  reversalsC: number;
  closingPayableC: number;
  balanced: boolean;
  discrepancyC: number;
  periodStatus: "open" | "frozen";
  frozenNetPayableAtCloseC: number | null;
  remainingPayableNowC: number;
};

/**
 * Fetch the owner's payable reconciliation for one "YYYY-MM" month.
 * Own-data-only: no owner/org id is ever sent; the backend scopes to the
 * portal session.
 *
 * Binds to: GET /portal-api/owner-live/reconciliation?month=YYYY-MM
 */
export function usePortalOwnerReconciliation(month: string) {
  return useQuery({
    queryKey: ["portal-owner-live-reconciliation", month],
    queryFn: () =>
      portalApiFetch<{ data: OwnerPayableReconciliation }>(
        `/owner-live/reconciliation?month=${month}`,
      ),
  });
}
