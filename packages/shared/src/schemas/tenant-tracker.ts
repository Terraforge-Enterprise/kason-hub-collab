// Tenant Tracker (M1) — shared contracts between apps/api and apps/web.
// Plan: docs/superpowers/plans/2026-06-11-phase2-tenant-tracker.md (Step 1).
//
// Grouping model (decided 2026-06-12 from mock-page evidence): the page groups
// by APARTMENT (the real-world "unit", e.g. A-10-3A); each Apartment's rooms
// are Listings (one per `listingType` — Master/Studio/…). Tenancy.unitId
// points at a Listing (room). PIC (`inChargePartyId`) is per-Listing.

import { z } from "zod";

/**
 * Query for `GET /api/tenant-tracker` (grouped list).
 *
 * - `propertyId` — optional filter to a single Property (uuid).
 * - `agent` — raw EXACT match on `Tenancy.agentLabel` (no normalization).
 * - `status` semantics (`Tenancy.status` is an open String with a live third
 *   value `"terminated"`):
 *   - `"active"` = `tenancy.status === "active"`
 *   - `"ended"`  = `tenancy.status !== "active"` (catches `"terminated"`)
 *   - `"all"`    = no status filter
 * - `roomType` — matches `Listing.listingType`.
 * - `q` — tenant displayName contains.
 * - `phone` — digits matched against `Party.primaryPhone` (normalized
 *   server-side; pass digits or formatted input).
 * - `cursor` — opaque pagination cursor from a previous page's `nextCursor`.
 * - `limit` — page size (coerced number, int, 1–100, default 25).
 */
export const tenantTrackerListQuerySchema = z.object({
  propertyId: z.string().uuid().optional(),
  agent: z.string().optional(),
  status: z.enum(["active", "ended", "all"]).default("active"),
  roomType: z.string().optional(),
  q: z.string().optional(),
  phone: z.string().optional(),
  /**
   * Hide units with zero ACTIVE-tenancy rooms (spec 2026-06-12 §3.3).
   * z.stringbool with explicit truthy/falsy lists, NOT z.coerce.boolean() —
   * Boolean("false") === true would invert ?occupiedOnly=false. Restricting to
   * ["true","1"] / ["false","0"] also rejects garbage inputs like "yes".
   * Optional (no default): absent = off, and the client omits it unless true.
   */
  occupiedOnly: z.stringbool({ truthy: ["true", "1"], falsy: ["false", "0"] }).optional(),
  /**
   * Filter to a specific billing period (YYYY-MM format). Optional; service
   * defaults to current month when omitted. Used by later tasks to fetch
   * electricity readings for the given period.
   */
  period: z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM").optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type TenantTrackerListQuery = z.infer<typeof tenantTrackerListQuerySchema>;

/**
 * Query for `GET /api/tenant-tracker/lookup` (⌘K phone-search-to-act).
 * Accepts digits or formatted input; normalized server-side via
 * `normalizeMyPhone` and suffix-matched against `Party.primaryPhone`.
 */
export const tenantTrackerLookupQuerySchema = z.object({
  phone: z.string().min(4),
});

export type TenantTrackerLookupQuery = z.infer<typeof tenantTrackerLookupQuerySchema>;

/**
 * Body for `PATCH /api/tenant-tracker/:unitId/in-charge`.
 * `inChargePartyId: null` = unassign. `expectedUpdatedAt` is the optimistic
 * concurrency token — the Listing's `updatedAt` the client last saw.
 */
export const assignInChargeSchema = z.object({
  inChargePartyId: z.string().uuid().nullable(),
  expectedUpdatedAt: z.string().datetime().optional(),
});

export type AssignInChargeInput = z.infer<typeof assignInChargeSchema>;

/**
 * Body for `POST /api/tenant-tracker/ic-reveal` — the audited, mgr+-only
 * unmasked-IC path (O3). One audit row per reveal is recorded server-side in
 * the same transaction that serves the value.
 */
export const icRevealBodySchema = z.object({
  partyId: z.string().uuid(),
});

export type IcRevealBody = z.infer<typeof icRevealBodySchema>;

// ---------------------------------------------------------------------------
// Response types (plain TS — convention per packages/shared/src/types/*).
// Dates serialize as ISO strings; Prisma Decimal money fields convert to
// number via .toNumber() in the API (repo convention — see
// types/tenancy.ts monthlyRentAmount / tenancy.repository.ts).
// ---------------------------------------------------------------------------

/**
 * Electricity billing status for a room in the current period. Populated by
 * meter readings; null when the meter is flagged off or no (non-void) reading
 * exists for the period.
 */
export type ElectricityStatus = {
  readingId: string;
  status: "submitted" | "charged";
  kwh: number;
  amount: number;
};

/**
 * Tenant contact in list payloads. The list NEVER carries an unmasked IC:
 * `idNumberMasked` shows only the last 4 chars (e.g. "••••1234"), null when
 * absent. The unmasked IC comes only from the separate mgr+-only ic-reveal
 * endpoint (`IcRevealResponse`).
 */
export type TrackerContact = {
  partyId: string;
  displayName: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
  gender: string | null;
  idType: string | null;
  idNumberMasked: string | null;
};

export type TrackerTenancy = {
  id: string;
  status: string;
  startDate: string;
  endDate: string | null;
  termMonths: number | null;
  /** Renewal-chain label, e.g. "1Y + 1Y"; null when not derivable. */
  termLabel: string | null;
  /** Prisma Decimal converted via .toNumber() (repo convention). */
  monthlyRentAmount: number | null;
  numberOfPax: number | null;
  agentLabel: string | null;
  accessCardNo: string | null;
  party: TrackerContact;
};

/**
 * One room (Listing) within an Apartment group. `tenancies` is filtered per
 * the list query's `status` param; an empty array means the room is vacant.
 */
export type TrackerRoom = {
  unit: {
    id: string;
    listingType: string;
    occupancyStatus: string;
    /** Prisma Decimal converted via .toNumber() (repo convention). */
    baseRentAmount: number | null;
    /** Prisma Decimal converted via .toNumber() (repo convention). */
    rentalRate: number | null;
    accessCardQuantity: number | null;
    parkingNumbers: string[];
    updatedAt: string;
  };
  /** PIC via FK join (`Listing.inChargePartyId`) — the source of truth. */
  inChargeParty: { id: string; displayName: string } | null;
  /**
   * Denormalized display copy of the PIC's name, written alongside the FK on
   * assign. The UI renders `inChargeName`, falling back to
   * `inChargeParty.displayName`.
   */
  inChargeName: string | null;
  /**
   * Count of ACTIVE tenancies on this room, independent of the list query's
   * `status` scope (which filters `tenancies`). Lets the UI keep occupancy
   * fractions + vacancy collapse truthful under status=ended/all.
   */
  activeTenancyCount: number;
  /** Current-period electricity billing state; null = no (non-void) reading, or meter flag off. */
  electricity: ElectricityStatus | null;
  tenancies: TrackerTenancy[];
};

/**
 * Carpark bay occupancy, sourced from CarparkAssignment (not a Listing). Rendered
 * as a chip on the Apartment group — never as a room row.
 */
export type TrackerCarpark = {
  tenancyId: string;
  partyId: string;
  displayName: string;
  slotLabel: string | null;
  unitId: string;
  status: string;
};

/** One Apartment group (the page's card unit, e.g. A-10-3A). */
export type TrackerGroup = {
  apartment: {
    id: string;
    unitCode: string;
    floor: number | null;
    bedrooms: number | null;
  };
  property: {
    id: string;
    name: string;
    propertyCode: string | null;
  };
  rooms: TrackerRoom[];
  carparks: TrackerCarpark[];
};

export type TrackerListResponse = {
  groups: TrackerGroup[];
  nextCursor: string | null;
};

/** One hit from `GET /api/tenant-tracker/lookup` (phone-search-to-act). */
export type TrackerLookupHit = {
  tenancyId: string;
  unitId: string;
  apartmentId: string;
  propertyId: string;
  displayName: string;
  unitCode: string;
};

/** `GET /api/tenant-tracker/agents` — distinct non-null `Tenancy.agentLabel`. */
export type TrackerAgentsResponse = {
  agents: string[];
};

/**
 * `POST /api/tenant-tracker/ic-reveal` — mgr+-only; each call is
 * audited server-side. The ONLY payload that carries an unmasked IC.
 */
export type IcRevealResponse = {
  partyId: string;
  idNumber: string;
};

/**
 * Success payload of `PATCH /api/tenant-tracker/:unitId/in-charge` — echoes
 * the applied assignment (both fields null on unassign; `inChargeName` is
 * the denormalized display copy written alongside the FK).
 */
export type AssignInChargeResult = {
  inChargePartyId: string | null;
  inChargeName: string | null;
};

/**
 * `GET /api/tenant-tracker/summary` — org-wide + per-property counts for the
 * property rail, header metrics, and result line. All counts use room scope
 * (carpark pseudo-rooms excluded) and the always-ACTIVE occupancy definition;
 * they are status-filter independent (they describe the portfolio, not the
 * current filter result).
 */
export type TrackerPropertySummary = {
  propertyId: string;
  name: string;
  propertyCode: string | null;
  apartments: number;
  rooms: number;
  activeTenancies: number;
  vacantRooms: number;
};

export type TrackerSummaryResponse = {
  totals: { apartments: number; rooms: number; activeTenancies: number; vacantRooms: number };
  properties: TrackerPropertySummary[];
};
