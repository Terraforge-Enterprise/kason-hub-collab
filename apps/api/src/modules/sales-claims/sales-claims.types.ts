import type { z } from "zod";
import type {
  approveSchema,
  createClaimSchema,
  listClaimsQuery,
  needsAmendmentSchema,
  rejectSchema,
  updateClaimSchema,
} from "./sales-claims.validation";

export type CreateClaimInput = z.infer<typeof createClaimSchema>;
export type UpdateClaimInput = z.infer<typeof updateClaimSchema>;
export type ListClaimsQuery = z.infer<typeof listClaimsQuery>;
export type ApproveInput = z.infer<typeof approveSchema>;
export type RejectInput = z.infer<typeof rejectSchema>;
export type NeedsAmendmentInput = z.infer<typeof needsAmendmentSchema>;

export type SalesClaimStatus =
  | "submitted"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "needs_amendment"
  | "cancelled";

export type SalesPaymentType = "full" | "partial";

export type CommissionType = "percent_of_purchase" | "fixed";

export interface SalesClaimSplitRow {
  id: string;
  organizationId: string;
  claimId: string;
  partyPartyId: string | null;
  partyDisplayName: string;
  roleLabel: string;
  splitType: "percent" | "fixed";
  splitValue: number;
  sortOrder: number;
}

/**
 * Manager+ shape (everything). Editor-visible fields are a strict subset —
 * `commissionValue`, `computedAmount`, `splits` are stripped. The role-aware
 * shape is realised at the repository boundary via `salesClaimSelectFor`.
 */
export interface SalesClaimRow {
  id: string;
  organizationId: string;
  salesUnitId: string;
  commissionType: CommissionType;
  commissionValue: number | null;
  computedAmount: number | null;
  paymentType: SalesPaymentType;
  status: SalesClaimStatus;
  notes: string | null;
  submittedAt: Date;
  submittedById: string;
  reviewedAt: Date | null;
  reviewedById: string | null;
  reviewerNote: string | null;
  splits: SalesClaimSplitRow[] | null;
}
