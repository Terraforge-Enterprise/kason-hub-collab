import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWorkCategory,
  deleteWorkCategory,
  getWorkCategoryUsage,
  listWorkCategories,
  updateWorkCategory,
} from "@/api/inventory-work-categories";

export const WORK_CATEGORIES_KEY = ["inventory", "work-categories"] as const;
export const ACTIVE_WORK_CATEGORIES_KEY = ["inventory", "work-categories", "active"] as const;

const RELATED_INVALIDATE_KEYS = [
  WORK_CATEGORIES_KEY,
  ACTIVE_WORK_CATEGORIES_KEY,
  ["tasks"],
  ["unit-tickets"],
] as const;

export function useWorkCategories() {
  return useQuery({
    queryKey: WORK_CATEGORIES_KEY,
    queryFn: () => listWorkCategories(),
    staleTime: 30_000,
  });
}

export function useActiveWorkCategories() {
  return useQuery({
    queryKey: ACTIVE_WORK_CATEGORIES_KEY,
    queryFn: () => listWorkCategories({ activeOnly: true }),
    staleTime: 60_000,
  });
}

export function useWorkCategoryUsage(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["inventory", "work-categories", id, "usage"],
    queryFn: () => getWorkCategoryUsage(id!),
    enabled: enabled && !!id,
    staleTime: 0,
  });
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const key of RELATED_INVALIDATE_KEYS) {
    qc.invalidateQueries({ queryKey: key as readonly unknown[] });
  }
}

export function useCreateWorkCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; sortOrder?: number }) => createWorkCategory(body),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useUpdateWorkCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; sortOrder?: number; isActive?: boolean }) =>
      updateWorkCategory(id, body),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteWorkCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWorkCategory(id),
    onSuccess: () => invalidateAll(qc),
  });
}
