// Agent's lifecycle view of every PropertySubmission they own. Sibling to
// rentals-tab.tsx; both render inside the tabbed My Uploads shell.
//
// Per-status affordances (spec §4.4):
//   pending           → Withdraw only
//   needs_amendment   → Edit & resubmit (primary) + Withdraw  + admin note inline
//   approved          → View property link
//   rejected          → read-only, shows amendmentNote (rejection reason)
//   withdrawn         → read-only

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  listOwnPortalProperties,
  type PortalOwnPropertyListRow,
} from "@/api/portal-inventory";

type Status = PortalOwnPropertyListRow["submissionState"];

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

export function PropertiesTab() {
  const query = useQuery({
    queryKey: ["portal-my-property-uploads"],
    queryFn: listOwnPortalProperties,
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
          <p className="text-sm text-rose-400">Failed to load property submissions.</p>
        </CardContent>
      </Card>
    );
  }

  const grouped = new Map<Status, PortalOwnPropertyListRow[]>();
  for (const p of query.data ?? []) {
    if (!grouped.has(p.submissionState)) grouped.set(p.submissionState, []);
    grouped.get(p.submissionState)!.push(p);
  }

  const total = query.data?.length ?? 0;

  if (total === 0) {
    return (
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-8 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            No property submissions yet. Properties you submit will show here
            after you create your first one.
          </p>
          <Link to="/portal/inventory/new">
            <Button variant="gold" size="sm">Create a property</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {SECTION_ORDER.map((status) => {
        const rows = grouped.get(status);
        if (!rows?.length) return null;
        return (
          <Card
            key={status}
            data-testid={`properties-section-${status}`}
            className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl"
          >
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
                <span className="text-muted-foreground text-sm font-normal">
                  ({rows.length})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {rows.map((p) => (
                <PropertyRow key={p.id} property={p} />
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function PropertyRow({ property }: { property: PortalOwnPropertyListRow }) {
  const showNote =
    property.submissionState === "needs_amendment" ||
    property.submissionState === "rejected";

  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate">
            {property.name}{" "}
            <span className="text-muted-foreground font-mono">· {property.propertyCode}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            <span className="capitalize">{property.propertyType}</span>
            {" · "}Submitted {new Date(property.createdAt).toLocaleDateString()}
          </div>
        </div>
      </div>

      {showNote && property.amendmentNote && (
        <div className="text-xs text-amber-400 mt-2">
          {property.submissionState === "needs_amendment"
            ? "Admin note: "
            : "Rejection reason: "}
          {property.amendmentNote}
        </div>
      )}

      <PropertyRowActions property={property} />
    </div>
  );
}

function PropertyRowActions({ property }: { property: PortalOwnPropertyListRow }) {
  const editLink = `/portal/properties/${property.id}/edit`;

  switch (property.submissionState) {
    case "pending":
      return (
        <div className="mt-3 flex gap-2">
          <Link to={editLink}>
            <Button variant="ghost" size="sm">Withdraw</Button>
          </Link>
        </div>
      );
    case "needs_amendment":
      return (
        <div className="mt-3 flex gap-2">
          <Link to={editLink}>
            <Button variant="gold" size="sm">Edit & resubmit</Button>
          </Link>
          <Link to={editLink}>
            <Button variant="ghost" size="sm">Withdraw</Button>
          </Link>
        </div>
      );
    case "approved":
      return property.approvedPropertyId ? (
        <div className="mt-3">
          <Link
            to={`/portal/inventory?propertyId=${property.approvedPropertyId}`}
            className="text-xs text-primary hover:underline"
          >
            View property →
          </Link>
        </div>
      ) : null;
    case "rejected":
    case "withdrawn":
      return null;
  }
}

export function usePropertiesTabCount(): number | null {
  const query = useQuery({
    queryKey: ["portal-my-property-uploads"],
    queryFn: listOwnPortalProperties,
  });
  if (!query.data) return null;
  return query.data.length;
}
