import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { TRACKER_KEY_BASE } from "@/api/tenant-tracker";
import type {
  BillingGridResponse,
  ChargeUtilityBillInput,
  CockpitResponse,
  CreateReadingInput,
  CreateUtilityBillInput,
  AllocationLine,
} from "@kason/shared";

// Second hand-copy of the same shape (see bills-grid.ts). Aliased to the shared
// declaration so the engine, the grid client and this one cannot disagree.
export type PreviewAllocation = AllocationLine;
export type PaxlessRoom = { unitId: string; unitCode: string | null; listingType: string | null };
export type PreviewResult = {
  billId: string; allocations: PreviewAllocation[];
  totalAircond: number; leftoverTnb: number; sharedPool: number; totalPax: number;
  ownerAttributableAircond: number; roundingResidual: number;
  // Rooms with an active tenancy but no pax recorded — a charge blocker
  // surfaced by previewUtilityBillService (Phase 4) so the page can warn. Now
  // carries the room label so the warning names "A-08-02 · master", not a UUID.
  paxlessActiveRooms?: PaxlessRoom[];
  // Aircond billing fields (M2): owner-borne summary and subsidy coverage.
  subsidyCovered?: number;
  ownerBorneUtilities?: number; // Σ owner-borne indah/cleaning/wifi (left out of the tenant pool)
  ownerBorneUtilitiesTotal?: number;
};

export function useUtilityBill(id: string | null) {
  return useQuery({ enabled: !!id, queryKey: ["meter", "bill", id], queryFn: () => apiFetch<unknown>(`/meter/utility-bills/${id}`) });
}
export function useCreateReading() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: CreateReadingInput) => apiFetch("/meter/readings", { method: "POST", body: JSON.stringify(body) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["meter"] }) });
}
export function useCreateUtilityBill() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: CreateUtilityBillInput) => apiFetch<{ id: string }>("/meter/utility-bills", { method: "POST", body: JSON.stringify(body) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["meter"] }) });
}
export function useChargeUtilityBill(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: ChargeUtilityBillInput) => apiFetch(`/meter/utility-bills/${id}/charge`, { method: "POST", body: JSON.stringify(body) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["meter"] }) });
}

/**
 * Void a charged utility bill — POST /meter/utility-bills/:id/void. Reason is
 * mandatory once ENABLE_PHASE2_BILLING_DOCS is on (server enforces min-3-char
 * body); flag-dark call sites pass an empty-string reason for compatibility.
 * Invalidates both the meter cache family (billing grid/cockpit) and the
 * tenant-tracker cache (the workspace's grid reads via TRACKER_KEY_BASE).
 */
export function useVoidUtilityBill(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { reason: string }) =>
      apiFetch(`/meter/utility-bills/${id}/void`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meter"] });
      qc.invalidateQueries({ queryKey: TRACKER_KEY_BASE });
    },
  });
}

// ── ElectricityMeter config + reading management hooks ───────────────────────
// One row from `GET /api/meter` (the flattened AircondMeter). ratePerKwh is the
// Prisma Decimal serialized as a string (e.g. "0.6000"); updatedAt is the
// optimistic-concurrency token PATCH /meter/:id checks via expectedUpdatedAt.
export type MeterRow = {
  id: string;
  unitId: string;
  meterNumber: string | null;
  ratePerKwh: string;
  isActive: boolean;
  updatedAt: string;
};
type MeterListResponse = { data: MeterRow[]; nextCursor: string | null };

/**
 * On-demand lookup of a room's ACTIVE meter via the existing audited
 * `GET /api/meter?unitId=…&isActive=1` read — used by the tenant tracker's
 * inline rate affordance to source `{id, ratePerKwh, updatedAt}` WITHOUT adding
 * a field to the tracker contract. `enabled` gates the fetch so the request
 * fires only when a manager actually opens the rate (one meter per unit, so we
 * take the first row). Shares the `["meter"]` key family, so a rate PATCH
 * (useUpdateMeter) invalidates and refetches it.
 */
export function useUnitMeter(unitId: string, enabled: boolean) {
  return useQuery({
    enabled: enabled && !!unitId,
    queryKey: ["meter", "meters", { unitId, isActive: "1" }],
    queryFn: async (): Promise<MeterRow | null> => {
      const res = await apiFetch<MeterListResponse>(
        `/meter?${new URLSearchParams({ unitId, isActive: "1" }).toString()}`,
      );
      return res.data[0] ?? null;
    },
  });
}

export function useUpdateMeter(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: { ratePerKwh?: string; meterNumber?: string | null; expectedUpdatedAt?: string }) => apiFetch(`/meter/${id}`, { method: "PATCH", body: JSON.stringify(body) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["meter"] }) });
}
// Create an AircondMeter for a room that has none yet — POST /meter (manager-only,
// mirrors PATCH /:id). Lets the bills-grid Setting drawer SET a rate on a room whose
// rate is currently the lazy 0.6 default (rateConfigured:false), where PATCH has no
// meter id to target. Shares the ["meter"] key so useUnitMeter refetches the new row.
export function useCreateMeter() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: { unitId: string; ratePerKwh?: string }) => apiFetch<{ id: string }>("/meter", { method: "POST", body: JSON.stringify(body) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["meter"] }) });
}
export function useUpdateReadingById() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; previousReading?: string; currentReading?: string; ratePerKwh?: string }) =>
      apiFetch(`/meter/readings/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["meter"] }),
  });
}
/**
 * Set a tenancy's billing headcount (Tenancy.numberOfPax) inline from the bill
 * workspace — `PATCH /meter/tenancies/:tenancyId/pax`. Invalidates the
 * ["meter"] family so the billing grid refetches with the new pax and the
 * preview recomputes the per-pax split (Bug A). Lives in the meter module
 * because the endpoint does and the cache family it refreshes is ["meter"].
 */
export function useSetTenancyPax() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tenancyId, numberOfPax }: { tenancyId: string; numberOfPax: number }) =>
      apiFetch(`/meter/tenancies/${tenancyId}/pax`, { method: "PATCH", body: JSON.stringify({ numberOfPax }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meter"] });
      qc.invalidateQueries({ queryKey: TRACKER_KEY_BASE });
    },
  });
}

export function useBillingGrid(apartmentId: string, period: string | undefined) {
  const url = `/meter/apartments/${apartmentId}/billing-grid${period ? `?period=${period}` : ""}`;
  return useQuery<BillingGridResponse>({ enabled: !!apartmentId, queryKey: ["meter", "billing-grid", apartmentId, period], queryFn: () => apiFetch<BillingGridResponse>(url) });
}

// ── Month cockpit (portfolio-wide per-period progress + worklist, §4.1/§4.6) ──
// Read-only; `period` is a YYYY-MM-DD first-of-month. Omit it to let the server
// default to the current month. `enabled` lets the page skip the fetch entirely
// when the meter feature flag is off (the endpoint 404s in that state anyway).
export function useBillingCockpit(period: string | undefined, opts?: { enabled?: boolean }) {
  const url = `/meter/cockpit${period ? `?period=${period}` : ""}`;
  return useQuery<CockpitResponse>({
    enabled: opts?.enabled ?? true,
    queryKey: ["meter", "cockpit", period ?? null],
    queryFn: () => apiFetch<CockpitResponse>(url),
  });
}
