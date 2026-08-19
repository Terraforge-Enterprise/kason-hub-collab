import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listPortalSalesUnits } from "@/api/portal-sales";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/components/format";

const STATUS_BADGE: Record<string, "amber" | "emerald" | "rose" | "sky"> = {
  pending_review: "amber",
  approved_no_reno: "sky",
  not_started: "amber",
  on_going: "amber",
  completed: "emerald",
  graduated: "sky",
};

const STATUS_LABEL: Record<string, string> = {
  pending_review: "Pending review",
  approved_no_reno: "Approved (own stay)",
  not_started: "Not started",
  on_going: "On going",
  completed: "Completed",
  graduated: "Graduated",
};

function deriveStatus(unit: {
  sourcingApproved: boolean;
  purpose: "rent" | "own_stay";
}): string {
  if (!unit.sourcingApproved) return "pending_review";
  if (unit.purpose === "own_stay") return "approved_no_reno";
  return "not_started";
}

export function SalesTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-sales-units"],
    queryFn: () => listPortalSalesUnits(),
  });

  if (isLoading) {
    return (
      <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-8 text-center text-sm text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }

  const units = (data?.data ?? []) as Array<any>;

  if (units.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-8 text-center text-sm text-[var(--text-muted)]">
        No units yet. File a Sales Entry above to get started.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {units.map((u) => {
        const status = deriveStatus(u);
        return (
          <Link
            key={u.id}
            to={`?unit=${u.id}`}
            className="block rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-4 hover:border-[var(--primary)] transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-[var(--text-primary)]">
                  <span>{u.project?.name ?? "—"}</span>
                  {" · "}
                  <span>{u.unitNumber}</span>
                </p>
                <p className="text-sm text-[var(--text-muted)] mt-1">
                  Owner: <span>{u.ownerParty?.displayName ?? "—"}</span> · Sold{" "}
                  <span>{formatDate(u.salesDate)}</span>
                </p>
              </div>
              <Badge variant={STATUS_BADGE[status] ?? "sky"}>{STATUS_LABEL[status] ?? status}</Badge>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
