import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CommissionSettingsResponse } from "@kason/shared";
import { apiFetch } from "@/lib/api-client";

/**
 * Consolidated commission & TA settings hooks for the /commissions/settings page.
 *
 * One aggregate read, four slice-scoped mutations. Every mutation invalidates
 * the aggregate cache (so the page refetches) plus any downstream caches that
 * consume the same data (e.g. the portal TA-tier lookup).
 */

export const COMMISSION_SETTINGS_KEY = ["commission-settings"] as const;

// ── Aggregate read ──────────────────────────────────────────────────────────

export function useCommissionSettings() {
  return useQuery({
    queryKey: COMMISSION_SETTINGS_KEY,
    queryFn: () =>
      apiFetch<{ data: CommissionSettingsResponse }>("/commissions/settings").then(
        (res) => res.data,
      ),
    staleTime: 30_000,
  });
}

// ── TA Tiers (Super Admin only) ────────────────────────────────────────────

type CreateTaTierInput = {
  tier: number;
  rentalMin: string;
  // `rentalMax` is the inclusive upper bound; null means open-ended (highest
  // band catches every rental above its rentalMin).
  rentalMax?: string | null;
  companyMinimum: string;
};

type UpdateTaTierInput = {
  id: string;
  rentalMin?: string;
  rentalMax?: string | null;
  companyMinimum?: string;
  updatedAt: string;
};

export function useCreateTaTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaTierInput) =>
      apiFetch<{ data: unknown }>("/commissions/settings/ta-tiers", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: COMMISSION_SETTINGS_KEY });
      qc.invalidateQueries({ queryKey: ["portal", "ta-tier"] });
    },
  });
}

export function useUpdateTaTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...rest }: UpdateTaTierInput) =>
      apiFetch<{ data: unknown }>(`/commissions/settings/ta-tiers/${id}`, {
        method: "PUT",
        body: JSON.stringify(rest),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: COMMISSION_SETTINGS_KEY });
      qc.invalidateQueries({ queryKey: ["portal", "ta-tier"] });
    },
  });
}

export function useDeleteTaTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: unknown }>(`/commissions/settings/ta-tiers/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: COMMISSION_SETTINGS_KEY });
      qc.invalidateQueries({ queryKey: ["portal", "ta-tier"] });
    },
  });
}

// ── Tier Mappings (manager+ POST/PUT — percentage / isActive) ──────────────

type CreateTierMappingInput = {
  claimType: "tenant_portion" | "listing_portion" | "tenant_listing_portion";
  agentLevel: "new_agent" | "pre_leader" | "leader";
  percentage: string;
};

type UpdateTierMappingInput = {
  id: string;
  updatedAt: string;
  percentage?: string;
  isActive?: boolean;
};

export function useCreateTierMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTierMappingInput) =>
      apiFetch<unknown>("/commissions/tier-mappings", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: COMMISSION_SETTINGS_KEY });
      qc.invalidateQueries({ queryKey: ["commissions", "tier-mappings"] });
      qc.invalidateQueries({ queryKey: ["agent-tier-mapping"] });
    },
  });
}

export function useUpdateTierMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateTierMappingInput) =>
      apiFetch<unknown>(`/commissions/tier-mappings/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: COMMISSION_SETTINGS_KEY });
      qc.invalidateQueries({ queryKey: ["commissions", "tier-mappings"] });
      // Portal claim-new pulls tier-mappings to compute commission %.
      qc.invalidateQueries({ queryKey: ["agent-tier-mapping"] });
    },
  });
}

// ── Room Types (manager+ PUT/POST, admin-only DELETE) ──────────────────────

type CreateRoomTypeInput = { name: string; kind?: "WHOLE" | "PARTITION"; sortOrder?: number; isActive?: boolean };
type UpdateRoomTypeInput = {
  id: string;
  name?: string;
  kind?: "WHOLE" | "PARTITION";
  sortOrder?: number;
  isActive?: boolean;
};

// Shared across commission and inventory settings sections so both caches
// stay consistent whenever room-type mutations fire.
const INVENTORY_UNIT_TYPES_KEY = ["inventory-settings", "unit-types"] as const;

function invalidateRoomTypeQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: COMMISSION_SETTINGS_KEY });
  qc.invalidateQueries({ queryKey: ["commissions", "room-types"] });
  qc.invalidateQueries({ queryKey: ["portal", "room-types"] });
  qc.invalidateQueries({ queryKey: INVENTORY_UNIT_TYPES_KEY });
}

export function useCreateRoomType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoomTypeInput) =>
      apiFetch<unknown>("/commissions/room-types", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidateRoomTypeQueries(qc),
  });
}

export function useUpdateRoomType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateRoomTypeInput) =>
      apiFetch<unknown>(`/commissions/room-types/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateRoomTypeQueries(qc),
  });
}

export function useDeleteRoomType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<unknown>(`/commissions/room-types/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateRoomTypeQueries(qc),
  });
}

// ── Level Thresholds (manager+ PUT per agentLevel) ─────────────────────────

type UpdateLevelThresholdInput = {
  agentLevel: "pre_leader" | "leader";
  minCumulativeCommission: string;
  updatedAt: string;
};

export function useUpdateLevelThreshold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentLevel, ...body }: UpdateLevelThresholdInput) =>
      apiFetch<{ ok: boolean; data: { id: string; updatedAt: string; bumpedAgentCount: number } }>(
        `/commissions/level-thresholds/${agentLevel}`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: COMMISSION_SETTINGS_KEY });
      qc.invalidateQueries({ queryKey: ["commissions", "level-thresholds"] });
    },
  });
}

// ── Preview (no-op estimate) ────────────────────────────────────────────────

type PreviewLevelThresholdInput = {
  agentLevel: "pre_leader" | "leader";
  minCumulativeCommission: string;
};

/**
 * Dry-run a level-threshold change to find out how many agents would be
 * auto-promoted if the new minimum were saved. Nothing is persisted. The
 * consolidated Settings page uses this to show a confirm dialog when the
 * preview returns bumpedAgentCount > 0.
 */
export function usePreviewLevelThreshold() {
  return useMutation({
    mutationFn: ({ agentLevel, ...body }: PreviewLevelThresholdInput) =>
      apiFetch<{ data: { bumpedAgentCount: number } }>(
        `/commissions/level-thresholds/${agentLevel}/preview`,
        { method: "POST", body: JSON.stringify(body) },
      ),
  });
}
