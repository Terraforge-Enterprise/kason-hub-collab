/**
 * Organization Card Settings — admin API client.
 *
 * Wraps `GET /api/organization-card-settings` (read) and
 * `PUT /api/organization-card-settings` (update). Both endpoints require
 * `editor` role server-side and return the standard `{ data: T }` envelope
 * (see `apps/api/src/modules/organization-card-settings/routes.ts`).
 *
 * Per spec §6.1 + §7.4, the `isConfigured` field is the load-bearing gate:
 * agent-creation drawer "submit" is disabled until it flips true (admin has
 * filled agencyName + agencyLicense + addressLine1).
 */
import { apiFetch } from "@/lib/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface OrgCardSettings {
  id: string;
  organizationId: string;
  agencyName: string | null;
  agencyLicense: string | null;
  agencyPhone: string | null;
  agencyFax: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  addressLine4: string | null;
  cardExpiryMonths: number;
  isConfigured: boolean;
  logoKey: string | null;
  // Printed on document headers (reservation form, invoice) when set;
  // falls back to the org's workspace display name when null.
  legalEntityName: string | null;
}

export type UpdateOrgCardSettingsInput = Partial<
  Omit<OrgCardSettings, "id" | "organizationId" | "isConfigured" | "logoKey">
>;

const QUERY_KEY = ["organization-card-settings"] as const;

export function useOrgCardSettings() {
  return useQuery<OrgCardSettings>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await apiFetch<{ data: OrgCardSettings }>("/organization-card-settings");
      return res.data;
    },
  });
}

export function useUpdateOrgCardSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateOrgCardSettingsInput) => {
      const res = await apiFetch<{ data: OrgCardSettings }>(
        "/organization-card-settings",
        { method: "PUT", body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}
