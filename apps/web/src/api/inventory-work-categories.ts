import { apiFetch } from "@/lib/api-client";

export type WorkCategory = {
  id: string;
  organizationId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkCategoryUsage = {
  ticketCount: number;
  taskCount: number;
};

export async function listWorkCategories(opts?: { activeOnly?: boolean }): Promise<WorkCategory[]> {
  const qs = opts?.activeOnly ? "?activeOnly=true" : "";
  const res = await apiFetch<{ data: WorkCategory[] }>(`/inventory/work-categories${qs}`);
  return res.data;
}

export async function createWorkCategory(body: { name: string; sortOrder?: number }): Promise<WorkCategory> {
  const res = await apiFetch<{ data: WorkCategory }>(`/inventory/work-categories`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.data;
}

export async function updateWorkCategory(
  id: string,
  body: { name?: string; sortOrder?: number; isActive?: boolean }
): Promise<WorkCategory> {
  const res = await apiFetch<{ data: WorkCategory }>(`/inventory/work-categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return res.data;
}

export async function deleteWorkCategory(id: string): Promise<{ deleted: true }> {
  const res = await apiFetch<{ data: { deleted: true } }>(`/inventory/work-categories/${id}`, {
    method: "DELETE",
  });
  return res.data;
}

export async function getWorkCategoryUsage(id: string): Promise<WorkCategoryUsage> {
  const res = await apiFetch<{ data: WorkCategoryUsage }>(`/inventory/work-categories/${id}/usage`);
  return res.data;
}
