import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listOwnPortalUnits, type PortalOwnUnit } from "@/api/portal-inventory";
import { Badge } from "@/components/ui/badge";
import { formatRM } from "@/components/format";

const STATUS_BADGE: Record<string, "amber" | "emerald" | "sky" | "rose" | "default"> = {
  pending: "amber",
  needs_amendment: "amber",
  approved: "emerald",
  rejected: "rose",
  withdrawn: "default",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending review",
  needs_amendment: "Needs amendment",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/**
 * Read `bedrooms` / `bathrooms` from `submittedPayload.apartmentShared` and
 * `rentalRate` from `submittedPayload.listing`. The legacy flat columns are
 * gone after the three-table refactor — every commercial / shared detail
 * lives in the JSON payload until admin approval promotes it to the
 * Listing/Apartment row.
 */
function readPreviewFields(u: PortalOwnUnit): {
  bedrooms: number | null;
  bathrooms: number | null;
  rentalRate: number | null;
} {
  const payload = (u.submittedPayload ?? {}) as {
    listing?: Record<string, unknown>;
    apartmentShared?: Record<string, unknown>;
  };
  const num = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    bedrooms: num(payload.apartmentShared?.bedrooms),
    bathrooms: num(payload.apartmentShared?.bathrooms),
    rentalRate: num(payload.listing?.rentalRate),
  };
}

export function RentalsTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-own-units"],
    queryFn: () => listOwnPortalUnits(),
  });

  if (isLoading) {
    return (
      <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-8 text-center text-sm text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }

  const units = data ?? [];

  if (units.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-8 text-center text-sm text-[var(--text-muted)]">
        No rentals yet. File a Rental Entry above to get started.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {units.map((u) => {
        const status = u.submissionState;
        const preview = readPreviewFields(u);
        return (
          <Link
            key={u.id}
            to={`?unit=${u.id}`}
            className="block rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-4 hover:border-[var(--primary)] transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-[var(--text-primary)]">
                  <span>{u.property?.name ?? "—"}</span>
                  {" · "}
                  <span>{u.unitCode}</span>
                </p>
                <p className="text-sm text-[var(--text-muted)] mt-1">
                  {preview.bedrooms != null ? `${preview.bedrooms} bed · ` : ""}
                  {preview.bathrooms != null ? `${preview.bathrooms} bath · ` : ""}
                  {u.unitType}
                  {preview.rentalRate != null
                    ? ` · ${formatRM(preview.rentalRate)} / month`
                    : ""}
                </p>
              </div>
              <Badge variant={STATUS_BADGE[status] ?? "default"}>
                {STATUS_LABEL[status] ?? status}
              </Badge>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
