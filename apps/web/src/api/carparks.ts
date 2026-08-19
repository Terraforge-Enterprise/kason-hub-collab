// Typed react-query hooks for carpark-bay management (carpark redesign Task 2.2).
// Routes are mounted at /api/carparks; apiFetch prepends /api, so paths here
// start with /carparks.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";

// ─── Row type ─────────────────────────────────────────────────────────────────
// Mirrors apps/api/src/modules/carpark/carpark.service.ts (CarparkRow).
export type CarparkRow = {
  id: string;
  label: string;
  /** Decimal.toString() — e.g. "350.00" */
  monthlyRate: string;
  /** "available" | "rented" | "inactive" */
  status: string;
  apartmentId: string;
  propertyId: string;
  ownerPartyId: string | null;
  /** Resolved from the apartment's owner Party.displayName. null = no owner set. */
  ownerName: string | null;
};

// ─── Body types ───────────────────────────────────────────────────────────────

export type CreateCarparkBody = {
  apartmentId: string;
  label: string;
  /** Decimal-as-string — e.g. "350.00" (matches Tenancy.monthlyRentAmount edge). */
  monthlyRate: string;
  notes?: string;
};

export type UpdateCarparkBody = {
  label?: string;
  monthlyRate?: string;
  status?: "available" | "rented" | "inactive";
  notes?: string;
};

// ─── Query keys ───────────────────────────────────────────────────────────────

export const CARPARKS_KEY = ["carparks"] as const;

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** List active bays for a given apartment. Disabled until apartmentId is provided. */
export function useCarparksByApartment(apartmentId: string | undefined) {
  return useQuery({
    queryKey: [...CARPARKS_KEY, "by-apartment", apartmentId ?? null],
    queryFn: () =>
      apiFetch<{ data: CarparkRow[] }>(
        `/carparks?apartmentId=${encodeURIComponent(apartmentId!)}`,
      ),
    enabled: !!apartmentId,
  });
}

/** List available bays across a property (for tenancy assignment picker). */
export function useAvailableCarparksByProperty(propertyId: string | undefined) {
  return useQuery({
    queryKey: [...CARPARKS_KEY, "available", propertyId ?? null],
    queryFn: () =>
      apiFetch<{ data: CarparkRow[] }>(
        `/carparks/available?propertyId=${encodeURIComponent(propertyId!)}`,
      ),
    enabled: !!propertyId,
  });
}

/** Register a new carpark bay under the given apartment. Returns 201 + { id }. */
export function useCreateCarpark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCarparkBody) =>
      apiFetch<{ data: { id: string } }>("/carparks", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CARPARKS_KEY }),
  });
}

/** Update a bay's label, monthly rate, status, or notes. */
export function useUpdateCarpark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateCarparkBody & { id: string }) =>
      apiFetch<{ data: { id: string } }>(`/carparks/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CARPARKS_KEY }),
  });
}

/** Deactivate a bay. 409 if an active assignment exists (must release first). */
export function useDeactivateCarpark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (carparkId: string) =>
      apiFetch<{ data: { id: string } }>(`/carparks/${carparkId}/deactivate`, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CARPARKS_KEY }),
  });
}
