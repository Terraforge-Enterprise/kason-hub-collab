/**
 * Parties detail API hooks — tenant and owner full-record fetchers.
 *
 * These hooks are `enabled`-gated so they only fire when the expand-panel is
 * open (callers pass `enabled=true` once the row expands). They intentionally
 * mirror the `useAgentDetail` pattern from `use-agent-detail.ts`.
 *
 * The server returns `idNumberMasked` (last-4 only, e.g. "••••1234") and
 * never exposes `idNumber` in these endpoints. Unmasked reveal goes through
 * the audited `/parties/:partyId/ic-reveal` path (see `IcRevealField`).
 *
 * NOTE: `updatedAt` is deliberately absent from both types — the detail
 * endpoints do not include it (spec requirement: avoids staleness confusion
 * between server-side timestamps and optimistic UI state).
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import type { IcRevealResponse } from "@kason/shared";
import { apiFetch } from "@/lib/api-client";

// ── TenantDetail ─────────────────────────────────────────────────────────────

/**
 * Full tenant record returned by `GET /api/parties/tenants/:id`.
 * Mirrors `getTenantDetailService` in `apps/api/src/modules/parties/parties.service.ts`.
 */
export type TenantDetail = {
  id: string;
  displayName: string;
  legalName: string | null;
  primaryEmail: string | null;
  /** Canonical E.164 phone. Prefer `formattedPhone` for display. */
  primaryPhone: string | null;
  /** API-pre-formatted display value (e.g. "+60 12-345 6789"). */
  formattedPhone: string | null;
  whatsappPhone: string | null;
  idType: string | null;
  /** Last-4 masked (e.g. "••••1234"). Raw IC never included. */
  idNumberMasked: string | null;
  nationality: string | null;
  gender: string | null;
  /** ISO 8601 date string or null. */
  dateOfBirth: string | null;
  occupation: string | null;
  employerName: string | null;
  employerAddress: string | null;
  /** Stringified decimal (server converts Prisma Decimal → string). */
  monthlyIncome: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelation: string | null;
  isBlacklisted: boolean;
  blacklistReason: string | null;
  status: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /**
   * True when the tenant has at least one Tenancy row with status="active".
   * The portal login gate requires an active tenancy, so this drives the
   * "no active tenancy — portal login will fail" warning in the grant UI.
   */
  hasActiveTenancy: boolean;
  tenancyHistory?: Array<{
    id: string;
    tenancyCode: string;
    propertyName: string;
    unitCode: string;
    status: string;
    billingStatus: string;
    startDate: string;
    endDate: string | null;
    monthlyRentAmount: string;
  }>;
  depositLedger?: Array<{
    id: string;
    chargeNumber: string;
    type: "rental" | "utilities";
    expected: string;
    collected: string;
    outstanding: string;
    ownerTransferred: string;
    dueDate: string;
    tenancyCode: string;
    propertyName: string;
    unitCode: string;
  }>;
  portalUser: {
    email: string;
    status: string;
    lastLoginAt: string | null;
    updatedAt: string;
  } | null;
};

// ── OwnerDetail ───────────────────────────────────────────────────────────────

/**
 * Full owner record returned by `GET /api/parties/owners/:id`.
 * Mirrors `getOwnerDetailService` in `apps/api/src/modules/parties/parties.service.ts`.
 */
export type OwnerDetail = {
  id: string;
  displayName: string;
  legalName: string | null;
  primaryEmail: string | null;
  /** Canonical E.164 phone. Prefer `formattedPhone` for display. */
  primaryPhone: string | null;
  /** API-pre-formatted display value (e.g. "+60 12-345 6789"). */
  formattedPhone: string | null;
  whatsappPhone: string | null;
  idType: string | null;
  /** Last-4 masked (e.g. "••••1234"). Raw IC never included. */
  idNumberMasked: string | null;
  nationality: string | null;
  gender: string | null;
  /** ISO 8601 date string or null. */
  dateOfBirth: string | null;
  occupation: string | null;
  employerName: string | null;
  employerAddress: string | null;
  /** Stringified decimal (server converts Prisma Decimal → string). */
  monthlyIncome: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelation: string | null;
  isBlacklisted: boolean;
  blacklistReason: string | null;
  status: string;
  bank: {
    name: string | null;
    accountHolder: string | null;
    accountNumber: string | null;
  };
  /**
   * DISTINCT apartments owned by this party, each labelled with its property.
   * Deduped server-side (findUnitsOwned): an apartment with many listings
   * (partitioned rooms + carpark slots) appears ONCE, not once per listing.
   * invariant: propertyName is always present (Apartment→Property is required).
   */
  unitsOwned: { apartmentId: string; unitCode: string; propertyName: string }[];
  /** ISO 8601 timestamp. */
  createdAt: string;
  portalUser: {
    email: string;
    status: string;
    lastLoginAt: string | null;
    updatedAt: string;
  } | null;
};

// ── IC Reveal ─────────────────────────────────────────────────────────────────

/**
 * Audited IC reveal for any party (tenant OR owner).
 *
 * POSTs to `POST /api/parties/:partyId/ic-reveal` — NOT flag-gated,
 * uses the same `recordIcRevealService` as the tenant-tracker path,
 * so the response shape `{ partyId, idNumber }` and the audit trail
 * are identical.
 *
 * Deliberately performs NO cache writes: the unmasked IC must never
 * enter React Query's cache. Every reveal hits the server.
 */
export function useRevealPartyIc() {
  return useMutation({
    mutationFn: (input: { partyId: string }) =>
      apiFetch<IcRevealResponse>(`/parties/${input.partyId}/ic-reveal`, {
        method: "POST",
      }),
  });
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/**
 * Fetches the full tenant record. Pass `enabled=false` (or omit the id) when
 * the expand-panel is collapsed so that no request fires until the user opens
 * the row.
 *
 * @param id      - party UUID; query is disabled when undefined/empty.
 * @param enabled - additional gate (e.g. `isExpanded`). Combined with `!!id`.
 */
export function useTenantDetail(id: string | undefined, enabled: boolean) {
  return useQuery<TenantDetail>({
    queryKey: ["parties", "tenants", id],
    queryFn: async () => {
      const res = await apiFetch<{ data: TenantDetail }>(`/parties/tenants/${id}`);
      return res.data;
    },
    enabled: !!id && enabled,
    staleTime: 30_000,
  });
}

/**
 * Fetches the full owner record. Same enabled-gating contract as
 * `useTenantDetail`.
 *
 * @param id      - party UUID; query is disabled when undefined/empty.
 * @param enabled - additional gate (e.g. `isExpanded`). Combined with `!!id`.
 */
export function useOwnerDetail(id: string | undefined, enabled: boolean) {
  return useQuery<OwnerDetail>({
    queryKey: ["parties", "owners", id],
    queryFn: async () => {
      const res = await apiFetch<{ data: OwnerDetail }>(`/parties/owners/${id}`);
      return res.data;
    },
    enabled: !!id && enabled,
    staleTime: 30_000,
  });
}
