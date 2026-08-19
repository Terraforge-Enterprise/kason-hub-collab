import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createAmenity,
  deleteAmenity,
  getAmenityUsage,
  listAmenities,
  updateAmenity,
} from "@/api/inventory-amenities";

export const AMENITIES_KEY = ["inventory", "amenities"] as const;
export const ACTIVE_AMENITIES_KEY = ["inventory", "amenities", "active"] as const;

const RELATED_INVALIDATE_KEYS = [
  AMENITIES_KEY,
  ACTIVE_AMENITIES_KEY,
  ["inventory-explorer"],
  ["portal-listings"],
] as const;

export function useAmenities() {
  return useQuery({
    queryKey: AMENITIES_KEY,
    queryFn: () => listAmenities(),
    staleTime: 30_000,
  });
}

export function useActiveAmenities() {
  return useQuery({
    queryKey: ACTIVE_AMENITIES_KEY,
    queryFn: () => listAmenities({ activeOnly: true }),
    staleTime: 60_000,
  });
}

export function useAmenityUsage(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["inventory", "amenities", id, "usage"],
    queryFn: () => getAmenityUsage(id!),
    enabled: enabled && !!id,
    staleTime: 0,
  });
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const key of RELATED_INVALIDATE_KEYS) {
    qc.invalidateQueries({ queryKey: key as readonly unknown[] });
  }
}

export function useCreateAmenity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; sortOrder?: number }) => createAmenity(body),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useUpdateAmenity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; sortOrder?: number; isActive?: boolean }) =>
      updateAmenity(id, body),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteAmenity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAmenity(id),
    onSuccess: () => invalidateAll(qc),
  });
}
