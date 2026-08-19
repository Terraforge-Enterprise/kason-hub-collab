import { apiFetch } from "@/lib/api-client";

export interface OrganizationProfile {
  id: string;
  name: string;
}

export async function getOrganizationProfile(): Promise<OrganizationProfile> {
  const res = await apiFetch<{ data: OrganizationProfile }>("/organization/profile");
  return res.data;
}

export async function updateOrganizationProfile(input: {
  name: string;
}): Promise<OrganizationProfile> {
  const res = await apiFetch<{ data: OrganizationProfile }>(
    "/organization/profile",
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return res.data;
}
