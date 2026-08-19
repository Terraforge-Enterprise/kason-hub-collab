// Admin-side typed client for the property sourcing queue endpoints.
// Mirrors the unit /listings/:id/approve / reject pattern; gated server-side
// to manager+.
import { apiFetch } from "@/lib/api-client";

export type PendingSourcedProperty = {
  id: string;
  name: string;
  propertyCode: string;
  propertyType: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string | null;
  postalCode: string | null;
  country: string;
  status: string;
  sourcingAmendmentNote: string | null;
  sourcingAgent: { id: string; displayName: string } | null;
  createdAt: string;
};

export async function listPendingSourcedProperties(): Promise<
  PendingSourcedProperty[]
> {
  const res = await apiFetch<{ data: PendingSourcedProperty[] }>(
    "/inventory/properties/source-queue",
  );
  return res.data;
}

export async function approveSourcedProperty(
  id: string,
): Promise<{ id: string }> {
  const res = await apiFetch<{ data: { id: string } }>(
    `/inventory/properties/${id}/approve`,
    { method: "POST" },
  );
  return res.data;
}

export async function rejectSourcedProperty(
  id: string,
  note: string,
): Promise<{ id: string }> {
  const res = await apiFetch<{ data: { id: string } }>(
    `/inventory/properties/${id}/reject`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
  return res.data;
}
