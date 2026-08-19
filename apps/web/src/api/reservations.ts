import { apiFetch } from "@/lib/api-client";

export type ReservationStatus =
  | "pending_approval"
  | "needs_amendment"
  | "pending_customer"
  | "signed"
  | "cancelled"
  | "expired";

export type ReservationDto = {
  id: string;
  referenceCode: string;
  status: ReservationStatus;
  issuedAt: string;
  expiresAt: string;
  property: { id: string; name: string };
  unit: { id: string; unitCode: string };
  carPark: string | null;
  proposedMoveIn: string;
  proposedMoveOut: string | null;
  specialRemarks: string | null;
  charges: {
    reservationDeposit: string;
    documentationFee: string;
    rentalDeposit: string;
    utilityDeposit: string;
    accessCardDeposit: string;
  };
  agreedMonthlyRent: string | null;
  applicant: {
    fullName: string | null;
    nric: string | null;
    contact: string | null;
    email: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postcode: string | null;
    state: string | null;
    country: string | null;
    nationality: string | null;
    occupation: string | null;
    monthlyIncome: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
    emergencyContactRelation: string | null;
  };
  documents: { id: string; kind: string; filename: string; uploadedAt: string }[];
  signedAt: string | null;
  signedPdfDownloadUrl: string | null;
  customTerms: string[];
  approvalNote: string | null;
  publicToken?: string;
};

export async function listReservations(): Promise<ReservationDto[]> {
  const res = await apiFetch<{ data: ReservationDto[] }>("/admin/reservations");
  return res.data;
}

// Picker source for the tenant-create "from reservation" flow (T11). Only
// SIGNED reservations not yet linked to a tenant are returned. NRIC is
// MASKED here (`nricMasked`) — the backend never sends the raw IC on this
// endpoint, so a prefilled "ID number" field cannot be sourced from it (see
// CreateTenantDialog's hint text, which surfaces the masked value and asks
// the admin to key in the full IC manually).
export type PickableReservationDto = {
  id: string;
  referenceCode: string;
  applicant: {
    fullName: string | null;
    nricMasked: string | null;
    contact: string | null;
    email: string | null;
  };
  proposedMoveIn: string;
  proposedMoveOut: string | null;
  agreedMonthlyRent: string | null;
  unit: { label: string };
};

export async function listPickableReservations(): Promise<PickableReservationDto[]> {
  const res = await apiFetch<{ data: PickableReservationDto[] }>("/admin/reservations/pickable");
  return res.data;
}

// Tenant-driven auto-derive source (T13/R5). Resolves the SELECTED TENANT's
// own signed, not-yet-converted reservation (if any) — the assign form uses
// this to derive tenancy terms from the reservation actually linked to that
// tenant, instead of trusting a free-pick reservation select that could
// belong to an unrelated applicant. `null` covers every "not currently
// derivable" case (untagged tenant, already converted, not yet signed, or no
// linked reservation at all) uniformly.
export async function getTenantLinkedReservation(
  tenantPartyId: string,
): Promise<PickableReservationDto | null> {
  const res = await apiFetch<{ data: PickableReservationDto | null }>(
    `/admin/reservations/linked-to-tenant/${tenantPartyId}`,
  );
  return res.data;
}

export async function getReservation(id: string): Promise<ReservationDto> {
  const res = await apiFetch<{ data: ReservationDto }>(`/admin/reservations/${id}`);
  return res.data;
}

export async function cancelReservation(id: string, cancelReason: string) {
  return apiFetch<{ data: { id: string; status: "cancelled" } }>(
    `/admin/reservations/${id}/cancel`,
    {
      method: "PUT",
      body: JSON.stringify({ cancelReason }),
    },
  );
}

export async function approveReservation(id: string) {
  return apiFetch<{ data: { id: string; status: "pending_customer" } }>(
    `/admin/reservations/${id}/approve`,
    { method: "PUT", body: JSON.stringify({}) },
  );
}

export async function rejectReservation(id: string, note: string) {
  return apiFetch<{ data: { id: string; status: "needs_amendment" } }>(
    `/admin/reservations/${id}/reject`,
    { method: "PUT", body: JSON.stringify({ note }) },
  );
}

export async function getReservationDocViewUrl(
  id: string,
  docId: string,
): Promise<{ url: string; expiresAt: string }> {
  const res = await apiFetch<{ data: { url: string; expiresAt: string } }>(
    `/admin/reservations/${id}/documents/${docId}/view-url`,
  );
  return res.data;
}
