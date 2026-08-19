// apps/web/src/features/inventory-explorer/domain/types.ts

export type Decimalish = string | number;

export type InventoryListing = {
  id: string;
  unitCode: string;
  unitType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  floorArea: number | null;
  rentalRate: Decimalish | null;
  currency: string;
  moveInDate: string | null;
  readyNow: boolean;
  occupancyStatus: string;
  inChargeName: string | null;
  inChargePartyId: string | null;
  photoKeys: string[];
  videoKeys: string[];
  coverPhotoUrl: string | null;
  title: string | null;
  description: string | null;
  amenities: { id: string; name: string }[];
  furnishingLevel: string | null;
  floor: number | null;
  facing: string | null;
  depositMonths: number | null;
  utilitiesDepositMonths: number | null;
  accessCardDepositPerPcs: number | null;
  accessCardQuantity: number | null;
  parkingQuantity: number | null;
  parkingNumbers: string[];
  vacantSince: string | null;
  listingStatus: string;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  // `sourceFlag` and `sourcingApproved` are DERIVED back-compat fields after
  // the three-table refactor (2026-05-19). Listings in the inventory tree
  // are approved by definition (pending agent submissions live in
  // UnitSubmission). New code should read `sourcingAgentId IS NOT NULL`
  // directly instead of `sourceFlag === "AGENT_SOURCED"`. These remain
  // emitted on the wire for one release of SPA back-compat; drop in a
  // follow-up cleanup.
  /** @deprecated Use `sourcingAgentId !== null` instead. */
  sourceFlag: "COMPANY" | "AGENT_SOURCED";
  sourcingAgentId: string | null;
  sourcingAgentName: string | null;        // joined from sourcingAgent.displayName
  /** @deprecated Always true for inventory rows; pending lives in UnitSubmission. */
  sourcingApproved: boolean;
  createdAt: string;
  currentTenancyStartDate: string | null;
  currentTenancyEndDate: string | null;
  property: { name: string; city: string | null };
};

/** @deprecated Use InventoryListing. Kept for one-release backward compat. */
export type PortalUnit = InventoryListing;

export type SortKey =
  | "ready"
  | "price-asc"
  | "price-desc"
  | "sqft-desc"
  | "newest"
  | "beds-desc";

export type ViewMode = "grid" | "list";
export type GroupKey = "building" | "none";
export type SourceFilter = "company" | "agent_sourced";

export const ENDING_SOON_WINDOW_DAYS = 60;

export type Availability = "now" | "occupied" | "all";

export type DepositChoice = number;

export type InventoryFilters = {
  q: string;
  availability: Availability;            // NEW — replaces ready + showOccupied
  beds: number[];          // 0 means studio (null bedrooms)
  baths: number[];         // 1, 2, or 3 (3 means "3+")
  priceMin: number | null;
  priceMax: number | null;
  sqftMin: number | null;
  sqftMax: number | null;
  // YYYY-MM-DD strings — compared lexicographically to moveInDate's first 10
  // chars. Filters against Unit.moveInDate (the scheduled next move-in for
  // an upcoming tenancy), NOT against the active tenancy's start date.
  moveInFrom: string | null;
  moveInTo: string | null;
  // YYYY-MM-DD strings — compared lexicographically to currentTenancyEndDate's
  // first 10 chars. Never construct a Date from these values: timezone shift
  // would silently move the boundary off the day the user picked.
  moveOutFrom: string | null;
  moveOutTo: string | null;
  types: string[];
  cities: string[];
  buildings: string[];     // building names (Property.name) — multi-select
  inCharge: string[];      // inChargePartyId
  sources: SourceFilter[];
  sourcedByPartyIds: string[];           // NEW — colleague picker
  furnishingLevels: string[];            // NEW
  amenities: string[];                   // NEW
  // Inclusive numeric range against Unit.floor. null = unbounded on that side.
  // Compared with >= / <=, so { floorMin: 1, floorMax: 10 } keeps floors 1–10.
  floorMin: number | null;
  floorMax: number | null;
  facings: string[];                     // normalized single-letter uppercase ("N"/"S"/"E"/"W"); cardinality hook normalizes raw data
  vacantSinceMinDays: number | null;     // NEW
  depositMonthsMax: DepositChoice | null;
};

export const EMPTY_FILTERS: InventoryFilters = {
  q: "",
  availability: "all",
  beds: [],
  baths: [],
  priceMin: null,
  priceMax: null,
  sqftMin: null,
  sqftMax: null,
  moveInFrom: null,
  moveInTo: null,
  moveOutFrom: null,
  moveOutTo: null,
  types: [],
  cities: [],
  buildings: [],
  inCharge: [],
  sources: [],
  sourcedByPartyIds: [],
  furnishingLevels: [],
  amenities: [],
  floorMin: null,
  floorMax: null,
  facings: [],
  vacantSinceMinDays: null,
  depositMonthsMax: null,
};

export type Bucket = {
  buildingName: string;
  city: string | null;
  units: InventoryListing[];
};
