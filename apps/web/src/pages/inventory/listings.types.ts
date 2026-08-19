// ListingRow — shape returned by GET /api/listings (admin) and /api/listings/:id.
// Mirrors the server-side Listing type. Lives here (not inside listing-drawer.tsx)
// so the type survives the deletion of the orphaned drawer component in
// the inventory redesign.

type Decimalish = string | number;

export type ListingRow = {
  id: string;
  organizationId: string;
  propertyId: string;
  buildingId: string | null;
  unitCode: string;
  unitType: string;
  occupancyStatus: string;
  listingStatus: string;
  currency: string;
  bedrooms: number | null;
  bathrooms: number | null;
  floorArea: number | null;
  rentalRate: Decimalish | null;
  photoKeys: string[];
  videoKeys: string[];
  amenities: string[];
  moveInDate: string | null;
  readyNow: boolean;
  inChargeName: string | null;
  inChargePartyId: string | null;
  sourceFlag: "COMPANY" | "AGENT_SOURCED";
  sourcingAgentId: string | null;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  sourcingApproved: boolean;
  sourcingApprovedById: string | null;
  sourcingApprovedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Deposits + parking (inventory upload extension). Optional on the wire so
  // older API builds round-trip cleanly while the SPA treats absent === null.
  depositMonths?: number | null;
  utilitiesDepositMonths?: number | null;
  accessCardDepositPerPcs?: number | null;
  accessCardQuantity?: number | null;
  parkingQuantity?: number | null;
  parkingNumbers?: string[];
};
