import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "@/lib/api-client";
import { listReservations, type ReservationDto } from "@/api/reservations";
import { PageHeader, Surface } from "@/components/ui";
import { TenancyTable } from "./tenancies-table";
import { TenancyForms } from "./tenancies-forms";
import type { TenancyListItem } from "./tenancies-table";

type PropertyListItem = { id: string; name: string; propertyCode: string };
type UnitListItem = { id: string; propertyId: string; propertyName: string; unitCode: string };
type TenantListItem = { id: string; displayName: string; hasReservation?: boolean };

// Final-review Fix 2: the legacy (flag-off) "Create tenancy" card's
// reservation picker used to offer BOTH "signed" and "pending_customer"
// reservations. createTenancyService now unconditionally rejects a
// non-signed reservation with 400 RESERVATION_NOT_SIGNED, so an admin
// picking a pending_customer reservation from the legacy card 400s on
// submit -- a flag-off behavior regression. Only "signed" (with a recorded
// agreed rent) is ever safe to offer here. Exported as a pure function so
// it's unit-testable independent of the page's data-fetching.
export function assignableReservationsForLegacyCard(reservations: ReservationDto[]) {
  return reservations
    .filter((r) => r.status === "signed" && r.agreedMonthlyRent != null)
    .map((r) => ({
      id: r.id,
      referenceCode: r.referenceCode,
      unitId: r.unit.id,
      status: r.status,
      agreedMonthlyRent: r.agreedMonthlyRent,
      proposedMoveIn: r.proposedMoveIn,
      proposedMoveOut: r.proposedMoveOut,
    }));
}

export default function TenanciesPage() {
  const [searchParams] = useSearchParams();
  const initialReservationId = searchParams.get("reservationId") ?? "";

  const tenancies = useQuery({
    queryKey: ["tenancy", "tenancies"],
    queryFn: () => apiFetch<{ data: TenancyListItem[] }>("/tenancy/tenancies"),
  });

  const properties = useQuery({
    queryKey: ["inventory", "properties"],
    queryFn: () => apiFetch<{ data: PropertyListItem[] }>("/inventory/properties"),
  });

  const units = useQuery({
    queryKey: ["inventory", "units"],
    queryFn: () => apiFetch<{ data: UnitListItem[] }>("/inventory/units"),
  });

  const tenants = useQuery({
    queryKey: ["parties", "tenants"],
    queryFn: () => apiFetch<{ data: TenantListItem[] }>("/parties/tenants"),
  });

  // Reservations feed the "start tenancy from reservation" picker. A failure
  // here must not block the page — the picker simply won't appear.
  const reservations = useQuery({
    queryKey: ["reservations"],
    queryFn: listReservations,
  });

  const isLoading =
    tenancies.isLoading || properties.isLoading || units.isLoading || tenants.isLoading;
  const hasError =
    tenancies.isError || properties.isError || units.isError || tenants.isError;

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-28 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-64 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (hasError) {
    return (
      <p className="p-6 text-sm text-rose-600">
        Failed to load tenancy data. Please refresh.
      </p>
    );
  }

  const tenancyList = tenancies.data!.data;
  const propertyList = properties.data!.data;
  const unitList = units.data!.data;
  const tenantList = tenants.data!.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tenancy lifecycle"
        description="Create, renew, and close tenancy chains while keeping billing status and occupancy state aligned."
        metrics={[
          { label: "Tenancies", value: String(tenancyList.length), hint: "Total lifecycle records" },
          {
            label: "Active",
            value: String(tenancyList.filter((t) => t.status === "active").length),
            hint: "Currently in force",
          },
          {
            label: "Renewal chains",
            value: String(tenancyList.filter((t) => t.previousTenancyId).length),
            hint: "Derived from prior tenancies",
          },
          {
            label: "Tenant pool",
            value: String(tenantList.length),
            hint: `${unitList.length} units · ${propertyList.length} properties`,
          },
        ]}
      />
      <Surface
        title="Tenancy register"
        description="A full view of active and historical tenancy chains."
      >
        <TenancyTable tenancies={tenancyList} />
      </Surface>
      <TenancyForms
        properties={propertyList.map((p) => ({
          id: p.id,
          name: p.name,
          propertyCode: p.propertyCode,
        }))}
        units={unitList.map((u) => ({
          id: u.id,
          propertyId: u.propertyId,
          propertyName: u.propertyName,
          unitCode: u.unitCode,
        }))}
        tenants={tenantList.map((t) => ({
          id: t.id,
          displayName: t.displayName,
          hasReservation: t.hasReservation,
        }))}
        tenancies={tenancyList.map((t) => ({
          id: t.id,
          tenancyCode: t.tenancyCode,
          tenantName: t.tenantName,
        }))}
        reservations={assignableReservationsForLegacyCard(reservations.data ?? [])}
        initialReservationId={initialReservationId}
      />
    </div>
  );
}
