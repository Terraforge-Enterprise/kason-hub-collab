import { EnhancedDataTable } from "@/components/data-table";
import { StatusPill } from "@/components/ui";
import { getStatusTone } from "@/components/format";
import { Avatar } from "@/components/avatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { CircleCheckIcon, CircleXIcon, MoreHorizontalIcon, ShieldOffIcon } from "lucide-react";
import { NATIONALITIES, labelOf } from "@/lib/malaysia-refdata";
import { RoleGate } from "@/components/role-gate";

export type AgentListItem = {
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
  agentLevel: string | null;
  status: string;
  isBlacklisted: boolean;
  updatedAt: string;
  createdAt: string;
  bankName: string | null;
  bankAccountHolder: string | null;
  bankAccountNumber: string | null;
  idType: string | null;
  idNumber: string | null;
  photoUrl: string | null;
  portalUser: {
    id: string;
    email: string;
    status: string;
    updatedAt: string;
  } | null;
  uplineId?: string | null;
  upline?: { id: string; displayName: string } | null;
};

const AGENT_LEVEL_LABELS: Record<string, string> = {
  new_agent: "New Agent",
  pre_leader: "Pre Leader",
  leader: "Leader",
};

function getAgentLevelTone(level: string | null) {
  switch (level) {
    case "leader":
      return "emerald" as const;
    case "pre_leader":
      return "amber" as const;
    case "new_agent":
      return "sky" as const;
    default:
      return "slate" as const;
  }
}

type AgentTableProps = {
  agents: AgentListItem[];
  onEdit: (agent: AgentListItem) => void;
  onBlacklist: (agent: AgentListItem) => void;
  onReactivate: (agent: AgentListItem) => void;
  onDeactivate: (agent: AgentListItem) => void;
  onActivate: (agent: AgentListItem) => void;
  onGrantPortal: (agent: AgentListItem) => void;
  onRevokePortal: (agent: AgentListItem) => void;
  onResetPortalPassword: (agent: AgentListItem) => void;
  onViewDetails: (agent: AgentListItem) => void;
};

export function AgentTable({
  agents,
  onEdit,
  onBlacklist,
  onReactivate,
  onDeactivate,
  onActivate,
  onGrantPortal,
  onRevokePortal,
  onResetPortalPassword,
  onViewDetails,
}: AgentTableProps) {
  const columns = [
    {
      key: "displayName",
      label: "Name",
      sortable: true,
      sortValue: (row: AgentListItem) => row.displayName,
      render: (row: AgentListItem) => (
        <div className="flex items-center gap-3">
          <Avatar src={row.photoUrl ?? null} name={row.displayName} size="sm" />
          <span className="font-medium text-[var(--text-primary)]">{row.displayName}</span>
        </div>
      ),
    },
    {
      key: "primaryEmail",
      label: "Email",
      sortable: true,
      sortValue: (row: AgentListItem) => row.primaryEmail ?? "",
      render: (row: AgentListItem) => row.primaryEmail ?? "-",
    },
    {
      key: "primaryPhone",
      label: "Phone",
      render: (row: AgentListItem) => row.formattedPhone ?? row.primaryPhone ?? "-",
    },
    {
      key: "nationality",
      label: "Nationality",
      sortable: true,
      sortValue: (row: AgentListItem) => labelOf(NATIONALITIES, row.nationality),
      render: (row: AgentListItem) => labelOf(NATIONALITIES, row.nationality) || "-",
    },
    {
      key: "agentLevel",
      label: "Agent Level",
      sortable: true,
      sortValue: (row: AgentListItem) => row.agentLevel ?? "",
      render: (row: AgentListItem) => (
        <StatusPill tone={getAgentLevelTone(row.agentLevel)}>
          {row.agentLevel ? (AGENT_LEVEL_LABELS[row.agentLevel] ?? row.agentLevel) : "-"}
        </StatusPill>
      ),
    },
    {
      key: "upline",
      label: "Upline",
      sortable: true,
      sortValue: (row: AgentListItem) => row.upline?.displayName ?? "",
      render: (row: AgentListItem) =>
        row.upline ? (
          <span className="text-sm text-[var(--text-primary)]">{row.upline.displayName}</span>
        ) : (
          <span className="text-[var(--text-muted)]">—</span>
        ),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      sortValue: (row: AgentListItem) => row.status,
      render: (row: AgentListItem) => (
        <StatusPill tone={row.isBlacklisted ? "rose" : getStatusTone(row.status)}>
          <span className="inline-flex items-center gap-1">
            {row.isBlacklisted ? (
              <ShieldOffIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : row.status === "active" ? (
              <CircleCheckIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <CircleXIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            {row.isBlacklisted ? "blacklisted" : row.status}
          </span>
        </StatusPill>
      ),
    },
    {
      key: "actions",
      label: "",
      sortable: false,
      sortValue: () => "",
      render: (row: AgentListItem) => (
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Actions for ${row.displayName}`}
              className="rounded p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--page-bg)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontalIcon className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <RoleGate min="manager">
                {!row.isBlacklisted && (
                  <DropdownMenuItem onClick={() => onEdit(row)}>
                    Edit
                  </DropdownMenuItem>
                )}

                {!row.isBlacklisted && !row.portalUser && (
                  <DropdownMenuItem onClick={() => onGrantPortal(row)}>
                    Grant portal access
                  </DropdownMenuItem>
                )}

                {!row.isBlacklisted && row.portalUser && (
                  <DropdownMenuItem onClick={() => onRevokePortal(row)}>
                    Revoke portal access
                  </DropdownMenuItem>
                )}

                {!row.isBlacklisted && row.portalUser && (
                  <DropdownMenuItem onClick={() => onResetPortalPassword(row)}>
                    Reset portal password
                  </DropdownMenuItem>
                )}

                {row.isBlacklisted && (
                  <DropdownMenuItem onClick={() => onReactivate(row)}>
                    Reactivate
                  </DropdownMenuItem>
                )}

                {!row.isBlacklisted && row.status === "inactive" && (
                  <DropdownMenuItem onClick={() => onActivate(row)}>
                    Activate
                  </DropdownMenuItem>
                )}

                {!row.isBlacklisted && row.status === "active" && (
                  <DropdownMenuItem onClick={() => onDeactivate(row)}>
                    Deactivate
                  </DropdownMenuItem>
                )}

                {!row.isBlacklisted && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => onBlacklist(row)}
                      className="text-rose-600 data-highlighted:bg-rose-500/10 data-highlighted:text-rose-700"
                    >
                      Blacklist
                    </DropdownMenuItem>
                  </>
                )}

                <DropdownMenuSeparator />
              </RoleGate>
              <DropdownMenuItem onClick={() => onViewDetails(row)}>
                View details
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <EnhancedDataTable
      data={agents}
      columns={columns}
      searchPlaceholder="Search agents..."
      searchKeys={["displayName", "primaryEmail", "primaryPhone", "nationality"]}
      emptyMessage="No agents yet."
    />
  );
}
