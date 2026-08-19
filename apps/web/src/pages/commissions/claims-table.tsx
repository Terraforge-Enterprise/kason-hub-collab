import { useNavigate } from "react-router-dom";
import { EnhancedDataTable } from "@/components/data-table";
import { StatusPill } from "@/components/ui";
import { humanizeClaimStatus } from "@/lib/commission-labels";
import { formatDate, formatMoney } from "@/components/format";
import { humanizeClaimType } from "@/lib/commission-labels";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontalIcon } from "lucide-react";
import type { ClaimForDrawer, ClaimDrawerMode } from "./claim-drawer";
import { Checkbox } from "@/components/ui/checkbox";
import { RoleGate } from "@/components/role-gate";

export type ClaimListItem = {
  id: string;
  claimNumber: string;
  agentName: string;
  submittedAt: string;
  totalNettPayout: number;
  claimType: string;
  currency: string;
  status: string;
};

type ClaimsTableProps = {
  claims: ClaimListItem[];
  onApprove?: (claim: ClaimForDrawer) => void;
  onOpenDrawer?: (claim: ClaimForDrawer, mode: ClaimDrawerMode) => void;
  /** Opens the shared RequestAmendmentModal at the page level for this claim. */
  onSendBackForAmendment?: (claim: ClaimForDrawer) => void;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  /** When true, hides selection column and shows only "View details" in the row menu. */
  embedded?: boolean;
};

export function getClaimStatusTone(status: string): "slate" | "sky" | "emerald" | "amber" | "rose" {
  switch (status.toLowerCase()) {
    case "paid":
      return "emerald";
    case "approved":
      return "sky";
    case "submitted":
    case "amended":
    case "needs_amendment":
      return "amber";
    case "rejected":
      return "rose";
    default:
      return "slate";
  }
}

export function ClaimsTableNavigable({ claims, onApprove, onOpenDrawer, onSendBackForAmendment, selectedIds, onToggleSelect, embedded }: ClaimsTableProps) {
  const navigate = useNavigate();

  function toDrawerClaim(claim: ClaimListItem): ClaimForDrawer {
    return {
      id: claim.id,
      claimNumber: claim.claimNumber,
      status: claim.status,
      agentName: claim.agentName,
      totalNettPayout: claim.totalNettPayout,
      claimDate: claim.submittedAt,
    };
  }

  const columns = [
    ...(!embedded && selectedIds && onToggleSelect ? [{
      key: "__select",
      label: "",
      sortable: false,
      sortValue: () => "",
      render: (row: ClaimListItem) => (
        <div
          className="hidden md:flex"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selectedIds.has(row.id)}
            onCheckedChange={() => onToggleSelect(row.id)}
            aria-label={`Select claim ${row.claimNumber}`}
          />
        </div>
      ),
    }] : []),
    {
      key: "claimNumber",
      label: "Claim #",
      sortable: true,
      sortValue: (row: ClaimListItem) => row.claimNumber,
      render: (row: ClaimListItem) => (
        <button
          className="font-medium text-sky-700 hover:underline dark:text-sky-400"
          onClick={() => navigate(`/commissions/claims/${row.id}`)}
          type="button"
        >
          {row.claimNumber}
        </button>
      ),
    },
    {
      key: "agentName",
      label: "Agent Name",
      sortable: true,
      sortValue: (row: ClaimListItem) => row.agentName,
      render: (row: ClaimListItem) => row.agentName,
    },
    {
      key: "claimType",
      label: "Claim Type",
      sortable: true,
      sortValue: (row: ClaimListItem) => row.claimType,
      render: (row: ClaimListItem) => humanizeClaimType(row.claimType),
    },
    {
      key: "submittedAt",
      label: "Submitted",
      sortable: true,
      sortValue: (row: ClaimListItem) => row.submittedAt,
      render: (row: ClaimListItem) => formatDate(row.submittedAt),
    },
    {
      key: "totalNettPayout",
      label: "Nett Payout",
      sortable: true,
      sortValue: (row: ClaimListItem) => row.totalNettPayout,
      render: (row: ClaimListItem) => formatMoney(row.totalNettPayout, row.currency),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      sortValue: (row: ClaimListItem) => row.status,
      render: (row: ClaimListItem) => (
        <StatusPill tone={getClaimStatusTone(row.status)}>{humanizeClaimStatus(row.status)}</StatusPill>
      ),
    },
    {
      key: "actions",
      label: "",
      sortable: false,
      sortValue: () => "",
      render: (row: ClaimListItem) => (
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Actions for claim ${row.claimNumber}`}
              className="rounded p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--page-bg)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontalIcon className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {embedded ? (
                <DropdownMenuItem onClick={() => navigate(`/commissions/claims/${row.id}`)}>
                  View details
                </DropdownMenuItem>
              ) : (
                <>
                  <RoleGate min="manager">
                    {row.status === "submitted" && (
                      <>
                        <DropdownMenuItem onClick={() => onApprove?.(toDrawerClaim(row))}>
                          Approve
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onOpenDrawer?.(toDrawerClaim(row), "pay-due")}>
                          Approve with due date…
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onSendBackForAmendment?.(toDrawerClaim(row))}>
                          Send back for amendment
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => onOpenDrawer?.(toDrawerClaim(row), "reject")}
                          className="text-rose-600 data-highlighted:bg-rose-500/10 data-highlighted:text-rose-700"
                        >
                          Reject
                        </DropdownMenuItem>
                      </>
                    )}
                    {row.status === "approved" && (
                      <>
                        <DropdownMenuItem onClick={() => onOpenDrawer?.(toDrawerClaim(row), "pay")}>
                          Mark as Paid
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onSendBackForAmendment?.(toDrawerClaim(row))}>
                          Send back for amendment
                        </DropdownMenuItem>
                      </>
                    )}
                    {row.status === "amended" && (
                      <DropdownMenuItem onClick={() => onSendBackForAmendment?.(toDrawerClaim(row))}>
                        Send back for amendment
                      </DropdownMenuItem>
                    )}
                  </RoleGate>
                  <DropdownMenuItem onClick={() => navigate(`/commissions/claims/${row.id}`)}>
                    View details
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <EnhancedDataTable
      data={claims}
      columns={columns}
      // Search is owned by the server-backed <ListFilterBar> in the parent page;
      // omitting searchKeys hides the duplicate client-side search input.
      searchKeys={[]}
      emptyMessage="No commission claims found."
    />
  );
}
