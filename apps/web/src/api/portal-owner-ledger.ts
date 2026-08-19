// Typed react-query hooks for the Portal Owner-Ledger (Plan B M6b) — own-data-only.
//
// Binds to portal endpoints mounted under /portal-api/owner-ledger.
// All routes are flag-gated (ENABLE_PHASE2_OWNER_BILLING) and enforce
// session.partyId — an owner can never see another owner's rows.
//
// Decimal money values travel as 2-dp decimal STRINGS (Prisma.Decimal.toString()).
// Query-key convention mirrors portal-financials / portal-reports:
//   ["portal-owner-ledger", fromMonth, toMonth, propertyId ?? null]
//   ["portal-owner-tax",    fromMonth, toMonth, propertyId ?? null]
//   ["portal-owner-property", id]
import { useQuery } from "@tanstack/react-query";
import { portalApiFetch, portalApiUrl, PortalApiError } from "@/lib/portal-api";
import { getPortalToken } from "@/lib/auth";
import { triggerBlobDownload } from "@/lib/download-media";
import type { YannieSections } from "@/api/owner-ledger";
import type { ExpenseProofGroup } from "@/api/owner-billing";

// ─── Row type ─────────────────────────────────────────────────────────────────
// Mirrors OwnerLedgerRowDto in
// apps/api/src/modules/portal/owner-ledger/portal.owner-ledger.repository.ts.
// Note: the portal DTO intentionally omits admin-only fields (organizationId,
// ownerPartyId, tenancyId, status, sourceType, created/updatedById).

export type OwnerLedgerRowDto = {
  id: string;
  /** First-of-month, formatted as "YYYY-MM". */
  statementMonth: string;
  /** ISO date string (YYYY-MM-DD). */
  transactionDate: string;
  /** "income" | "expense" | "payout" */
  direction: string;
  category: string;
  description: string | null;
  remarks: string | null;
  /** Decimal.toString() — e.g. "1000" or "1000.50". */
  amount: string;
  /** Decimal.toString() or null when no SST applies. */
  sstAmount: string | null;
  paidBy: string;
  paymentStatus: string;
  /** True when this row is Kaen-paid and deducted from the owner's payout (R5 status split). */
  includeInPayout: boolean;
  taxCategory: string;
  attachmentKeys: string[];
  propertyId: string;
  apartmentId: string | null;
  unitCode: string | null;
  listingId: string | null;
};

// ─── Summary types ─────────────────────────────────────────────────────────────
// Mirrors the return of summarizeOwnerPeriod() in packages/shared/src/finance/owner-net-payout.ts.

export type OwnerLedgerSummary = {
  grossRental: string;
  totalExpenses: string;
  netRentalAfterExpenses: string;
  netPayoutToOwner: string;
  payoutsTotal: string;
  byCategory: Record<string, string>;
  // Balance fields
  broughtForward: string;
  carriedForward: string;
};

// Mirrors summarizeTax() return + TAX_DISCLAIMER appended by the route.
export type OwnerTaxSummary = {
  byTaxCategory: Record<string, string>;
  byCategory: Record<string, string>;
  totalExpenses: string;
  disclaimer: string;
};

// ─── Property view type ───────────────────────────────────────────────────────
// Mirrors the return of getOwnerPropertyView() in
// apps/api/src/modules/portal/owner-ledger/portal.owner-ledger.repository.ts.

type OwnerPropertyDeposit = {
  id: string;
  type: string;
  amount: string;
  status: string;
};

type OwnerPropertyTenancy = {
  id: string;
  tenantDisplayName: string;
  startDate: string;
  endDate: string | null;
  monthlyRentAmount: string;
};

type OwnerPropertyUnit = {
  listingId: string;
  unitCode: string;
  occupancyStatus: string;
  currentTenancy: OwnerPropertyTenancy | null;
  deposits: OwnerPropertyDeposit[];
};

type OwnerPropertyManagementFeeConfig = {
  feeType: string;
  feeValue: string;
  sstPercent: string;
  capAmount: string | null;
};

export type OwnerPropertyView = {
  id: string;
  name: string;
  address: {
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  };
  managerId: string | null;
  units: OwnerPropertyUnit[];
  managementFeeConfig: OwnerPropertyManagementFeeConfig | null;
};

// ─── Hooks ────────────────────────────────────────────────────────────────────

/**
 * Fetch the owner's ledger rows + period summary for [fromMonth..toMonth].
 * Optionally scoped to a single property via propertyId.
 *
 * Binds to: GET /portal-api/owner-ledger?fromMonth&toMonth&propertyId?
 */
export function useOwnerLedger(
  fromMonth: string,
  toMonth: string,
  propertyId?: string,
) {
  const qs = new URLSearchParams({ fromMonth, toMonth });
  if (propertyId) qs.set("propertyId", propertyId);

  return useQuery({
    queryKey: ["portal-owner-ledger", fromMonth, toMonth, propertyId ?? null],
    queryFn: () =>
      portalApiFetch<{ data: { rows: OwnerLedgerRowDto[]; summary: OwnerLedgerSummary } }>(
        `/owner-ledger?${qs.toString()}`,
      ),
    enabled: !!(fromMonth && toMonth),
    placeholderData: (prev) => prev,
  });
}

/**
 * Fetch the owner's tax-category breakdown for [fromMonth..toMonth].
 * Includes a human-readable `disclaimer` string for the PDF / screen display.
 *
 * Binds to: GET /portal-api/owner-ledger/tax-summary?fromMonth&toMonth&propertyId?
 */
export function useOwnerTaxSummary(
  fromMonth: string,
  toMonth: string,
  propertyId?: string,
) {
  const qs = new URLSearchParams({ fromMonth, toMonth });
  if (propertyId) qs.set("propertyId", propertyId);

  return useQuery({
    queryKey: ["portal-owner-tax", fromMonth, toMonth, propertyId ?? null],
    queryFn: () =>
      portalApiFetch<{ data: OwnerTaxSummary }>(
        `/owner-ledger/tax-summary?${qs.toString()}`,
      ),
    enabled: !!(fromMonth && toMonth),
    placeholderData: (prev) => prev,
  });
}

/**
 * Fetch a single property view for the authenticated owner.
 * 404s if the owner does not hold an active LandlordTenancy for the property.
 *
 * Binds to: GET /portal-api/owner-ledger/properties/:id
 */
export function useOwnerProperty(id: string | null | undefined) {
  return useQuery({
    queryKey: ["portal-owner-property", id],
    queryFn: () =>
      portalApiFetch<{ data: OwnerPropertyView }>(`/owner-ledger/properties/${id}`),
    enabled: !!id,
  });
}

// ─── Portal statement sections (2c-1 / 2c-4) ─────────────────────────────────

/**
 * Fetch the 5-section Yannie statement for the authenticated owner (portal).
 * Only resolves after the statement has been posted (approved/sent/paid).
 * Disabled until statementId is provided.
 *
 * Binds to: GET /portal-api/owner/statements/:id/sections
 * (built in task 2c-4 — hook declared here so 2c-2/2c-3 can import it early).
 */
export function usePortalStatementSections(statementId: string | undefined) {
  return useQuery({
    queryKey: ["portal-statement-sections", statementId],
    queryFn: () =>
      portalApiFetch<{ data: YannieSections }>(
        `/owner/statements/${statementId}/sections`,
      ),
    enabled: !!statementId,
  });
}

// ─── Portal statement proofs / proof-pack (C2 — owner-scoped, POST-only) ──────

/**
 * Fetch the supporting BILLS (grouped by RAW category, signed inline) for the
 * authenticated owner's statement. Owner-scoped + POST-only on the server: a draft
 * month, another owner's statement, or an unknown id all 404. Disabled until an id
 * is provided. Mirrors the admin useExpenseProofs response shape (ExpenseProofGroup[]).
 *
 * Binds to: GET /portal-api/owner/statements/:id/proofs
 */
export function usePortalStatementProofs(statementId: string | undefined) {
  return useQuery({
    queryKey: ["portal-statement-proofs", statementId],
    queryFn: () =>
      portalApiFetch<{ data: ExpenseProofGroup[] }>(
        `/owner/statements/${statementId}/proofs`,
      ),
    enabled: !!statementId,
  });
}

/**
 * Download the merged proof-pack PDF for the authenticated owner's statement (the
 * "Download all bills" action behind the portal Bills/Proof panel). Hits fetch
 * directly (binary, not JSON) with the portal bearer token, then triggers a browser
 * download via a same-origin blob URL. Throws PortalApiError on failure (incl. 404
 * for a draft month / non-owned statement / no usable bills).
 *
 * Binds to: GET /portal-api/owner/statements/:id/proof-pack
 */
export async function downloadPortalProofPack(
  statementId: string,
  statementMonth: string,
): Promise<void> {
  const token = getPortalToken();
  const res = await fetch(portalApiUrl(`/owner/statements/${statementId}/proof-pack`), {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      typeof body?.error === "string" ? body.error : `Download failed (${res.status})`;
    throw new PortalApiError(message, res.status, body);
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, `proof-pack-${statementMonth}.pdf`);
}

// ─── Portal multi-month export (D1/D2 — owner-scoped, POST-only) ──────────────

/** Coordinates for the portal month-range export — NO ownerPartyId (the session owner). */
export type PortalMonthRangeExportArgs = {
  /** "YYYY-MM" inclusive lower bound. */
  fromMonth: string;
  /** "YYYY-MM" inclusive upper bound. */
  toMonth: string;
  /** Also bundle each month's proof pack (bills). */
  includeProof: boolean;
};

/**
 * Download a ZIP of the authenticated owner's POST-only statements across
 * [fromMonth, toMonth] (the portal "Download a range of statements" action). The
 * owner is ALWAYS the session — there is NO ownerPartyId param, so an owner can only
 * ever pull their own statements. Hits fetch directly (binary, not JSON) with the
 * portal bearer token, then triggers a browser download via a same-origin blob URL.
 * Throws PortalApiError on failure (incl. 404 for an empty range, 400 for from>to /
 * range>24mo — though the picker pre-checks those client-side). Mirrors
 * downloadPortalProofPack's auth + blob-download pattern.
 *
 * Binds to: GET /portal-api/owner/statements/export
 */
export async function downloadPortalMonthRange(
  args: PortalMonthRangeExportArgs,
): Promise<void> {
  const token = getPortalToken();
  const qs = new URLSearchParams({
    fromMonth: args.fromMonth,
    toMonth: args.toMonth,
    includeProof: args.includeProof ? "1" : "0",
  }).toString();
  const res = await fetch(portalApiUrl(`/owner/statements/export?${qs}`), {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      typeof body?.error === "string" ? body.error : `Download failed (${res.status})`;
    throw new PortalApiError(message, res.status, body);
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, `owner-statements-${args.fromMonth}_to_${args.toMonth}.zip`);
}
