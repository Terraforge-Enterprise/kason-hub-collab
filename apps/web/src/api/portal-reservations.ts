import { portalApiFetch } from "@/lib/portal-api";
import type { ReservationDto, ReservationStatus } from "./reservations";

export type { ReservationDto, ReservationStatus } from "./reservations";

export type CreateReservationPayload = {
  propertyId: string;
  unitId: string;
  carPark: string | null;
  proposedMoveIn: string;
  proposedMoveOut: string | null;
  specialRemarks: string | null;
  reservationDeposit: string;
  documentationFee: string;
  rentalDeposit: string;
  utilityDeposit: string;
  accessCardDeposit: string;
  agreedMonthlyRent: string;
  customerEmail: string;
  customTerms: string[];
};

export async function listPortalReservations(): Promise<ReservationDto[]> {
  const res = await portalApiFetch<{ data: ReservationDto[] }>("/reservations");
  return res.data;
}

export async function getPortalReservation(id: string): Promise<ReservationDto> {
  const res = await portalApiFetch<{ data: ReservationDto }>(`/reservations/${id}`);
  return res.data;
}

export async function createPortalReservation(payload: CreateReservationPayload) {
  const res = await portalApiFetch<{
    data: { id: string; referenceCode: string; publicToken: string; expiresAt: string; status: ReservationStatus };
  }>("/reservations", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.data;
}

export async function cancelPortalReservation(id: string, cancelReason: string) {
  return portalApiFetch<{ data: { id: string; status: "cancelled" } }>(
    `/reservations/${id}/cancel`,
    {
      method: "PUT",
      body: JSON.stringify({ cancelReason }),
    },
  );
}

export type EligibleReservationUnit = {
  id: string;
  unitCode: string;
  unitType: string;
  bedrooms: number | null;
  sourcingAgentId: string | null;
  property: { id: string; name: string; propertyCode: string };
};

export async function listEligibleReservationUnits(): Promise<EligibleReservationUnit[]> {
  const res = await portalApiFetch<{ data: EligibleReservationUnit[] }>(
    "/reservations/eligible-units",
  );
  return res.data;
}

// Mirrors apps/api/src/modules/reservations/validation.ts:resubmitReservationSchema.
// Every field except customTerms is optional. customTerms always sent — `[]`
// means "use bundled defaults". D5 (client feedback batch 1) extended this
// from customTerms-only to the full editable field set so the agent can fix
// any typo from one dialog.
export interface ResubmitPortalReservationPayload {
  customTerms: string[];
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
  reason?: string;
}

export async function resubmitPortalReservation(
  id: string,
  payload: ResubmitPortalReservationPayload,
) {
  return portalApiFetch<{ data: { id: string; status: string } }>(
    `/reservations/${id}/resubmit`,
    { method: "PUT", body: JSON.stringify(payload) },
  );
}
