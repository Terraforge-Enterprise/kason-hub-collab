import { portalApiFetch } from "@/lib/portal-api";

export type PortalAmenity = { id: string; name: string; sortOrder: number };

export async function listPortalAmenities(): Promise<PortalAmenity[]> {
  const res = await portalApiFetch<{ data: PortalAmenity[] }>("/inventory/amenities");
  return res.data;
}
