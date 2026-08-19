import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";
import type { ExistingClaimsOnKeyResponse } from "@kason/shared";

export function useExistingClaimsOnKey(input: {
  propertyId: string | null;
  unitCode: string;
  roomType: string;
  moveInDate: string;
}) {
  const enabled =
    !!input.propertyId && !!input.unitCode && !!input.roomType && !!input.moveInDate;
  return useQuery<ExistingClaimsOnKeyResponse>({
    queryKey: ["portal", "existing-on-key", input],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const qs = new URLSearchParams({
        propertyId: input.propertyId!,
        unitCode: input.unitCode,
        roomType: input.roomType,
        moveInDate: input.moveInDate,
      }).toString();
      const res = await portalApiFetch<{ data: ExistingClaimsOnKeyResponse }>(
        `/commissions/claims/existing-on-key?${qs}`,
      );
      return res.data;
    },
  });
}
