// Portal API client for Renovation Claims (agent-facing).
//
// Mirrors the routes mounted at /portal-api/renovation/* in
// apps/api/src/modules/portal/renovation-claims/portal.renovation-claims.routes.ts.
// All calls run as the logged-in agent — server enforces own-only ownership.

import { portalApiFetch } from "@/lib/portal-api";

// ─── Shared enum types ──────────────────────────────────────────────────────

export type SplitType = "percent" | "fixed";
export type PaymentType = "full" | "partial" | "offset_from_rental";
export type DocumentKind =
  | "quotation"
  | "invoice"
  | "agreement"
  | "progress_photo"
  | "before_photo"
  | "after_photo"
  | "contract";
export type ClaimStatus =
  | "submitted"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "needs_amendment";

// ─── Package shapes (read-only for portal) ──────────────────────────────────

export type PackageDefaultSplit = {
  id: string;
  organizationId: string;
  packageId: string;
  roleLabel: string;
  splitType: SplitType;
  splitValue: number;
  isHouseKeep: boolean;
  sortOrder: number;
};

export type RenovationPackage = {
  id: string;
  organizationId: string;
  key: string;
  label: string;
  description: string | null;
  defaultPrice: number;
  archived: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  defaultSplits: PackageDefaultSplit[];
};

// ─── Claim shapes ───────────────────────────────────────────────────────────

export type ClaimSplit = {
  id?: string;
  organizationId?: string;
  claimId?: string;
  partyPartyId: string | null;
  partyDisplayName: string;
  roleLabel: string;
  splitType: SplitType;
  splitValue: number;
  isHouseKeep: boolean;
  sortOrder: number;
};

export type ClaimDocument = {
  id: string;
  organizationId: string;
  claimId: string;
  kind: DocumentKind;
  fileKey: string;
  filename: string;
  uploadedAt: string;
  uploadedById: string;
};

export type RenovationClaim = {
  id: string;
  organizationId: string;
  salesUnitId: string;
  packageId: string;
  packagePrice: number | null;
  paymentType: PaymentType;
  monthlyOffsetAmount: number | null;
  status: ClaimStatus;
  notes: string | null;
  submittedAt: string;
  submittedById: string;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewerNote: string | null;
  splits: ClaimSplit[] | null;
  documents: ClaimDocument[] | null;
};

// ─── Document input (used by create + mark-uploaded) ────────────────────────

export type ClaimDocumentInput = {
  fileKey: string;
  kind: DocumentKind;
  filename: string;
};

// ─── Sales unit picker shape (slim) ─────────────────────────────────────────

export type PortalSalesUnit = {
  id: string;
  organizationId: string;
  projectId: string;
  unitNumber: string;
  ownerPartyId: string;
  salesDate: string;
  purpose: "rent" | "own_stay";
  bedrooms: number;
  bathrooms: number;
  parkingLots: number;
  expectedRental: number | null;
  purchasePrice: number;
  agentPartyId: string;
  inChargePartyId: string | null;
  sourceFlag: string;
  sourcingApproved: boolean;
  amendmentNotes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PortalProject = {
  id: string;
  organizationId: string;
  name: string;
  developer: string;
  city: string | null;
  expectedHandover: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

// ─── Upload-url response ────────────────────────────────────────────────────

export type UploadUrlResponse = {
  uploadUrl: string;
  method: string; // "PUT" | "POST" — Supabase signed-uploads are POST
  headers: Record<string, string>;
  fileKey: string;
};

// ─── Create / update payloads ───────────────────────────────────────────────

export type CreateClaimPayload = {
  salesUnitId: string;
  packageId: string;
  packagePrice: number;
  paymentType: PaymentType;
  monthlyOffsetAmount?: number | null;
  notes?: string | null;
  splits: Array<{
    partyPartyId?: string | null;
    partyDisplayName: string;
    roleLabel: string;
    splitType: SplitType;
    splitValue: number;
    isHouseKeep: boolean;
    sortOrder: number;
  }>;
  documents: ClaimDocumentInput[];
};

export type UpdateClaimPayload = {
  packageId?: string;
  packagePrice?: number;
  paymentType?: PaymentType;
  monthlyOffsetAmount?: number | null;
  notes?: string | null;
  splits?: CreateClaimPayload["splits"];
};

// ─── API calls ──────────────────────────────────────────────────────────────

export async function listPackages(): Promise<RenovationPackage[]> {
  const res = await portalApiFetch<{ data: RenovationPackage[] }>(
    "/renovation/packages",
  );
  return res.data;
}

export async function listClaims(): Promise<RenovationClaim[]> {
  const res = await portalApiFetch<{ data: RenovationClaim[] }>(
    "/renovation/claims",
  );
  return res.data;
}

export async function getClaim(id: string): Promise<RenovationClaim> {
  const res = await portalApiFetch<{ data: RenovationClaim }>(
    `/renovation/claims/${id}`,
  );
  return res.data;
}

export interface OwnRenovationClaimTransition {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedById: string;
  changedByName: string | null;
  changedAt: string;
  note: string | null;
}

export async function listClaimTransitions(
  id: string,
): Promise<OwnRenovationClaimTransition[]> {
  const res = await portalApiFetch<{ data: OwnRenovationClaimTransition[] }>(
    `/renovation/claims/${id}/transitions`,
  );
  return res.data;
}

export async function createClaim(
  body: CreateClaimPayload,
): Promise<RenovationClaim> {
  const res = await portalApiFetch<{ data: RenovationClaim }>(
    "/renovation/claims",
    { method: "POST", body: JSON.stringify(body) },
  );
  return res.data;
}

export async function updateClaim(
  id: string,
  body: UpdateClaimPayload,
): Promise<RenovationClaim> {
  const res = await portalApiFetch<{ data: RenovationClaim }>(
    `/renovation/claims/${id}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  return res.data;
}

/**
 * Withdraw an own claim. Server requires status="submitted" — returns
 * 409 if a reviewer already picked it up.
 */
export async function cancelClaim(
  id: string,
  note?: string,
): Promise<RenovationClaim> {
  const res = await portalApiFetch<{ data: RenovationClaim }>(
    `/renovation/claims/${id}`,
    { method: "DELETE", body: JSON.stringify({ note: note ?? null }) },
  );
  return res.data;
}

export async function listMySalesUnits(): Promise<PortalSalesUnit[]> {
  const res = await portalApiFetch<{ data: PortalSalesUnit[] }>("/sales/units");
  return res.data;
}

export async function listProjects(): Promise<PortalProject[]> {
  const res = await portalApiFetch<{ data: PortalProject[] }>("/projects");
  return res.data;
}

// ─── Two-step document upload ───────────────────────────────────────────────

export async function getUploadUrl(input: {
  filename: string;
  contentType: string;
  claimId?: string;
}): Promise<UploadUrlResponse> {
  const res = await portalApiFetch<{ data: UploadUrlResponse }>(
    "/renovation/claims/upload-url",
    { method: "POST", body: JSON.stringify(input) },
  );
  return res.data;
}

/**
 * Send the file bytes directly to Supabase using the signed URL.
 * Supabase signed-upload URLs are POST-only and require the auth headers
 * returned alongside the URL.
 */
export async function uploadToSignedUrl(
  signed: UploadUrlResponse,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.open(signed.method, signed.uploadUrl);
    for (const [k, v] of Object.entries(signed.headers)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.send(file);
  });
}

export async function markDocumentUploaded(
  claimId: string,
  body: ClaimDocumentInput,
): Promise<ClaimDocument> {
  const res = await portalApiFetch<{ data: ClaimDocument }>(
    `/renovation/claims/${claimId}/documents/mark-uploaded`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return res.data;
}

export async function deleteClaimDocument(
  claimId: string,
  docId: string,
): Promise<void> {
  await portalApiFetch<{ data: { id: string } }>(
    `/renovation/claims/${claimId}/documents/${docId}`,
    { method: "DELETE" },
  );
}

export async function getDocumentViewUrl(
  claimId: string,
  docId: string,
): Promise<{ viewUrl: string; expiresAt: string }> {
  const res = await portalApiFetch<{
    data: { viewUrl: string; expiresAt: string };
  }>(`/renovation/claims/${claimId}/documents/${docId}/view-url`);
  return res.data;
}
