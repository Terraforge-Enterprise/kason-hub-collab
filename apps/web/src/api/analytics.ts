// react-query hooks for the Unit Analytics module (Spec 2).
// Consumed by: C2 unit-analytics page, C4 per-unit mini-stat.
import { useQuery } from "@tanstack/react-query";
import type {
  AnalyticsQueryInput,
  AnalyticsWindow,
  CategoryLensRow,
  TrendPoint,
  UnitMiniStat,
  UnitsAnalyticsResponse,
} from "@kason/shared";
import { apiFetch } from "@/lib/api-client";
import { sanitizeFilters, toQueryString } from "@/api/_query";

export const ANALYTICS_KEY = ["analytics"] as const;

export function useUnitAnalytics(filters: Partial<AnalyticsQueryInput> = {}) {
  const s = sanitizeFilters(filters);
  return useQuery({
    queryKey: [...ANALYTICS_KEY, "units", s],
    queryFn: () => apiFetch<{ data: UnitsAnalyticsResponse }>(`/analytics/units${toQueryString(s)}`),
    placeholderData: (p) => p,
  });
}

export function useCategoryLens(filters: Partial<AnalyticsQueryInput> = {}) {
  const s = sanitizeFilters(filters);
  return useQuery({
    queryKey: [...ANALYTICS_KEY, "categories", s],
    queryFn: () => apiFetch<{ data: CategoryLensRow[] }>(`/analytics/categories${toQueryString(s)}`),
    placeholderData: (p) => p,
  });
}

export function useAnalyticsTrend(filters: Partial<AnalyticsQueryInput> = {}) {
  const s = sanitizeFilters(filters);
  return useQuery({
    queryKey: [...ANALYTICS_KEY, "trend", s],
    queryFn: () => apiFetch<{ data: TrendPoint[] }>(`/analytics/trend${toQueryString(s)}`),
    placeholderData: (p) => p,
  });
}

export function useUnitMiniStat(unitId: string, window: AnalyticsWindow = "12mo") {
  return useQuery({
    queryKey: [...ANALYTICS_KEY, "unit", unitId, window],
    queryFn: () => apiFetch<{ data: UnitMiniStat }>(`/analytics/units/${unitId}?window=${window}`),
    enabled: Boolean(unitId),
  });
}
