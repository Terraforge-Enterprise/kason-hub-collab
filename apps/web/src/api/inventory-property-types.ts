import { apiFetch } from "@/lib/api-client";

export type PropertyType = {
  id: string;
  organizationId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PropertyTypeUsage = { propertyCount: number };

export async function listPropertyTypes(opts?: { activeOnly?: boolean }): Promise<PropertyType[]> {
  const qs = opts?.activeOnly ? "?activeOnly=true" : "";
  const res = await apiFetch<{ data: PropertyType[] }>(`/inventory/property-types${qs}`);
  return res.data;
}

export async function createPropertyType(body: { name: string; sortOrder?: number }): Promise<PropertyType> {
  const res = await apiFetch<{ data: PropertyType }>(`/inventory/property-types`, { method: "POST", body: JSON.stringify(body) });
  return res.data;
}

export async function updatePropertyType(id: string, body: { name?: string; sortOrder?: number; isActive?: boolean }): Promise<PropertyType> {
  const res = await apiFetch<{ data: PropertyType }>(`/inventory/property-types/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  return res.data;
}

export async function deletePropertyType(id: string): Promise<{ deleted: true }> {
  const res = await apiFetch<{ data: { deleted: true } }>(`/inventory/property-types/${id}`, { method: "DELETE" });
  return res.data;
}

export async function getPropertyTypeUsage(id: string): Promise<PropertyTypeUsage> {
  const res = await apiFetch<{ data: PropertyTypeUsage }>(`/inventory/property-types/${id}/usage`);
  return res.data;
}
