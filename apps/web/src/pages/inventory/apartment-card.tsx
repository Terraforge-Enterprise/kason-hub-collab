// Apartment-grouped view of sibling Unit rows that share (propertyId, unitCode).
// Phase D of 2026-05-13 apartment-aggregation-and-highlights spec.
//
// Renders one card per apartment with: summary line (room count + shared
// fields + amenity/highlight chips), always-visible room list, drift warning
// when sibling rows disagree on shared fields, and two action buttons
// (+ Add rooms / Edit apartment) wired by the parent.

import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Bath,
  BedDouble,
  Maximize2,
  Pencil,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { StatusPill } from "@/components/ui";
import { getStatusTone } from "@/components/format";
import { listingLabel, occupancyLabel } from "@/lib/listing-status";
import type { ApartmentSummary } from "@/api/inventory-units-batch";

function formatRental(amount: number | null, currency = "MYR"): string {
  if (amount == null) return "—";
  const label = currency === "MYR" ? "RM" : currency;
  return `${label} ${amount.toLocaleString("en-MY", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export function ApartmentCard({
  apartment,
  editApartmentTrigger,
  addTenantTrigger,
  addOwnerTrigger,
  initiallyExpanded: _initiallyExpanded,
}: {
  apartment: ApartmentSummary;
  // Trigger is injected by the parent so the parent owns the dialog
  // mounting + state. It is rendered as the action button's child.
  editApartmentTrigger: ReactNode;
  /** Opens the existing unit edit flow on a room that has no tenant. */
  addTenantTrigger?: ReactNode;
  /** Opens the existing apartment edit flow so an owner can be assigned. */
  addOwnerTrigger?: ReactNode;
  /** @deprecated Rooms are always shown once their property is expanded. */
  initiallyExpanded?: boolean;
}) {
  const roomCount = apartment.rooms.length;
  // "Listed" rooms = rooms whose listing is active (Draft listings exist but
  // aren't visible to tenants, so they don't count toward the numerator).
  const listedRoomCount = apartment.rooms.filter(
    (r) => r.listingStatus === "active",
  ).length;
  const wholeUnitTenant =
    apartment.listingMode === "WHOLE"
      ? (apartment.rooms.find((r) => r.tenantName) ?? null)
      : null;
  const anchorRoom = apartment.rooms[0] ?? null;

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-1 items-center gap-2 text-left min-w-0 -mx-2 -my-1 px-2 py-1 rounded-md">
            {anchorRoom ? (
              <Link
                to={`/inventory/units/${anchorRoom.id}`}
                className="font-mono text-base font-semibold text-foreground underline decoration-[var(--gold)] underline-offset-4 hover:text-[var(--gold)]"
              >
                {apartment.unitCode}
              </Link>
            ) : (
              <span className="font-mono text-base font-semibold text-foreground">{apartment.unitCode}</span>
            )}
            {/* KAEN-management indicator: a red tag calls out apartments NOT under
                KAEN management. Under-management apartments show nothing (the norm). */}
            {!apartment.underManagement && (
              <Badge variant="rose">Not under KAEN management</Badge>
            )}
            {apartment.listingMode === "WHOLE" && (
              <>
                <Badge variant="emerald">Whole unit</Badge>
                <span className="text-[11px] text-muted-foreground">
                  · {roomCount} listing{roomCount === 1 ? "" : "s"}
                </span>
              </>
            )}
            {apartment.listingMode === "PARTITIONED" && (
              <>
                <Badge variant="amber">Partitioned</Badge>
                {/* Billing model is only meaningful for partitioned units
                    (per-room subsidy vs none). null/undefined → render nothing. */}
                {apartment.partitionBillingMode === "SUBSIDY" && (
                  <Badge variant="sky">Subsidy</Badge>
                )}
                {apartment.partitionBillingMode === "NO_SUBSIDY" && (
                  <Badge variant="outline">No subsidy</Badge>
                )}
                <span className="text-[11px] text-muted-foreground">
                  · {roomCount > 0 && listedRoomCount === roomCount
                    ? `All ${roomCount} rooms listed`
                    : `${listedRoomCount} of ${roomCount} rooms listed`}
                </span>
              </>
            )}
            {apartment.listingMode === "MIXED" && (
              <Badge variant="rose">Mixed — needs review</Badge>
            )}
            {apartment.listingMode == null && (
              <Badge variant="outline">No active listing</Badge>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {addTenantTrigger}
            {addOwnerTrigger}
            {editApartmentTrigger}
          </div>
        </div>

        {/* Summary line — shared apartment-scoped fields */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pl-6">
          {apartment.bedrooms != null && (
            <span className="inline-flex items-center gap-1">
              <BedDouble className="h-3 w-3" />
              {apartment.bedrooms} BR
            </span>
          )}
          {apartment.bathrooms != null && (
            <span className="inline-flex items-center gap-1">
              <Bath className="h-3 w-3" />
              {apartment.bathrooms} BA
            </span>
          )}
          {apartment.floorArea != null && (
            <span className="inline-flex items-center gap-1">
              <Maximize2 className="h-3 w-3" />
              {apartment.floorArea} sqft
            </span>
          )}
          {apartment.floor != null && (
            <span>Floor {apartment.floor}</span>
          )}
        </div>

        {(apartment.ownerName || wholeUnitTenant) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground pl-6">
            {apartment.ownerName && (
              <span>
                Owner:{" "}
                {apartment.ownerPartyId ? (
                  <Link
                    to={`/parties/owners?partyId=${encodeURIComponent(apartment.ownerPartyId)}`}
                    className="font-medium text-foreground underline decoration-[var(--gold)] underline-offset-4 hover:text-[var(--gold)]"
                  >
                    {apartment.ownerName}
                  </Link>
                ) : (
                  <span className="text-foreground">{apartment.ownerName}</span>
                )}
              </span>
            )}
            {wholeUnitTenant && (
              <span className="inline-flex flex-wrap items-center gap-x-2">
                Tenant:{" "}
                {wholeUnitTenant.tenantPartyId ? (
                  <Link
                    to={`/parties/tenants?partyId=${encodeURIComponent(wholeUnitTenant.tenantPartyId)}`}
                    className="font-medium text-foreground underline decoration-[var(--gold)] underline-offset-4 hover:text-[var(--gold)]"
                  >
                    {wholeUnitTenant.tenantName}
                  </Link>
                ) : (
                  <span className="text-foreground">{wholeUnitTenant.tenantName}</span>
                )}
                {formatTenancyPeriod(wholeUnitTenant.tenancyStartDate, wholeUnitTenant.tenancyEndDate) && (
                  <span className="font-medium text-[var(--deep-navy,#082F55)]">
                    {formatTenancyPeriod(wholeUnitTenant.tenancyStartDate, wholeUnitTenant.tenancyEndDate)}
                  </span>
                )}
              </span>
            )}
          </div>
        )}

        {/* Chip strip — amenities (gold-tinted) + highlights (muted) */}
        {(apartment.amenities.length > 0 || apartment.highlights.length > 0) && (
          <div className="flex flex-wrap gap-1.5 pl-6 pt-1">
            {apartment.amenities.map((a) => (
              <span
                key={`a-${a.id}`}
                className="inline-flex items-center rounded-full bg-[var(--gold)]/10 border border-[var(--gold)]/30 px-2 py-0.5 text-[11px] text-foreground"
              >
                {a.name}
              </span>
            ))}
            {apartment.highlights.map((h) => (
              <span
                key={`h-${h}`}
                className="inline-flex items-center rounded-full bg-muted/40 border border-border/60 border-dashed px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {h}
              </span>
            ))}
          </div>
        )}

        {apartment.listingMode === "WHOLE" && (
          <p className="text-[11px] text-muted-foreground pl-6 pt-1">
            Whole-unit listings hold one row. To list per-room, use <span className="font-medium">Edit details → Switch to partitioned</span>.
          </p>
        )}
      </CardHeader>

      {apartment.hasDrift && (
        <div className="px-6 pb-2">
          <Callout variant="warning" title="Drift detected">
            This apartment&apos;s sibling rooms disagree on shared fields. Values
            shown above are from the earliest-created room. Open{" "}
            <strong>Edit details</strong> and save to overwrite the drift on
            every sibling.
          </Callout>
        </div>
      )}

      <CardContent className="pt-2">
          <div className="space-y-1.5">
            {apartment.rooms.map((room) => (
              <div
                key={room.id}
                className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 py-2 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80 group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Link
                    to={`/inventory/units/${room.id}`}
                    className="cursor-pointer text-sm font-medium text-foreground capitalize shrink-0 underline decoration-[var(--gold)] underline-offset-4 hover:text-[var(--gold)]"
                  >
                    {room.unitType}
                  </Link>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {formatRental(room.rentalRate)}
                  </span>
                  {room.tenantName && (
                    <span className="flex min-w-0 flex-col gap-0.5">
                    {room.tenantPartyId ? (
                      <Link
                        to={`/parties/tenants?partyId=${encodeURIComponent(room.tenantPartyId)}`}
                        className="text-xs font-medium text-foreground truncate underline decoration-[var(--gold)] underline-offset-4 hover:text-[var(--gold)]"
                      >
                        Tenant: {room.tenantName}
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground truncate">Tenant: {room.tenantName}</span>
                    )}
                    {formatTenancyPeriod(room.tenancyStartDate, room.tenancyEndDate) && (
                      <span className="text-xs font-medium text-[var(--deep-navy,#082F55)] tabular-nums">
                        {formatTenancyPeriod(room.tenancyStartDate, room.tenancyEndDate)}
                      </span>
                    )}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {room.occupancyStatus && (
                    <StatusPill tone={getStatusTone(room.occupancyStatus)}>
                      {occupancyLabel(room.occupancyStatus)}
                    </StatusPill>
                  )}
                  <StatusPill tone={getStatusTone(room.listingStatus)}>
                    {listingLabel(room.listingStatus)}
                  </StatusPill>
                  <ArrowUpRight
                    className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition shrink-0"
                    aria-hidden="true"
                  />
                </div>
              </div>
            ))}
          </div>
      </CardContent>
    </Card>
  );
}

export function AddTenantButton({
  apartmentCode,
  ...rest
}: {
  apartmentCode: string;
} & React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Add tenant to ${apartmentCode}`}
      title={`Add tenant (${apartmentCode})`}
      {...rest}
    >
      <UserPlus className="h-4 w-4" />
      Add Tenant
    </Button>
  );
}

export function AddOwnerButton({
  apartmentCode,
  ...rest
}: {
  apartmentCode: string;
} & React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Add owner to ${apartmentCode}`}
      title={`Add owner (${apartmentCode})`}
      {...rest}
    >
      <UsersRound className="h-4 w-4" />
      Add Owner
    </Button>
  );
}

// Default-rendered action button. Parent pages can pass this to
// `editApartmentTrigger` as-is when they're wiring the dialog trigger, OR
// pass a fully-rendered trigger (e.g. with a Dialog wrapper that controls
// open state).
//
// The former sibling "Add rooms" button is gone: adding a room to an existing
// apartment is the Create-unit dialog's Partition path (type the apartment's
// existing unit code), which carries the same per-room fields. Keeping a second
// entry point meant two forms to maintain for one operation.
export function EditApartmentButton({
  apartmentCode,
  ...rest
}: {
  apartmentCode: string;
} & React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Edit details for ${apartmentCode}`}
      title={`Edit shared details (${apartmentCode})`}
      {...rest}
    >
      <Pencil className="h-3.5 w-3.5" />
      Edit details
    </Button>
  );
}
function formatTenancyDate(value: string): string {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function formatTenancyPeriod(startDate?: string | null, endDate?: string | null): string | null {
  if (!startDate) return null;
  return `${formatTenancyDate(startDate)} – ${endDate ? formatTenancyDate(endDate) : "Present"}`;
}
