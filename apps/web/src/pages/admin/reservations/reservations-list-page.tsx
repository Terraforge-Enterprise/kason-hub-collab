import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Eye, FileSignature, Loader2, MoreHorizontal, Pencil } from "lucide-react";
import {
  listReservations,
  type ReservationDto,
  type ReservationStatus,
} from "@/api/reservations";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth";
import { EditAfterSignedDialog } from "./edit-after-signed-dialog";

const STATUS_TABS: Array<{ value: ReservationStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending_approval", label: "Awaiting Manager" },
  { value: "needs_amendment", label: "Needs Amendment" },
  { value: "pending_customer", label: "Awaiting Tenant" },
  { value: "signed", label: "Signed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

const STATUS_BADGE: Record<
  ReservationStatus,
  { label: string; variant: "amber" | "emerald" | "rose" | "secondary" }
> = {
  pending_approval: { label: "Pending approval", variant: "amber" },
  needs_amendment: { label: "Needs amendment", variant: "rose" },
  pending_customer: { label: "Pending", variant: "amber" },
  signed: { label: "Signed", variant: "emerald" },
  cancelled: { label: "Cancelled", variant: "rose" },
  expired: { label: "Expired", variant: "secondary" },
};

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(new Date(iso));
}

// D4 — Edit is allowed on signed + pending_customer (matches the backend
// ADMIN_EDITABLE_STATUSES in apps/api/src/modules/reservations/service.ts).
// Note: signed-edit now triggers the D2 reset flow (status→pending_customer,
// tenant must re-sign). The dialog itself shows the warning Callout — the
// list-side Edit affordance just opens it.
const ADMIN_LIST_EDIT_STATUSES: ReadonlySet<ReservationStatus> = new Set([
  "signed",
  "pending_customer",
]);

export default function ReservationsListPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [statusFilter, setStatusFilter] = useState<ReservationStatus | "all">("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const { data = [], isLoading, isError } = useQuery({
    queryKey: ["admin", "reservations"],
    queryFn: listReservations,
  });

  const filtered =
    statusFilter === "all" ? data : data.filter((r) => r.status === statusFilter);

  const editingReservation: ReservationDto | null = editingId
    ? data.find((r) => r.id === editingId) ?? null
    : null;

  const counts = data.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    acc.all = (acc.all ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-3 text-3xl font-bold text-foreground md:text-4xl">
          <FileSignature className="h-7 w-7 text-primary" />
          Reservations
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Unit reservation forms awaiting signature, signed, or no longer active.
        </p>
      </div>

      {/* Status pills */}
      <div className="flex flex-wrap gap-1.5">
        {STATUS_TABS.map((tab) => {
          const active = statusFilter === tab.value;
          const count = counts[tab.value] ?? 0;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => setStatusFilter(tab.value)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "border-amber-300 bg-gradient-to-r from-amber-50 to-yellow-50 text-amber-800 shadow-sm dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300"
                  : "border-border/60 bg-background/40 text-muted-foreground hover:border-border hover:text-foreground"
              }`}
            >
              {tab.label}
              <span className="rounded-full bg-background/60 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-border/50 bg-background/40 backdrop-blur-xl">
        {isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading reservations…
          </div>
        ) : isError ? (
          <p className="p-6 text-sm text-rose-600">Failed to load reservations.</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
            <div className="rounded-full bg-muted/40 p-3">
              <FileSignature className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">No reservations</p>
            <p className="text-xs text-muted-foreground">
              {statusFilter === "all"
                ? "No reservation has been created yet."
                : `No reservations in the '${statusFilter}' state.`}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/40 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3">Reference</th>
                  <th className="px-5 py-3">Property · Unit</th>
                  <th className="px-5 py-3">Applicant</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Issued</th>
                  <th className="px-5 py-3">Signed</th>
                  <th className="px-5 py-3">Expires</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, idx) => {
                  // Defensive: a reservation may carry a status not modelled by
                  // the signing workflow (e.g. seed/legacy "completed" rows that
                  // became tenancies). Never let an unmapped status crash the
                  // whole list — fall back to a neutral badge showing the raw value.
                  const badge = STATUS_BADGE[r.status] ?? {
                    label: r.status.replace(/_/g, " "),
                    variant: "secondary" as const,
                  };
                  const canEdit = isAdmin && ADMIN_LIST_EDIT_STATUSES.has(r.status);
                  return (
                    <tr
                      key={r.id}
                      className={`border-b border-border/30 last:border-b-0 transition-colors hover:bg-muted/40 ${
                        idx % 2 === 0 ? "bg-background/20" : ""
                      }`}
                    >
                      <td className="px-5 py-3.5">
                        <Link
                          to={`/admin/reservations/${r.id}`}
                          className="font-mono text-sm font-semibold text-foreground transition-colors hover:text-primary"
                        >
                          {r.referenceCode}
                        </Link>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="text-sm font-medium text-foreground">{r.property.name}</div>
                        <div className="text-xs text-muted-foreground">{r.unit.unitCode}</div>
                      </td>
                      <td className="px-5 py-3.5 text-sm">
                        {r.applicant.fullName ?? (
                          <span className="italic text-muted-foreground/70">Not yet filled</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground tabular-nums">
                        {formatDate(r.issuedAt)}
                      </td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground tabular-nums">
                        {r.signedAt ? formatDate(r.signedAt) : "—"}
                      </td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground tabular-nums">
                        {formatDate(r.expiresAt)}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        {/* D4: Row ⋯ action menu (per /frontend skill admin CRUD
                            pattern). Edit gated on canEdit (admin + signed |
                            pending_customer). View is always available — a
                            second affordance for users who scan the actions
                            column rather than clicking the reference link. */}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={`Actions for ${r.referenceCode}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canEdit && (
                              <DropdownMenuItem
                                onClick={() => setEditingId(r.id)}
                                className="gap-2"
                              >
                                <Pencil className="h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => navigate(`/admin/reservations/${r.id}`)}
                              className="gap-2"
                            >
                              <Eye className="h-4 w-4" />
                              View
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editingReservation && (
        <EditAfterSignedDialog
          open={true}
          onClose={() => setEditingId(null)}
          reservation={editingReservation}
          onSaved={() => {
            setEditingId(null);
            void qc.invalidateQueries({ queryKey: ["admin", "reservations"] });
            void qc.invalidateQueries({
              queryKey: ["admin", "reservation", editingReservation.id],
            });
            void qc.invalidateQueries({
              queryKey: ["admin", "reservation-edit-history", editingReservation.id],
            });
          }}
        />
      )}
    </div>
  );
}
