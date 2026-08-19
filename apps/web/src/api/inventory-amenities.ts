import { apiFetch } from "@/lib/api-client";

export type Amenity = {
  id: string;
  organizationId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AmenityUsage = {
  count: number;
  units: { id: string; unitCode: string; propertyName: string }[];
};

export async function listAmenities(opts?: { activeOnly?: boolean }): Promise<Amenity[]> {
  const qs = opts?.activeOnly ? "?activeOnly=true" : "";
  const res = await apiFetch<{ data: Amenity[] }>(`/inventory/amenities${qs}`);
  return res.data;
}

export async function createAmenity(body: { name: string; sortOrder?: number }): Promise<Amenity> {
  const res = await apiFetch<{ data: Amenity }>(`/inventory/amenities`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.data;
}

export async function updateAmenity(
  id: string,
  body: { name?: string; sortOrder?: number; isActive?: boolean }
): Promise<Amenity> {
  const res = await apiFetch<{ data: Amenity }>(`/inventory/amenities/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return res.data;
}

export async function deleteAmenity(id: string): Promise<{ affectedUnitCount: number }> {
  const res = await apiFetch<{ data: { affectedUnitCount: number } }>(`/inventory/amenities/${id}`, {
    method: "DELETE",
  });
  return res.data;
}

export async function getAmenityUsage(id: string): Promise<AmenityUsage> {
  const res = await apiFetch<{ data: AmenityUsage }>(`/inventory/amenities/${id}/usage`);
  return res.data;
}
