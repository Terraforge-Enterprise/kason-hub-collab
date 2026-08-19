import { apiFetch } from "@/lib/api-client";

// Patch shape mirrors apps/api/src/modules/reservations/validation.ts:adminEditReservationSchema.
// Every field is optional — admin only sends the columns they're changing.
// customTerms is the array of T&C clauses shown verbatim on the signed PDF;
// admins can now edit this list (added in client feedback batch 1 / D5).
export interface AdminEditReservationPatch {
  carPark?: string | null;
  proposedMoveIn?: string;
  proposedMoveOut?: string | null;
  specialRemarks?: string | null;
  reservationDeposit?: string;
  documentationFee?: string;
  rentalDeposit?: string;
  utilityDeposit?: string;
  accessCardDeposit?: string;
  applicantFullName?: string;
  applicantNric?: string;
  applicantContact?: string;
  applicantEmail?: string;
  customTerms?: string[];
}

export async function adminEditReservation(
  id: string,
  patch: AdminEditReservationPatch,
  reason: string,
): Promise<{ id: string }> {
  const res = await apiFetch<{ data: { id: string } }>(
    `/admin/reservations/${id}/admin-edit`,
    {
      method: "PATCH",
      body: JSON.stringify({ patch, reason }),
    },
  );
  return res.data;
}

export interface EditHistoryEntry {
  id: string;
  createdAt: string;
  actorName: string;
  reason: string;
}

export async function getReservationEditHistory(
  id: string,
): Promise<{ entries: EditHistoryEntry[] }> {
  const res = await apiFetch<{ data: { entries: EditHistoryEntry[] } }>(
    `/admin/reservations/${id}/edit-history`,
  );
  return res.data;
}
