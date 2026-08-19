import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui";
import { getStatusTone } from "@/components/format";
import { type UnitRowData } from "./edit-unit-dialog";
import { EditApartmentShell } from "./edit-apartment-shell";
import { Link } from "react-router-dom";
import { listingLabel, occupancyLabel } from "@/lib/listing-status";

export type UnitListItem = {
  id: string;
  propertyId: string;
  propertyName: string;
  unitCode: string;
  unitType: string;
  occupancyStatus: string;
  listingStatus: string;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  readyNow: boolean;
  rentalRate: number | null;
  currency: string;
};

function formatRental(amount: number | null, currency: string): string {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: currency || "MYR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function UnitsTable({
  units,
}: {
  units: UnitListItem[];
}) {
  if (units.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-[var(--text-muted)]">
        No units in this property yet. Use the <strong>+ Unit</strong> button on the property row to add one.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card-bg)]">
      <div className="grid grid-cols-[110px_140px_1fr_100px_100px_120px] gap-2 border-b border-[var(--border)] bg-[var(--page-bg)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        <div>Unit Code</div>
        <div>Type</div>
        <div>Rental</div>
        <div>Occupancy</div>
        <div>Listing</div>
        <div className="text-right">Actions</div>
      </div>
      {units.map((u) => {
        const unitRowData: UnitRowData = {
          id: u.id,
          propertyName: u.propertyName,
          unitCode: u.unitCode,
          unitType: u.unitType,
          occupancyStatus: u.occupancyStatus,
          listingStatus: u.listingStatus,
          rentalRate: u.rentalRate,
        };
        return (
          <div
            key={u.id}
            className="grid grid-cols-[110px_140px_1fr_100px_100px_120px] items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-sm last:border-b-0"
          >
            <Link
              to={`/inventory/units/${u.id}`}
              className="font-mono text-[13px] text-[var(--gold)] hover:underline"
            >
              {u.unitCode}
            </Link>
            <div>{u.unitType}</div>
            <div>{formatRental(u.rentalRate, u.currency)}</div>
            <div className="text-[var(--text-secondary)]">{occupancyLabel(u.occupancyStatus)}</div>
            <div>
              <StatusPill tone={getStatusTone(u.listingStatus)}>{listingLabel(u.listingStatus)}</StatusPill>
            </div>
            <div className="flex justify-end gap-1">
              <EditApartmentShell
                unit={unitRowData}
                trigger={
                  <Button variant="ghost" size="sm" aria-label="Edit unit" title="Edit unit">
                    <Pencil />
                  </Button>
                }
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
