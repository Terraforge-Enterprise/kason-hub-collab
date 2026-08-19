import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";
import type { TaTierOptionsResponse } from "@kason/shared";

/**
 * Fetches all TA tier options for the calling agent's org. Drives the
 * "Charges by KAEN" dropdown on the agent claim form so it always reflects
 * admin-configured tier settings (no hardcoded list).
 */
export function useTaTierOptions() {
  return useQuery({
    queryKey: ["portal", "ta-tier-options"] as const,
    queryFn: async (): Promise<TaTierOptionsResponse> => {
      const res = await portalApiFetch<{ data: TaTierOptionsResponse }>(
        "/commissions/ta-tier-options",
      );
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 min — tiers change rarely (admin-configured)
  });
}
