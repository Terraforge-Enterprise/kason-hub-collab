// Shared status badge mapping used by both the list and the detail page.
// Co-located in `pages/sales` because the detail page renders status pills
// with the exact same vocabulary as the list and we don't want to duplicate
// the switch.

import type { SalesClaimStatus } from "@/api/sales-claims";

export function statusBadgeVariant(
  status: SalesClaimStatus,
): "sky" | "amber" | "emerald" | "rose" {
  switch (status) {
    case "submitted":
      return "sky";
    case "pending_approval":
      return "amber";
    case "approved":
      return "emerald";
    case "rejected":
      return "rose";
    case "needs_amendment":
      return "amber";
  }
}

export function statusLabel(status: SalesClaimStatus): string {
  switch (status) {
    case "submitted":
      return "Submitted";
    case "pending_approval":
      return "Pending approval";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "needs_amendment":
      return "Needs amendment";
  }
}
