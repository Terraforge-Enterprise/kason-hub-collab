// Agent's lifecycle view of every unit submission. Extracted from
// my-uploads-page.tsx as part of the My Uploads tabbed refactor — sibling
// to properties-tab.tsx. No logic change vs the pre-tab implementation.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listOwnPortalUnits, type PortalOwnUnit } from "@/api/portal-inventory";

type Status =
  | "pending"
  | "needs_amendment"
  | "approved"
  | "withdrawn"
  | "rejected";

const STATUS_LABEL: Record<Status, string> = {
  pending: "Pending review",
  needs_amendment: "Needs amendment",
  approved: "Approved",
  withdrawn: "Withdrawn",
  rejected: "Rejected",
};

const STATUS_VARIANT: Record<
  Status,
  "amber" | "sky" | "emerald" | "rose" | "default"
> = {
  pending: "amber",
  needs_amendment: "amber",
  approved: "emerald",
  withdrawn: "default",
  rejected: "rose",
};

const SECTION_ORDER: Status[] = [
  "pending",
  "needs_amendment",
  "approved",
  "rejected",
  "withdrawn",
];

function getProposedRentalRate(u: PortalOwnUnit): number | null {
  const payload = u.submittedPayload as
    | { listing?: { rentalRate?: number | string | null } }
    | null;
  const raw = payload?.listing?.rentalRate;
  if (raw == null) return null;
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) ? num : null;
}

export function RentalsTab() {
  const query = useQuery({
    queryKey: ["portal-my-uploads"],
    queryFn: listOwnPortalUnits,
  });

  if (query.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-32 bg-muted rounded-xl" />
        <div className="h-32 bg-muted rounded-xl" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-8 text-center">
          <p className="text-sm text-rose-400">Failed to load uploads.</p>
        </CardContent>
      </Card>
    );
  }

  const grouped = new Map<Status, PortalOwnUnit[]>();
  for (const u of query.data ?? []) {
    const s = u.submissionState as Status;
    if (!grouped.has(s)) grouped.set(s, []);
    grouped.get(s)!.push(u);
  }

  const total = query.data?.length ?? 0;

  if (total === 0) {
    return (
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No uploads yet. Hit <span className="font-medium text-foreground">Add new</span> to submit your first unit.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {SECTION_ORDER.map((status) => {
        const units = grouped.get(status);
        if (!units?.length) return null;
        return (
          <Card
            key={status}
            className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl"
          >
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
                <span className="text-muted-foreground text-sm font-normal">
                  ({units.length})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {units.map((u) => {
                const rentalRate = getProposedRentalRate(u);
                const to =
                  u.submissionState === "approved" && u.approvedListingId
                    ? `/portal/inventory/${u.approvedListingId}`
                    : `/portal/inventory/${u.id}/edit`;
                return (
                  <Link
                    key={u.id}
                    to={to}
                    className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {u.property?.name ?? "(Pending property)"}{" "}
                        <span className="text-muted-foreground font-mono">· {u.unitCode}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        <span className="capitalize">{u.unitType}</span>
                        {rentalRate != null &&
                          ` · RM${Number(rentalRate).toLocaleString()}/month`}
                        {u.parentListingId && " · Amendment"}
                      </div>
                      {u.amendmentNote && (
                        <div className="text-xs text-amber-400 mt-1.5 line-clamp-2">
                          Note: {u.amendmentNote.replace(/^REJECTED:\s*/, "")}
                        </div>
                      )}
                    </div>
                  </Link>
                );
              })}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Lightweight count hook the parent shell uses to render the tab badge.
 * Reuses the same react-query cache key so we don't double-fetch.
 */
export function useRentalsTabCount(): number | null {
  const query = useQuery({
    queryKey: ["portal-my-uploads"],
    queryFn: listOwnPortalUnits,
  });
  if (!query.data) return null;
  return query.data.length;
}
