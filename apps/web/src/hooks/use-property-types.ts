import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPropertyType,
  deletePropertyType,
  getPropertyTypeUsage,
  listPropertyTypes,
  updatePropertyType,
} from "@/api/inventory-property-types";

export const PROPERTY_TYPES_KEY = ["inventory", "property-types"] as const;
export const ACTIVE_PROPERTY_TYPES_KEY = ["inventory", "property-types", "active"] as const;

const RELATED_INVALIDATE_KEYS = [PROPERTY_TYPES_KEY, ACTIVE_PROPERTY_TYPES_KEY] as const;

export function usePropertyTypes() {
  return useQuery({ queryKey: PROPERTY_TYPES_KEY, queryFn: () => listPropertyTypes(), staleTime: 30_000 });
}
// `opts.enabled` (default true) lets callers that mount persistently-but-closed
// (e.g. EditPropertyDialog, one per property row) defer the fetch until the
// dialog actually opens — mirrors the `enabled: open` pattern already used for
// the property detail query in that same component.
export function useActivePropertyTypes(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ACTIVE_PROPERTY_TYPES_KEY,
    queryFn: () => listPropertyTypes({ activeOnly: true }),
    staleTime: 60_000,
    enabled: opts?.enabled ?? true,
  });
}
export function usePropertyTypeUsage(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["inventory", "property-types", id, "usage"],
    queryFn: () => getPropertyTypeUsage(id!),
    enabled: enabled && !!id,
    staleTime: 0,
  });
}
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const key of RELATED_INVALIDATE_KEYS) qc.invalidateQueries({ queryKey: key as readonly unknown[] });
}
export function useCreatePropertyType() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: { name: string; sortOrder?: number }) => createPropertyType(body), onSuccess: () => invalidateAll(qc) });
}
export function useUpdatePropertyType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; sortOrder?: number; isActive?: boolean }) => updatePropertyType(id, body),
    onSuccess: () => invalidateAll(qc),
  });
}
export function useDeletePropertyType() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => deletePropertyType(id), onSuccess: () => invalidateAll(qc) });
}
