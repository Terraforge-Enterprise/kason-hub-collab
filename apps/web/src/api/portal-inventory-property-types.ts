import { portalApiFetch } from "@/lib/portal-api";

export type PortalPropertyType = { id: string; name: string; sortOrder: number };

export async function listPortalPropertyTypes(): Promise<PortalPropertyType[]> {
  const res = await portalApiFetch<{ data: PortalPropertyType[] }>("/inventory/property-types");
  return res.data;
}
