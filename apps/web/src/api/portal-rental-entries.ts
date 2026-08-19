import { portalApiFetch } from "@/lib/portal-api";

export type CreateRentalEntryPayload = {
  propertyId: string;
  unitCode: string;
  unitType: string;
  bedrooms?: number;
  bathrooms?: number;
  floorArea?: number;
  sizeSqft?: number;
  floor?: number;
  facing?: string;
  furnishingLevel?: string;
  // NOTE: parkingLots intentionally omitted — Unit schema has no such column
  // (Plan 1 carryover note). Until Unit.parkingLots is added or a UnitAttribute
  // mapping ships, do not collect it in the UI.
  baseRentAmount?: number;
  rentalRate?: number;
  // Required: every new rental entry must declare both deposits up front.
  depositMonths: number;
  utilitiesDepositMonths: number;
  amenities?: string[];
  publishedTitle?: string;
  publishedDescription?: string;
  photoKeys?: string[];
  videoKeys?: string[];
};

export type CreateRentalEntryResponse = {
  data: {
    unit: {
      id: string;
      propertyId: string;
      unitCode: string;
      sourcingApproved: boolean;
      listingStatus: string;
    };
  };
  warnings: string[];
};

// Mounted at /inventory/agent-listings (NOT /inventory/units — admin path
// already uses that). Per Plan 1 carryover note.
export function createRentalEntry(
  payload: CreateRentalEntryPayload,
): Promise<CreateRentalEntryResponse> {
  return portalApiFetch<CreateRentalEntryResponse>("/inventory/agent-listings", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
