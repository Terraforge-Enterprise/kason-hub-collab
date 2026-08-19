// Tenant Tracker (M1) — internal repository/service types.
// Shared request/response contracts live in packages/shared/src/schemas/tenant-tracker.ts.

import type { ElectricityStatus, TenantTrackerListQuery } from "@kason/shared";

/** List filters as seen by the repository (cursor/limit passed separately). */
export type TrackerFilters = Omit<TenantTrackerListQuery, "cursor" | "limit">;

/** Decoded composite pagination cursor — (property.name, apartment.unitCode, apartment.id). */
export type TrackerCursor = {
  propertyName: string;
  unitCode: string;
  apartmentId: string;
};

// ---------------------------------------------------------------------------
// Raw-but-shaped repository rows. Decimals are converted to number at the repo
// edge (tenancy.repository convention); Dates stay as Date — the service layer
// serializes to ISO strings and applies grouping/IC-masking.
// ---------------------------------------------------------------------------

export type TrackerTenancyRow = {
  id: string;
  status: string;
  startDate: Date;
  endDate: Date | null;
  termMonths: number | null;
  previousTenancyId: string | null;
  /** Prisma Decimal (non-null in schema) converted via .toNumber(). */
  monthlyRentAmount: number;
  numberOfPax: number | null;
  agentLabel: string | null;
  accessCardNo: string | null;
  previousTenancy: { id: string; termMonths: number | null } | null;
  /**
   * idNumber IS selected here — masking happens in the service. This row type
   * must never leak through a route without passing the service layer.
   */
  tenantParty: {
    id: string;
    displayName: string;
    primaryPhone: string | null;
    primaryEmail: string | null;
    gender: string | null;
    idType: string | null;
    idNumber: string | null;
  };
};

export type TrackerListingRow = {
  id: string;
  listingType: string;
  occupancyStatus: string;
  /** Prisma Decimal converted via .toNumber(). */
  baseRentAmount: number | null;
  /** Prisma Decimal converted via .toNumber(). */
  rentalRate: number | null;
  accessCardQuantity: number | null;
  parkingNumbers: string[];
  inChargePartyId: string | null;
  inChargeName: string | null;
  updatedAt: Date;
  inChargeParty: { id: string; displayName: string } | null;
  /** ACTIVE-tenancy count, independent of the list query's status scope. */
  activeTenancyCount: number;
  /** Scoped by the list query's `status` only — never by agent/q/phone. */
  tenancies: TrackerTenancyRow[];
  /** Current-period electricity reading, merged in by the service. Null when absent. */
  electricity?: ElectricityStatus | null;
};

/**
 * Raw row from `carparkAssignment.findMany`, shaped for the tracker carpark
 * display. Fetched by `findCarparkAssignmentsForApartments` after the main
 * apartment query; the apartment id comes from the nested `carpark.apartmentId`.
 */
export type TrackerCarparkRow = {
  id: string;
  tenancyId: string;
  status: string;
  carpark: {
    id: string;
    apartmentId: string;
    label: string;
  };
  tenancy: {
    tenantParty: {
      id: string;
      displayName: string;
    };
  };
};

export type TrackerApartmentRow = {
  id: string;
  unitCode: string;
  floor: number | null;
  bedrooms: number | null;
  property: { id: string; name: string; propertyCode: string | null };
  /** All room Listings — carparks are now in CarparkAssignment, not here. */
  listings: TrackerListingRow[];
};

export type TrackerPage = {
  apartments: TrackerApartmentRow[];
  nextCursor: string | null;
};
