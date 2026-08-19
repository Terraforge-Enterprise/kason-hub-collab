import { portalApiFetch } from "@/lib/portal-api";

export type PortalOwner = {
  id: string;
  displayName: string;
  primaryPhone: string | null;
  /** API-pre-formatted display variant of `primaryPhone`. */
  formattedPhone: string | null;
  primaryEmail: string | null;
};

export function searchPortalOwners(q: string): Promise<{ data: PortalOwner[] }> {
  const qs = q.trim().length > 0 ? `?q=${encodeURIComponent(q.trim())}` : "";
  return portalApiFetch<{ data: PortalOwner[] }>(`/parties/owners${qs}`);
}

export type CreatePortalOwnerInput = {
  displayName: string;
  primaryPhone?: string;
  primaryEmail?: string;
};

export function createPortalOwner(
  input: CreatePortalOwnerInput,
): Promise<{ data: PortalOwner }> {
  return portalApiFetch<{ data: PortalOwner }>(`/parties/owners`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
