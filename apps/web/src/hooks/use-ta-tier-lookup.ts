import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";
import type { TaTierLookupResponse } from "@kason/shared";

export function useTaTierLookup(monthlyRental: string | null | undefined) {
  return useQuery({
    queryKey: ["portal", "ta-tier", monthlyRental] as const,
    enabled: Boolean(monthlyRental && Number(monthlyRental) > 0),
    queryFn: async (): Promise<TaTierLookupResponse> => {
      const res = await portalApiFetch<{ data: TaTierLookupResponse }>(
        `/commissions/ta-tier?monthlyRental=${encodeURIComponent(monthlyRental!)}`,
      );
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 min
  });
}
