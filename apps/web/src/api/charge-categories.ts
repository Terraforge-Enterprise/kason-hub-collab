// apps/web/src/api/charge-categories.ts
// ChargeCategory registry + DocumentSeries hooks (accounting-docs P1).
// Endpoint is flag-gated ENABLE_PHASE2_BILLING_DOCS (404 while dark) — callers
// pass `enabled: false` when the VITE_ flag is off so no dead fetch fires.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import type {
  ChargeCategoryDto,
  CreateChargeCategoryInput,
  DocumentSeriesDto,
  UpdateChargeCategoryInput,
  UpdateDocumentSeriesInput,
} from "@kason/shared";

export const CHARGE_CATEGORIES_KEY = ["charge-categories"] as const;

export function useChargeCategories(opts: { includeInactive?: boolean; enabled?: boolean } = {}) {
  const includeInactive = !!opts.includeInactive;
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: [...CHARGE_CATEGORIES_KEY, "list", { includeInactive }],
    queryFn: () =>
      apiFetch<{ items: ChargeCategoryDto[] }>(
        `/charge-categories${includeInactive ? "?includeInactive=true" : ""}`,
      ),
  });
}

export function useDocumentSeries(opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: [...CHARGE_CATEGORIES_KEY, "series"],
    queryFn: () => apiFetch<{ items: DocumentSeriesDto[] }>("/charge-categories/series"),
  });
}

export function useCreateChargeCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateChargeCategoryInput) =>
      apiFetch<{ data: ChargeCategoryDto }>("/charge-categories", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHARGE_CATEGORIES_KEY }),
  });
}

export function useUpdateChargeCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateChargeCategoryInput & { id: string }) =>
      apiFetch<{ data: ChargeCategoryDto }>(`/charge-categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHARGE_CATEGORIES_KEY }),
  });
}

export function useDeactivateChargeCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: ChargeCategoryDto }>(`/charge-categories/${id}/deactivate`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHARGE_CATEGORIES_KEY }),
  });
}

export function useUpdateDocumentSeries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateDocumentSeriesInput & { id: string }) =>
      apiFetch<{ data: DocumentSeriesDto }>(`/charge-categories/series/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHARGE_CATEGORIES_KEY }),
  });
}
