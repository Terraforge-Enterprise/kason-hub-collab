import type { z } from "zod";
import type { createListingSchema, updateListingSchema, listListingsQuery } from "./listings.validation";

export type ListingsSession = {
  userId: string;
  orgId: string;
  role: string;
};

export type CreateListingInput = z.infer<typeof createListingSchema>;
export type UpdateListingInput = z.infer<typeof updateListingSchema>;
export type ListListingsQuery = z.infer<typeof listListingsQuery>;

// Subset of Listing + Apartment columns returned by list/fetch endpoints.
//
// The wire shape preserves the legacy admin-side keys (`propertyId`,
// `unitCode`, `unitType`, `bedrooms`, `amenities`, `photoKeys`, etc.) at the
// top level so the SPA doesn't need a parallel rewrite — the underlying
// physical storage moved (apartment-shared fields live on Apartment now,
// `unitType` is renamed to `listingType`) but the API edge surface stays
// backward-compatible until Phase C migrates the web layer.
//
// Derived for wire-compat (will be dropped in Phase C):
//   - `sourceFlag`: "AGENT_SOURCED" iff `sourcingAgentId` is non-null, else
//     "COMPANY". Every row in Listing is by definition approved (pending
//     submissions live in UnitSubmission), so the historical
//     `sourceFlag`/`sourcingApproved` columns no longer exist on the row;
//     callers that key on them still receive a stable value.
//   - `sourcingApproved`: always `true` (every Listing is approved by
//     definition).
export interface ListingRow {
  id: string;
  organizationId: string;
  propertyId: string;
  propertyName: string;
  propertyCode: string;
  unitCode: string;
  // wire-compat: top-level `unitType` mirrors `listingType` until the web
  // migrates. Same string value.
  unitType: string;
  listingType: string;
  occupancyStatus: string;
  listingStatus: string;
  currency: string;
  bedrooms: number | null;
  bathrooms: number | null;
  floorArea: number | null;
  rentalRate: number | null;
  photoKeys: string[];
  coverPhotoKey: string | null;
  videoKeys: string[];
  amenities: string[];
  moveInDate: Date | null;
  readyNow: boolean;
  inChargeName: string | null;
  inChargePartyId: string | null;
  sourcingAgentId: string | null;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  // Derived wire-compat fields. TODO: drop in Phase C.
  sourceFlag: "COMPANY" | "AGENT_SOURCED";
  sourcingApproved: boolean;
  createdAt: Date;
  updatedAt: Date;
}
