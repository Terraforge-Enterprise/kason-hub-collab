import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, MoreHorizontal, Search, X } from "lucide-react";
import { StatusPill } from "@/components/ui";
import { getStatusTone } from "@/components/format";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { apiFetch } from "@/lib/api-client";
import {
  EditOwnerDialog,
  BlacklistOwnerDialog,
  ResolveBlacklistOwnerDialog,
  DeleteOwnerDialog,
} from "./owners-action-dialogs";
import { OwnerDetailPanel } from "./owner-detail-panel";
import { AssignOwnerToUnitDialog } from "./assign-owner-to-unit-dialog";

export type OwnerListItem = {
  id: string;
  displayName: string;
  legalName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  /**
   * API-pre-formatted display value (e.g. "+60 12-345 6789"). Pre-rendered
   * server-side so the table doesn't pull libphonenumber-js into the client
   * bundle. Falls back to `primaryPhone` for legacy/un-backfilled rows.
   */
  formattedPhone: string | null;
  nationality: string | null;
  status: string;
  isBlacklisted: boolean;
  createdAt: string;
  bankName: string | null;
  bankAccountHolder: string | null;
  bankAccountNumber: string | null;
  idType: string | null;
  idNumber: string | null;
  blacklistReason: string | null;
  deletable: boolean;
  /**
   * Party's CURRENT owned property/unit(s), pre-deduped server-side. Optional
   * (mirrors the tenant side) so detail-panel projections / older fixtures that
   * predate this field still typecheck; the live payload always includes it
   * (possibly empty). Feeds the search haystack + sub-line.
   */
  units?: { propertyName: string; unitCode: string }[];
};

type StatusFilter = "all" | "active" | "inactive";

const STATUS_PILLS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

// Search filters across displayName, primaryEmail, formattedPhone/primaryPhone,
// nationality, and each unit's propertyName + unitCode (see the haystack below).

export function OwnerTable({ owners, focusedPartyId = null }: { owners: OwnerListItem[]; focusedPartyId?: string | null }) {
  const [searchQ, setSearchQ] = useState(() => owners.find((owner) => owner.id === focusedPartyId)?.displayName ?? "");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const filtered = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    return owners.filter((o) => {
      if (statusFilter === "active" && o.status !== "active") return false;
      if (statusFilter === "inactive" && o.status === "active") return false;
      if (q) {
        const haystack = [
          o.displayName,
          o.primaryEmail,
          o.formattedPhone ?? o.primaryPhone,
          o.nationality,
          ...(o.units ?? []).flatMap((u) => [u.propertyName, u.unitCode]),
        ];
        if (!haystack.some((v) => v && v.toLowerCase().includes(q))) return false;
      }
      return true;
    });
  }, [owners, searchQ, statusFilter]);

  const anyFilterActive = searchQ.trim() !== "" || statusFilter !== "all";
  const n = filtered.length;

  return (
    <>
      {/* Toolbar — mirrors Inventory's property-register toolbar verbatim. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--page-bg)] px-4 py-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-[var(--text-muted)]" />
          <input
            type="text"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search name, email, phone, nationality, property, or unit"
            aria-label="Search owners"
            className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] pl-8 pr-8 py-1.5 text-sm placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--gold)]"
          />
          {searchQ && (
            <button
              type="button"
              onClick={() => setSearchQ("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--card-bg)] p-0.5">
          {STATUS_PILLS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setStatusFilter(p.value)}
              aria-pressed={statusFilter === p.value}
              className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                statusFilter === p.value
                  ? "bg-[var(--gold)]/15 text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-[var(--text-muted)]">
          {n} {n === 1 ? "owner" : "owners"}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
            <tr>
              <th className="w-8 px-2 py-3" aria-label="Expand" />
              <th className="px-4 py-3 font-semibold">Name</th>
              <th className="px-4 py-3 font-semibold">Email</th>
              <th className="px-4 py-3 font-semibold">Phone</th>
              <th className="px-4 py-3 font-semibold">Nationality</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Blacklisted</th>
              <th className="px-4 py-3 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {n === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-10 text-center text-sm text-[var(--text-muted)]"
                >
                  {anyFilterActive
                    ? "No owners match the current filters."
                    : "No owners yet."}
                </td>
              </tr>
            ) : (
              filtered.map((o) => <OwnerRow key={o.id} owner={o} initiallyExpanded={o.id === focusedPartyId} />)
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function OwnerRow({ owner, initiallyExpanded = false }: { owner: OwnerListItem; initiallyExpanded?: boolean }) {
  const [editOpen, setEditOpen] = useState(false);
  const [blacklistOpen, setBlacklistOpen] = useState(false);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const queryClient = useQueryClient();

  const setStatus = useMutation({
    mutationFn: (status: "active" | "inactive") =>
      apiFetch(`/parties/owners/${owner.id}/set-status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["owners"] });
      toast.success("Status updated.");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to update status."),
  });

  return (
    <>
      {/* Whole row is the expand affordance — click anywhere (except the ⋯
          actions cell) to toggle the detail panel. The chevron stays as a
          keyboard-focusable disclosure control (mouse users get the full row). */}
      <tr
        onClick={() => setExpanded((prev) => !prev)}
        className="cursor-pointer border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
      >
        {/* Leading chevron — toggles the expand panel */}
        <td className="px-2 py-3.5 text-sm">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((prev) => !prev);
            }}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${owner.displayName}`}
            className="rounded p-0.5 text-[var(--text-muted)] transition hover:bg-[var(--page-bg)] hover:text-[var(--text-primary)]"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4 shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0" />
            )}
          </button>
        </td>

        <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
          <span className="font-medium text-[var(--text-primary)]">{owner.displayName}</span>
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">
            {owner.units && owner.units.length > 0
              ? owner.units.map((u) => `${u.propertyName} · ${u.unitCode}`).join(", ")
              : "(no unit)"}
          </div>
        </td>
        <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
          {owner.primaryEmail ?? "-"}
        </td>
        <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
          {owner.formattedPhone ?? owner.primaryPhone ?? "-"}
        </td>
        <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
          {owner.nationality ?? "-"}
        </td>
        <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
          <StatusPill tone={getStatusTone(owner.status)}>{owner.status}</StatusPill>
        </td>
        <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
          <StatusPill tone={owner.isBlacklisted ? "rose" : "emerald"}>
            {owner.isBlacklisted ? "yes" : "no"}
          </StatusPill>
        </td>
        {/* Actions cell stops click propagation so opening the ⋯ menu (or the
            dialogs it triggers) never toggles the row's expand panel. */}
        <td
          onClick={(e) => e.stopPropagation()}
          className="px-4 py-3.5 text-right text-sm text-[var(--text-primary)]"
        >
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Actions for ${owner.displayName}`}
                className="rounded p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--page-bg)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              >
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setEditOpen(true)}>Edit</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAssignOpen(true)}>
                  Assign to Unit
                </DropdownMenuItem>
                {owner.isBlacklisted ? (
                  <DropdownMenuItem onClick={() => setResolveOpen(true)}>
                    Resolve blacklist
                  </DropdownMenuItem>
                ) : (
                  <>
                    {owner.status === "active" ? (
                      <DropdownMenuItem onClick={() => setStatus.mutate("inactive")}>
                        Deactivate
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => setStatus.mutate("active")}>
                        Activate
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setBlacklistOpen(true)}
                    >
                      Blacklist
                    </DropdownMenuItem>
                  </>
                )}
                {owner.deletable && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <EditOwnerDialog owner={owner} open={editOpen} onOpenChange={setEditOpen} />
          <AssignOwnerToUnitDialog owner={owner} open={assignOpen} onOpenChange={setAssignOpen} />
          <BlacklistOwnerDialog
            owner={owner}
            open={blacklistOpen}
            onOpenChange={setBlacklistOpen}
          />
          <ResolveBlacklistOwnerDialog
            owner={owner}
            open={resolveOpen}
            onOpenChange={setResolveOpen}
          />
          <DeleteOwnerDialog owner={owner} open={deleteOpen} onOpenChange={setDeleteOpen} />
        </td>
      </tr>

      {/* Expand panel — full-width row containing the OwnerDetailPanel */}
      {expanded && (
        <tr>
          <td
            colSpan={8}
            className="border-b border-[var(--border)] bg-[var(--page-bg)] px-4 py-4"
          >
            <OwnerDetailPanel partyId={owner.id} />
          </td>
        </tr>
      )}
    </>

  );
}
