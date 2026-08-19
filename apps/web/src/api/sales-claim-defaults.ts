import { apiFetch } from "@/lib/api-client";

export type SalesClaimDefault = {
  id: string;
  organizationId: string;
  appliesTo: string;
  commissionType: "percent_of_purchase" | "fixed";
  commissionValue: string;
  paymentType: "full" | "partial";
  notes: string | null;
  updatedAt: string;
  updatedById: string | null;
  defaultSplits: Array<{
    id: string;
    organizationId: string;
    defaultId: string;
    roleLabel: string;
    splitType: "percent" | "fixed";
    splitValue: string;
    sortOrder: number;
  }>;
};

export function getSalesClaimDefault(): Promise<{ data: SalesClaimDefault }> {
  return apiFetch<{ data: SalesClaimDefault }>(`/sales-claim-defaults?appliesTo=__catchall__`);
}

export type UpsertSalesClaimDefaultInput = {
  appliesTo?: string;
  commissionType: "percent_of_purchase" | "fixed";
  commissionValue: number;
  paymentType: "full" | "partial";
  notes?: string | null;
  splits: Array<{
    roleLabel: string;
    splitType: "percent" | "fixed";
    splitValue: number;
    sortOrder?: number;
  }>;
};

export function upsertSalesClaimDefault(
  input: UpsertSalesClaimDefaultInput,
): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>("/sales-claim-defaults", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
