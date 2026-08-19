// Tenant Tracker (M1) — service layer: grouping, IC masking, audited writes.
// Plan: docs/superpowers/plans/2026-06-11-phase2-tenant-tracker.md (Step 3).
//
// Shapes the repository's apartment-rooted raw rows into the wire contracts in
// packages/shared/src/schemas/tenant-tracker.ts and owns the module's ONLY
// writes (PIC assign + IC-reveal audit). Raw Party.idNumber NEVER leaves this
// layer in a list/lookup payload for ANY role — the unmasked IC exists only
// via the audited ic-reveal endpoint (recordIcRevealService, mgr+) and the
// admin-only export column (exportTrackerRowsService).

import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type {
  AssignInChargeInput,
  AssignInChargeResult,
  ElectricityStatus,
  TenantTrackerListQuery,
  TrackerAgentsResponse,
  TrackerCarpark,
  TrackerContact,
  TrackerGroup,
  TrackerListResponse,
  TrackerLookupHit,
  TrackerRoom,
  TrackerSummaryResponse,
  TrackerTenancy,
} from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import type { SessionPayload } from "../../lib/auth";
import { maskIdNumber } from "../../lib/ic-reveal";
export { maskIdNumber } from "../../lib/ic-reveal";
export { recordIcRevealService } from "../../lib/ic-reveal";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { withStaleCheck } from "../../lib/optimistic-update";
import {
  decodeTrackerCursor,
  findApartmentsForTracker,
  findCarparkAssignmentsForApartments,
  findCurrentPeriodElectricity,
  findListingForInCharge,
  findPartyInOrg,
  getTrackerSummary,
  listAgentLabels,
  lookupByPhone,
} from "./repository";
import type {
  TrackerApartmentRow,
  TrackerCarparkRow,
  TrackerFilters,
  TrackerListingRow,
  TrackerTenancyRow,
} from "./types";

// Result union + ok()/err() — mirrored from inventory/apartment.service.ts
// L13–18; routes consume `status` via `result.status as <codes>`.
type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error });

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Deterministic renewal-chain term label:
 * 12 → "1Y", 24 → "2Y", any other non-null n → "<n>M", null → null.
 * When the previous tenancy's termMonths is known the label chains as
 * "<prevLabel> + <currentLabel>" (e.g. "1Y + 1Y"). No current term → null —
 * a chain is never rendered without a current label.
 */
export function buildTermLabel(
  termMonths: number | null,
  previousTermMonths?: number | null,
): string | null {
  const current = termMonthsToLabel(termMonths);
  if (current === null) return null;
  const previous = termMonthsToLabel(previousTermMonths ?? null);
  return previous === null ? current : `${previous} + ${current}`;
}

function termMonthsToLabel(n: number | null): string | null {
  if (n === null) return null;
  if (n === 12) return "1Y";
  if (n === 24) return "2Y";
  return `${n}M`;
}

/**
 * Parse a `YYYY-MM` period string into the first-of-month UTC Date.
 * Falls back to the current month if period is absent or has an impossible
 * month value (the shared regex allows e.g. "2026-13" syntactically).
 */
export function firstOfMonth(period?: string): Date {
  if (period) {
    const match = /^(\d{4})-(\d{2})$/.exec(period);
    if (match) {
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      if (month >= 1 && month <= 12) {
        return new Date(Date.UTC(year, month - 1, 1));
      }
    }
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ---------------------------------------------------------------------------
// Repo-row → wire-contract shaping
// ---------------------------------------------------------------------------

function toContact(party: TrackerTenancyRow["tenantParty"]): TrackerContact {
  return {
    partyId: party.id,
    displayName: party.displayName,
    primaryPhone: party.primaryPhone,
    primaryEmail: party.primaryEmail,
    gender: party.gender,
    idType: party.idType,
    idNumberMasked: maskIdNumber(party.idNumber),
  };
}

function toTenancy(row: TrackerTenancyRow): TrackerTenancy {
  return {
    id: row.id,
    status: row.status,
    startDate: row.startDate.toISOString(),
    endDate: row.endDate ? row.endDate.toISOString() : null,
    termMonths: row.termMonths,
    termLabel: buildTermLabel(row.termMonths, row.previousTenancy?.termMonths),
    monthlyRentAmount: row.monthlyRentAmount,
    numberOfPax: row.numberOfPax,
    agentLabel: row.agentLabel,
    accessCardNo: row.accessCardNo,
    party: toContact(row.tenantParty),
  };
}

function toRoom(listing: TrackerListingRow): TrackerRoom {
  return {
    unit: {
      id: listing.id,
      listingType: listing.listingType,
      occupancyStatus: listing.occupancyStatus,
      baseRentAmount: listing.baseRentAmount,
      rentalRate: listing.rentalRate,
      accessCardQuantity: listing.accessCardQuantity,
      parkingNumbers: listing.parkingNumbers,
      updatedAt: listing.updatedAt.toISOString(),
    },
    inChargeParty: listing.inChargeParty,
    inChargeName: listing.inChargeName,
    activeTenancyCount: listing.activeTenancyCount,
    tenancies: listing.tenancies.map(toTenancy),
    electricity: listing.electricity ?? null,
  };
}

/** Map one active CarparkAssignment row to a TrackerCarpark wire entry. */
function toCarparkFromAssignment(row: TrackerCarparkRow): TrackerCarpark {
  return {
    tenancyId: row.tenancyId,
    partyId: row.tenancy.tenantParty.id,
    displayName: row.tenancy.tenantParty.displayName,
    slotLabel: row.carpark.label,
    unitId: row.carpark.id,
    status: row.status,
  };
}

/**
 * Shape one apartment row + its pre-fetched carpark assignments into a
 * TrackerGroup. All Listings are rooms (carparks live in CarparkAssignment,
 * not in Listings), so every listing goes to rooms[].
 */
function toGroup(row: TrackerApartmentRow, carparkRows: TrackerCarparkRow[]): TrackerGroup {
  return {
    apartment: {
      id: row.id,
      unitCode: row.unitCode,
      floor: row.floor,
      bedrooms: row.bedrooms,
    },
    property: row.property,
    // All listings are rooms — vacant rows (tenancies: []) are still rendered
    // because they are actionable (PIC assign, add charge).
    rooms: row.listings.map(toRoom),
    carparks: carparkRows.map(toCarparkFromAssignment),
  };
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** `GET /api/tenant-tracker` — grouped-by-apartment tracker list. */
export async function listTrackerService(
  session: SessionPayload,
  query: TenantTrackerListQuery,
): Promise<Result<TrackerListResponse>> {
  const { cursor, limit, ...filters } = query;

  // A malformed cursor is a caller bug — reject loudly instead of silently
  // serving page 1. The repo's internal null-fallback stays as
  // defense-in-depth only.
  if (cursor !== undefined && decodeTrackerCursor(cursor) === null) {
    return err(400, "INVALID_CURSOR");
  }

  const page = await findApartmentsForTracker(session.orgId, filters, cursor ?? null, limit);

  // Fetch active carpark assignments for all returned apartments (new model).
  const apartmentIds = page.apartments.map((a) => a.id);
  const carparksByApt = await findCarparkAssignmentsForApartments(session.orgId, apartmentIds);

  const meterOn = isPhase2FlagEnabled("ENABLE_PHASE2_METER");
  let elecByUnit = new Map<string, ElectricityStatus>();
  if (meterOn) {
    const periodMonth = firstOfMonth(query.period);
    // All listings are rooms post-carpark-redesign; no unitKind filter needed.
    const unitIds = page.apartments.flatMap((a) => a.listings.map((l) => l.id));
    elecByUnit = await findCurrentPeriodElectricity(session.orgId, unitIds, periodMonth);
  }
  for (const a of page.apartments) {
    for (const l of a.listings) {
      l.electricity = elecByUnit.get(l.id) ?? null;
    }
  }

  return ok({
    groups: page.apartments.map((a) => toGroup(a, carparksByApt.get(a.id) ?? [])),
    nextCursor: page.nextCursor,
  });
}

/** `GET /api/tenant-tracker/lookup` — ⌘K phone-search-to-act. */
export async function lookupPhoneService(
  session: SessionPayload,
  phone: string,
): Promise<Result<TrackerLookupHit[]>> {
  // An empty match is a normal search outcome → ok([], 200), NOT 404.
  return ok(await lookupByPhone(session.orgId, phone));
}

/** `GET /api/tenant-tracker/agents` — distinct raw agent labels. */
export async function listAgentLabelsService(
  session: SessionPayload,
): Promise<Result<TrackerAgentsResponse>> {
  return ok({ agents: await listAgentLabels(session.orgId) });
}

/** `GET /api/tenant-tracker/summary` — counts for rail/metrics/result line. */
export async function trackerSummaryService(
  session: SessionPayload,
): Promise<Result<TrackerSummaryResponse>> {
  return ok(await getTrackerSummary(session.orgId));
}

/**
 * `PATCH /api/tenant-tracker/units/:unitId/in-charge` — assign/unassign the
 * room's PIC. Update + audit run in ONE $transaction: if the audit insert
 * fails, the assign rolls back with it. Optimistic concurrency is two-layered:
 * an instant (getTime) pre-check against the freshly-loaded listing, then the
 * authoritative updatedAt-in-WHERE on the update (P2025 → 409 STALE).
 */
export async function assignInChargeService(
  session: SessionPayload,
  unitId: string,
  input: AssignInChargeInput,
): Promise<Result<AssignInChargeResult>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const listing = await findListingForInCharge(tx, session.orgId, unitId);
    if (!listing) return err(404, "UNIT_NOT_FOUND");

    // Instant comparison (not string equality) so a millisecond-truncated but
    // equal expectedUpdatedAt doesn't 409 spuriously — and the pre-check is
    // self-consistent with the `new Date(...)` in the update's WHERE below.
    if (
      input.expectedUpdatedAt !== undefined &&
      new Date(input.expectedUpdatedAt).getTime() !== listing.updatedAt.getTime()
    ) {
      return err(409, "STALE");
    }

    // Denormalized inChargeName: assignee displayName, or null on unassign
    // (SetNull semantics — both columns clear together).
    let inChargeName: string | null = null;
    if (input.inChargePartyId !== null) {
      const assignee = await findPartyInOrg(tx, session.orgId, input.inChargePartyId);
      if (!assignee) return err(404, "PARTY_NOT_FOUND");
      inChargeName = assignee.displayName;
    }

    const updated = await withStaleCheck(() =>
      tx.listing.update({
        where: {
          id: unitId,
          organizationId: session.orgId,
          ...(input.expectedUpdatedAt !== undefined
            ? { updatedAt: new Date(input.expectedUpdatedAt) }
            : {}),
        },
        data: { inChargePartyId: input.inChargePartyId, inChargeName },
        select: { id: true },
      }),
    );
    if (updated === null) return err(409, "STALE");

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role,
      action: "leasing.unit.assign_in_charge",
      entityType: "Listing",
      entityId: unitId,
      diff: {
        before: { inChargePartyId: listing.inChargePartyId, inChargeName: listing.inChargeName },
        after: { inChargePartyId: input.inChargePartyId, inChargeName },
      } as unknown as Prisma.InputJsonValue,
    });

    return ok({ inChargePartyId: input.inChargePartyId, inChargeName });
  });
}

// ---------------------------------------------------------------------------
// Export (GET /export.xlsx) — flattened one-row-per-tenancy view
// ---------------------------------------------------------------------------

const EXPORT_PAGE_SIZE = 100;
const EXPORT_MAX_PAGES = 100;

/**
 * One flattened export row per tenancy in scope (rooms AND carparks — `kind`
 * distinguishes). Dates are ISO date strings (YYYY-MM-DD); rent is a number.
 *
 * IC redaction (O3/PDPA): `idNumber` carries the RAW value ONLY for an admin
 * session; every other role gets the masked form. This is the single
 * non-audited unmasked-IC surface, and it is admin-only by design.
 */
export type TrackerExportRow = {
  propertyName: string;
  unitCode: string;
  room: string;
  kind: "room" | "carpark";
  tenantName: string;
  phone: string | null;
  email: string | null;
  gender: string | null;
  idNumber: string | null;
  pax: number | null;
  agentLabel: string | null;
  accessCardNo: string | null;
  status: string;
  startDate: string;
  endDate: string | null;
  monthlyRent: number | null;
  picName: string | null;
};

const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Flatten every tenancy matching `filters` (same semantics as the list) into
 * export rows, walking `findApartmentsForTracker` pages internally at
 * EXPORT_PAGE_SIZE per page. Hard-capped at EXPORT_MAX_PAGES pages
 * (log-and-stop — a truncated export beats an unbounded loop on a
 * pathological cursor).
 */
export async function exportTrackerRowsService(
  session: SessionPayload,
  filters: TrackerFilters,
): Promise<Result<TrackerExportRow[]>> {
  const includeRawIc = session.role === "admin";
  const rows: TrackerExportRow[] = [];

  let cursor: string | null = null;
  let pages = 0;
  do {
    if (pages >= EXPORT_MAX_PAGES) {
      console.warn(
        `[tenant-tracker] export stopped at the ${EXPORT_MAX_PAGES}-page cap ` +
          `(org ${session.orgId}); rows so far: ${rows.length}. Export is truncated.`,
      );
      break;
    }
    const page = await findApartmentsForTracker(session.orgId, filters, cursor, EXPORT_PAGE_SIZE);
    pages += 1;

    for (const apartment of page.apartments) {
      for (const listing of apartment.listings) {
        // All listings are rooms post-carpark-redesign; carpark export from the
        // new CarparkAssignment model is deferred to a future task.
        const picName = listing.inChargeName ?? listing.inChargeParty?.displayName ?? null;
        for (const tenancy of listing.tenancies) {
          rows.push({
            propertyName: apartment.property.name,
            unitCode: apartment.unitCode,
            room: listing.listingType,
            kind: "room",
            tenantName: tenancy.tenantParty.displayName,
            phone: tenancy.tenantParty.primaryPhone,
            email: tenancy.tenantParty.primaryEmail,
            gender: tenancy.tenantParty.gender,
            idNumber: includeRawIc
              ? tenancy.tenantParty.idNumber
              : maskIdNumber(tenancy.tenantParty.idNumber),
            pax: tenancy.numberOfPax,
            agentLabel: tenancy.agentLabel,
            accessCardNo: tenancy.accessCardNo,
            status: tenancy.status,
            startDate: toIsoDate(tenancy.startDate),
            endDate: tenancy.endDate ? toIsoDate(tenancy.endDate) : null,
            monthlyRent: tenancy.monthlyRentAmount,
            picName,
          });
        }
      }
    }

    cursor = page.nextCursor;
  } while (cursor !== null);

  return ok(rows);
}

