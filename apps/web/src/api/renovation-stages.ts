import { apiFetch } from "@/lib/api-client";

export type AdminRenovationStage = {
  id: string;
  organizationId: string;
  key: string;
  label: string;
  description: string | null;
  sortOrder: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export function listRenovationStages(includeArchived = false): Promise<{ data: AdminRenovationStage[] }> {
  const qs = includeArchived ? "?includeArchived=true" : "";
  return apiFetch<{ data: AdminRenovationStage[] }>(`/renovation-stages${qs}`);
}

export type CreateStageInput = {
  label: string;
  description?: string;
  sortOrder?: number;
};

export function createRenovationStage(input: CreateStageInput): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>("/renovation-stages", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type UpdateStageInput = {
  label?: string;
  description?: string | null;
  sortOrder?: number;
  archived?: boolean;
};

export function updateRenovationStage(
  id: string,
  input: UpdateStageInput,
): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>(`/renovation-stages/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function reorderRenovationStages(
  items: Array<{ id: string; sortOrder: number }>,
): Promise<{ data: { count: number } }> {
  return apiFetch<{ data: { count: number } }>("/renovation-stages/reorder", {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}
