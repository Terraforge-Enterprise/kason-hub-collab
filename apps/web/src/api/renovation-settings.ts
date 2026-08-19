/**
 * Renovation settings API client (admin).
 *
 * Wraps two backend modules:
 *  - `renovation-claims` packages CRUD at `/renovation/packages`
 *    (shipped in W2b, see apps/api/src/modules/renovation-claims/renovation-claims.routes.ts)
 *  - `renovation-settings` labels CRUD at `/settings/renovation/labels`
 *    (shipped in W2d, see apps/api/src/modules/renovation-settings/renovation-settings.routes.ts)
 *
 * Read endpoints permit Editor+. Write endpoints (POST/PATCH/DELETE) require
 * Admin and the backend enforces the same gate.
 */
import { apiFetch } from "@/lib/api-client";

// ─── Packages ────────────────────────────────────────────────────────────────

export type SplitType = "percent" | "fixed";

export interface RenovationPackageSplit {
  id: string;
  organizationId: string;
  packageId: string;
  roleLabel: string;
  splitType: SplitType;
  splitValue: number;
  isHouseKeep: boolean;
  sortOrder: number;
}

export interface RenovationPackage {
  id: string;
  organizationId: string;
  key: string;
  label: string;
  description: string | null;
  defaultPrice: number;
  archived: boolean;
  sortOrder: number;
  // Server returns Date objects in `RenovationPackageRow`; over JSON these arrive
  // as ISO strings, so the client-side type is `string`.
  createdAt: string;
  updatedAt: string;
  defaultSplits: RenovationPackageSplit[];
}

export interface PackageSplitInput {
  roleLabel: string;
  splitType: SplitType;
  splitValue: number;
  isHouseKeep: boolean;
  sortOrder: number;
}

export interface CreatePackagePayload {
  key: string;
  label: string;
  description?: string | null;
  defaultPrice: number;
  archived?: boolean;
  sortOrder?: number;
  defaultSplits?: PackageSplitInput[];
}

export interface UpdatePackagePayload {
  label?: string;
  description?: string | null;
  defaultPrice?: number;
  archived?: boolean;
  sortOrder?: number;
  defaultSplits?: PackageSplitInput[];
}

export function listRenovationPackages(opts?: {
  archived?: boolean;
}): Promise<{ data: RenovationPackage[] }> {
  const sp = new URLSearchParams();
  if (opts?.archived !== undefined) {
    sp.set("archived", opts.archived ? "true" : "false");
  }
  const qs = sp.toString();
  return apiFetch<{ data: RenovationPackage[] }>(
    `/renovation/packages${qs ? `?${qs}` : ""}`,
  );
}

export function createRenovationPackage(
  payload: CreatePackagePayload,
): Promise<{ data: RenovationPackage }> {
  return apiFetch<{ data: RenovationPackage }>(`/renovation/packages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateRenovationPackage(
  id: string,
  payload: UpdatePackagePayload,
): Promise<{ data: RenovationPackage }> {
  return apiFetch<{ data: RenovationPackage }>(`/renovation/packages/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

// ─── Settings Labels ─────────────────────────────────────────────────────────

export type LabelCategory =
  | "claim_status"
  | "renovation_status"
  | "document_kind"
  | "payment_type";

export interface SettingsLabel {
  id: string;
  organizationId: string;
  category: LabelCategory;
  key: string;
  label: string;
  sortOrder: number;
}

export interface GroupedLabels {
  claim_status: SettingsLabel[];
  renovation_status: SettingsLabel[];
  document_kind: SettingsLabel[];
  payment_type: SettingsLabel[];
}

export interface CreateLabelPayload {
  category: LabelCategory;
  key: string;
  label: string;
  sortOrder?: number;
}

export interface UpdateLabelPayload {
  label?: string;
  sortOrder?: number;
}

export function listRenovationLabels(): Promise<{ data: GroupedLabels }> {
  return apiFetch<{ data: GroupedLabels }>(`/settings/renovation/labels`);
}

export function createRenovationLabel(
  payload: CreateLabelPayload,
): Promise<{ data: SettingsLabel }> {
  return apiFetch<{ data: SettingsLabel }>(`/settings/renovation/labels`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateRenovationLabel(
  id: string,
  payload: UpdateLabelPayload,
): Promise<{ data: SettingsLabel }> {
  return apiFetch<{ data: SettingsLabel }>(
    `/settings/renovation/labels/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );
}

export function deleteRenovationLabel(
  id: string,
): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>(
    `/settings/renovation/labels/${id}`,
    { method: "DELETE" },
  );
}

/**
 * Frontend-enforced immutable-key list. The server validation does not block
 * deletion of these rows (key is just a string column), but every renovation
 * status machine in the API references these exact codes — deleting them
 * would orphan UI labels for in-flight claims. The list mirrors:
 *   - `claimStatusEnum` in renovation-claims.validation.ts
 *   - The hardcoded `RenovationStatus` set in sales/sales.types.ts
 *
 * Document kinds also live as an enum in the API (`documentKindEnum`) but
 * admins ARE allowed to add user-facing labels — the immutable subset is
 * just the three canonical kinds.
 */
export const IMMUTABLE_CLAIM_STATUS_KEYS = [
  "submitted",
  "pending_approval",
  "approved",
  "rejected",
  "needs_amendment",
] as const;

export const IMMUTABLE_RENOVATION_STATUS_KEYS = [
  "not_started",
  "on_going",
  "completed",
] as const;

export const IMMUTABLE_DOCUMENT_KIND_KEYS = [
  "quotation",
  "invoice",
  "agreement",
] as const;
