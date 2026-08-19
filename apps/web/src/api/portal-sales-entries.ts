import { portalApiFetch } from "@/lib/portal-api";

export type CreateSalesEntryPayload = {
  project:
    | { mode: "existing"; id: string }
    | {
        mode: "new";
        name: string;
        developer: string;
        city?: string;
        expectedHandover?: string;
        notes?: string;
      };
  unitNumber: string;
  ownerPartyId: string;
  salesDate: string;
  purpose: "rent" | "own_stay";
  purchasePrice: number;
  bedrooms: number;
  bathrooms: number;
  parkingLots: number;
  expectedRental?: number;
  renovation?: {
    packageId: string;
    packagePrice: number;
    paymentType: "full" | "partial" | "offset_from_rental";
    monthlyOffsetAmount?: number;
    splits: Array<{
      partyPartyId?: string | null;
      partyDisplayName: string;
      roleLabel: string;
      splitType: "percent" | "fixed";
      splitValue: number;
      isHouseKeep?: boolean;
      sortOrder?: number;
    }>;
    notes?: string | null;
    documents?: Array<{ kind: string; fileKey: string; filename: string }>;
  };
};

export type CreateSalesEntryResponse = {
  data: {
    salesUnit: { id: string; projectId: string; unitNumber: string; sourcingApproved: boolean };
    salesClaim: { id: string; status: string };
    renovationClaim: { id: string; status: string } | null;
    renovationProgress: { id: string; status: string; stagesSeeded: number } | null;
    project: { id: string; status: string } | null;
  };
  warnings: string[];
};

export function createSalesEntry(
  payload: CreateSalesEntryPayload,
): Promise<CreateSalesEntryResponse> {
  return portalApiFetch<CreateSalesEntryResponse>("/sales/entries", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
