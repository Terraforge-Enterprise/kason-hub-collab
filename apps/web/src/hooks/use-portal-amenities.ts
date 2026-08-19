import { useQuery } from "@tanstack/react-query";
import { listPortalAmenities, type PortalAmenity } from "@/api/portal-inventory-amenities";

export const PORTAL_AMENITIES_KEY = ["portal", "inventory-amenities"] as const;

export function usePortalAmenities() {
  return useQuery({
    queryKey: PORTAL_AMENITIES_KEY,
    queryFn: listPortalAmenities,
    staleTime: 60_000,
  });
}

export type { PortalAmenity };
