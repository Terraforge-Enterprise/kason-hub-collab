import type { z } from "zod";
import type {
  approveSchema,
  createPackageSchema,
  createClaimSchema,
  documentMarkUploadedSchema,
  listClaimsQuery,
  listPackagesQuery,
  packageSplitSchema,
  rejectSchema,
  needsAmendmentSchema,
  updatePackageSchema,
  updateClaimSchema,
  uploadUrlSchema,
} from "./renovation-claims.validation";

export type CreatePackageInput = z.infer<typeof createPackageSchema>;
export type UpdatePackageInput = z.infer<typeof updatePackageSchema>;
export type ListPackagesQuery = z.infer<typeof listPackagesQuery>;
export type PackageSplitInput = z.infer<typeof packageSplitSchema>;

export type CreateClaimInput = z.infer<typeof createClaimSchema>;
export type UpdateClaimInput = z.infer<typeof updateClaimSchema>;
export type ListClaimsQuery = z.infer<typeof listClaimsQuery>;
export type ApproveInput = z.infer<typeof approveSchema>;
export type RejectInput = z.infer<typeof rejectSchema>;
export type NeedsAmendmentInput = z.infer<typeof needsAmendmentSchema>;
export type UploadUrlInput = z.infer<typeof uploadUrlSchema>;
export type DocumentMarkUploadedInput = z.infer<typeof documentMarkUploadedSchema>;

export interface RenovationPackageSplitRow {
  id: string;
  organizationId: string;
  packageId: string;
  roleLabel: string;
  splitType: "percent" | "fixed";
  splitValue: number;
  isHouseKeep: boolean;
  sortOrder: number;
}

export interface RenovationPackageRow {
  id: string;
  organizationId: string;
  key: string;
  label: string;
  description: string | null;
  defaultPrice: number;
  archived: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  defaultSplits: RenovationPackageSplitRow[];
}

export interface RenovationClaimSplitRow {
  id: string;
  organizationId: string;
  claimId: string;
  partyPartyId: string | null;
  partyDisplayName: string;
  roleLabel: string;
  splitType: "percent" | "fixed";
  splitValue: number;
  isHouseKeep: boolean;
  sortOrder: number;
}

export interface RenovationClaimDocumentRow {
  id: string;
  organizationId: string;
  claimId: string;
  // Kept in sync with documentKindEnum in renovation-claims.validation.ts.
  // PR6 widened this from {quotation, invoice, agreement} to also include
  // progress_photo / before_photo / after_photo / contract.
  kind:
    | "quotation"
    | "invoice"
    | "agreement"
    | "progress_photo"
    | "before_photo"
    | "after_photo"
    | "contract";
  fileKey: string;
  filename: string;
  uploadedAt: Date;
  uploadedById: string;
}

export type RenovationClaimStatus =
  | "submitted"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "needs_amendment"
  | "cancelled";

export type PaymentType = "full" | "partial" | "offset_from_rental";

/**
 * Manager+ shape (everything). Editor-visible fields are a strict subset —
 * `packagePrice`, `monthlyOffsetAmount`, `splits`, `documents` are stripped.
 * The role-aware shape is realised at the repository boundary via
 * `renovationClaimSelectFor`.
 */
export interface RenovationClaimRow {
  id: string;
  organizationId: string;
  salesUnitId: string;
  packageId: string;
  packagePrice: number | null;
  paymentType: PaymentType;
  monthlyOffsetAmount: number | null;
  status: RenovationClaimStatus;
  notes: string | null;
  submittedAt: Date;
  submittedById: string;
  reviewedAt: Date | null;
  reviewedById: string | null;
  reviewerNote: string | null;
  splits: RenovationClaimSplitRow[] | null;
  documents: RenovationClaimDocumentRow[] | null;
}
