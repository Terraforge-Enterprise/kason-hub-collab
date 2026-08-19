import { useQuery } from "@tanstack/react-query";
import { listPortalPropertyTypes, type PortalPropertyType } from "@/api/portal-inventory-property-types";

export const PORTAL_PROPERTY_TYPES_KEY = ["portal", "inventory-property-types"] as const;

export function usePortalPropertyTypes() {
  return useQuery({ queryKey: PORTAL_PROPERTY_TYPES_KEY, queryFn: listPortalPropertyTypes, staleTime: 60_000 });
}

export type { PortalPropertyType };
