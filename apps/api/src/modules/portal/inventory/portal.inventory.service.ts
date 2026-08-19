// Portal-side inventory service. After the three-table refactor, the
// agent-side create / update / cancel flows operate on UnitSubmission, not
// Listing. The legacy `Unit` model — which conflated submission + listing +
// apartment concerns into one row — has been split:
//
//   - new submission        -> UnitSubmission (parentListingId IS NULL)
//   - amendment to own row  -> UnitSubmission (parentListingId IS NOT NULL)
//   - withdraw own pending  -> UnitSubmission.submissionState = "withdrawn"
//   - resubmit needs_amend  -> UnitSubmission.submissionState = "pending"
//
// This module is a thin dispatcher around `submission.service` so the
// portal route surface stays close to its pre-refactor shape — the SPA's
// `/portal-api/inventory/units` endpoints keep working with minimal
// changes; the request payloads are validated against the existing portal
// schemas, then translated to the canonical UnitSubmission payload shape.
import { getDb, type Prisma } from "@kason/db";
import {
  type CreatePortalUnitsBatchInput,
  createPortalUnitSchema,
  updatePortalUnitSchema,
} from "@kason/shared";
import type { z } from "zod";
import { recordAudit } from "../../../lib/audit";

export type CreatePortalUnitInput = z.infer<typeof createPortalUnitSchema>;
export type UpdatePortalUnitInput = Omit<
  z.infer<typeof updatePortalUnitSchema>,
  "unitId"
>;
import {
  createUnitSubmissionService,
  createAmendmentService,
  resubmitSubmissionService,
  withdrawSubmissionService,
} from "../../submissions/submission.service";
import { assertAmenitiesBelongToOrgService } from "../../inventory/amenities/amenities.service";
import { getUnitGroupMode, resolveRoomTypeKind } from "../../inventory/listing-mode";
import type { ApartmentSummary } from "../../inventory/inventory.service";

export type PortalInventoryActorCtx = {
  orgId: string;
  actorUserId: string;
  partyId: string;
  ip?: string;
  userAgent?: string;
};

type Result<T> =
  | { ok: true; status: 200 | 201; data: T }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string | Record<string, unknown> };

const submissionCtx = (ctx: PortalInventoryActorCtx) => ({
  orgId: ctx.orgId,
  userId: ctx.actorUserId,
  partyId: ctx.partyId,
  actorRole: "editor",
});

// =============================================================================
// Payload translation — portal request body -> UnitSubmission payload shape.
// =============================================================================

/**
 * Split a flat portal create/update payload (with apartment-shared fields
 * intermixed with listing-offer fields) into the `{ listing, apartmentShared }`
 * shape that UnitSubmission's Zod validator expects.
 *
 * This is the boundary between the legacy flat wire shape and the new
 * three-table model. Kept simple — drop unknown keys at the schema layer.
 */
function splitToSubmissionPayload(input: Record<string, unknown>) {
  // Apartment-shared fields — describe the dwelling, not any individual offer.
  const apartmentSharedKeys = [
    "bedrooms",
    "bathrooms",
    "floorArea",
    "floor",
    "facing",
    "furnishingLevel",
    "amenities",
    "highlights",
  ] as const;
  const apartmentShared: Record<string, unknown> = {};
  for (const k of apartmentSharedKeys) {
    if (input[k] !== undefined) apartmentShared[k] = input[k];
  }
  // `description` and `title` are stored on Apartment as
  // publishedDescription / publishedTitle. Translate the legacy names.
  if (input.description !== undefined) {
    apartmentShared.publishedDescription = input.description;
  }
  if (input.title !== undefined) {
    apartmentShared.publishedTitle = input.title;
  }

  // Listing-offer fields. Anything not in apartmentShared and not server-
  // controlled (sourceFlag, inChargePartyId, etc.) flows through.
  const listingKeys = [
    "rentalRate",
    "depositMonths",
    "utilitiesDepositMonths",
    "accessCardDepositPerPcs",
    "accessCardQuantity",
    "parkingQuantity",
    "parkingNumbers",
    "occupancyStatus",
    "visibilityMode",
    "hiddenFromPartyIds",
    "inChargePartyId",
    "moveInDate",
    // Sibling of moveInDate. Missed in the post-refactor allow-list along
    // with `unitType`; without it, agents amending an occupied unit cannot
    // shift the planned move-out — the change persists nowhere.
    "moveOutDate",
  ] as const;
  const listing: Record<string, unknown> = {};
  for (const k of listingKeys) {
    if (input[k] !== undefined) listing[k] = input[k];
  }

  // Room type rename — input carries `unitType` (the public-facing field
  // name); Listing's column is `listingType`. Renaming here lets the
  // amendment-approval merge in submissions/submission.service.ts apply the
  // change directly via Prisma.Listing.update without further translation.
  // Pre-fix: `unitType` was absent from both apartmentSharedKeys AND
  // listingKeys, so any amendment to the room type was silently dropped (B11).
  if (input.unitType !== undefined) {
    listing.listingType = input.unitType;
  }

  return {
    listing,
    apartmentShared: Object.keys(apartmentShared).length > 0 ? apartmentShared : undefined,
  };
}

/**
 * Derive `listingMode` from the proposed listingType. A WHOLE-kind RoomType
 * -> WHOLE; otherwise PARTITIONED (the more permissive default — a Whole
 * Apartment.listingMode can always be re-flipped via the admin flow).
 */
async function deriveListingMode(
  orgId: string,
  listingType: string,
): Promise<"WHOLE" | "PARTITIONED"> {
  const kind = await resolveRoomTypeKind(orgId, listingType);
  return kind === "WHOLE" ? "WHOLE" : "PARTITIONED";
}

// =============================================================================
// Create — single-unit submission.
// =============================================================================

/**
 * Agent submits a new listing proposal. Writes one UnitSubmission row in
 * `pending` state; admin approval promotes it to Listing.
 *
 * Server-forced posture is enforced by `createUnitSubmissionService`:
 *   - sourcingAgentId = ctx.partyId
 *   - submissionState = "pending"
 *
 * Property must exist and belong to this org; otherwise 404 (don't leak
 * existence). The kind-mismatch guard is preserved against the existing
 * approved Listings on the (propertyId, unitCode) tuple — an agent can't
 * propose a "Whole Unit" in a Partitioned apartment.
 *
 * The legacy wire-shape function name `portalCreateUnitService` is kept so
 * the route layer minimally changes — its body is a thin dispatch to the
 * submissions module.
 */
export async function portalCreateUnitService(
  ctx: PortalInventoryActorCtx,
  input: CreatePortalUnitInput,
): Promise<Result<{ id: string }>> {
  const db = getDb();

  // The portal schema's XOR refiner guarantees exactly one of propertyId /
  // propertySubmissionId is set. Resolve to one of two branches:
  //   - Approved Property: look up by id, scoped to org.
  //   - Pending PropertySubmission: look up by id, must be sourced by this
  //     agent (own-only), and must still be in pending/needs_amendment
  //     (rejected/approved submissions are not legal attach targets).
  let propertyIdForCreate: string | null = null;
  let propertySubmissionIdForCreate: string | null = null;

  if (input.propertyId) {
    const property = await db.property.findFirst({
      where: { id: input.propertyId, organizationId: ctx.orgId },
      select: { id: true },
    });
    if (!property) {
      return { ok: false, status: 404, error: "Property not found" };
    }
    propertyIdForCreate = property.id;
  } else if (input.propertySubmissionId) {
    const submission = await db.propertySubmission.findFirst({
      where: {
        id: input.propertySubmissionId,
        organizationId: ctx.orgId,
        // Own-only — the agent can't attach to other agents' pending properties.
        sourcingAgentId: ctx.partyId,
      },
      select: { id: true, submissionState: true },
    });
    if (!submission) {
      return { ok: false, status: 404, error: "Property submission not found" };
    }
    if (
      submission.submissionState !== "pending" &&
      submission.submissionState !== "needs_amendment"
    ) {
      return {
        ok: false,
        status: 409,
        error: "Property submission is no longer pending — attach to the approved property instead.",
      };
    }
    propertySubmissionIdForCreate = submission.id;
  } else {
    // Defensive — schema XOR refiner should have caught this.
    return { ok: false, status: 400, error: "Missing propertyId or propertySubmissionId" };
  }

  // Kind-mismatch guard only applies to approved properties — a pending
  // property has no sibling listings yet, so any kind is acceptable.
  const normalizedUnitCode = input.unitCode.trim();
  const normalizedUnitType = input.unitType.trim();
  if (propertyIdForCreate) {
    const attemptedKind = await resolveRoomTypeKind(ctx.orgId, normalizedUnitType);
    if (attemptedKind) {
      const currentMode = await getUnitGroupMode(ctx.orgId, propertyIdForCreate, normalizedUnitCode);
      if (currentMode && currentMode !== "MIXED") {
        const required = currentMode === "WHOLE" ? "WHOLE" : "PARTITION";
        if (attemptedKind !== required) {
          return {
            ok: false as const,
            status: 400 as const,
            error: {
              code: "LISTING_MODE_MISMATCH" as const,
              currentMode,
              attemptedKind,
            },
          };
        }
      }
    }
  }

  const listingMode = await deriveListingMode(ctx.orgId, normalizedUnitType);
  const payload = splitToSubmissionPayload(input as unknown as Record<string, unknown>);

  const result = await createUnitSubmissionService(
    submissionCtx(ctx),
    propertyIdForCreate
      ? {
          propertyId: propertyIdForCreate,
          unitCode: normalizedUnitCode,
          listingType: normalizedUnitType,
          listingMode,
          payload,
        }
      : {
          propertySubmissionId: propertySubmissionIdForCreate!,
          unitCode: normalizedUnitCode,
          listingType: normalizedUnitType,
          listingMode,
          payload,
        },
  );

  if (!result.ok) {
    // Map submission service result codes to portal-layer codes. 400 from
    // payload validation, 403 if partyId is missing (shouldn't happen here).
    return { ok: false, status: result.status as 400 | 403, error: result.error };
  }

  await recordAudit(db as unknown as Prisma.TransactionClient, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: "editor",
    action: "inventory.unit.create.portal",
    entityType: "UnitSubmission",
    entityId: result.data.id,
    diff: {
      after: {
        id: result.data.id,
        propertyId: propertyIdForCreate,
        propertySubmissionId: propertySubmissionIdForCreate,
        unitCode: normalizedUnitCode,
        listingType: normalizedUnitType,
        listingMode,
      },
    } as unknown as Prisma.InputJsonValue,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return { ok: true, status: 201, data: { id: result.data.id } };
}

// =============================================================================
// Create — multi-room batch submission.
// =============================================================================

/**
 * Multi-room batch — common Malaysian sub-let pattern: one apartment unit
 * (e.g. "B-08-08" at Sunway Artessa) gets listed as N rooms (master /
 * medium / single), each with its own rent + deposit + parking. After the
 * three-table refactor, each room becomes one UnitSubmission; on admin
 * approval, the N submissions promote to N Listings under one Apartment.
 *
 * Atomic via `$transaction`: either every submission row is created or
 * none. Property must exist in the org. The kind-mismatch guard runs once
 * per room against the existing Apartment.listingMode (if any), preserving
 * the pre-refactor semantics.
 *
 * applyToExistingSiblings: in the new model, apartment-shared fields live
 * on the Apartment row — fanning them out to siblings would mean writing
 * to a row the agent doesn't own. Agent-side fan-out becomes a no-op here;
 * if the agent wants to update shared fields on an approved Apartment, they
 * file an amendment against one of their owned Listings (which can carry
 * apartmentShared updates via UnitSubmission.submittedPayload).
 */
export async function portalCreateUnitsBatchService(
  ctx: PortalInventoryActorCtx,
  input: CreatePortalUnitsBatchInput,
): Promise<Result<{ ids: string[]; updatedIds: string[] }>> {
  const db = getDb();

  const property = await db.property.findFirst({
    where: { id: input.shared.propertyId, organizationId: ctx.orgId },
    select: { id: true },
  });
  if (!property) {
    return { ok: false, status: 404, error: "Property not found" };
  }

  // Friendly duplicate-type check before opening the batch loop.
  const types = input.rooms.map((r) => r.unitType.trim());
  const seen = new Set<string>();
  for (const t of types) {
    if (seen.has(t)) {
      return {
        ok: false,
        status: 409,
        error: `Duplicate unit type in submission: ${t}`,
      };
    }
    seen.add(t);
  }

  const normalizedUnitCode = input.shared.unitCode.trim();

  // Cross-org amenity check — mirror of the admin batch path. Without this,
  // a hostile portal client could smuggle another org's amenity UUIDs into
  // the apartment-shared payload.
  if (input.shared.amenities && input.shared.amenities.length > 0) {
    const check = await assertAmenitiesBelongToOrgService(
      ctx.orgId,
      input.shared.amenities,
    );
    if (!check.ok) {
      return { ok: false, status: 400, error: check.error.message };
    }
  }

  // Kind-mismatch guard for the batch: fetch the existing apartment mode
  // (if any) and validate every incoming room's kind against it. Skip when
  // currentMode is null (no existing apartment) or MIXED (legacy state).
  const currentMode = await getUnitGroupMode(
    ctx.orgId,
    input.shared.propertyId,
    normalizedUnitCode,
  );
  if (currentMode && currentMode !== "MIXED") {
    const required = currentMode === "WHOLE" ? "WHOLE" : "PARTITION";
    for (const room of input.rooms) {
      const roomType = room.unitType.trim();
      const attemptedKind = await resolveRoomTypeKind(ctx.orgId, roomType);
      if (attemptedKind && attemptedKind !== required) {
        return {
          ok: false as const,
          status: 400 as const,
          error: {
            code: "LISTING_MODE_MISMATCH" as const,
            currentMode,
            attemptedKind,
            unitType: roomType,
          },
        };
      }
    }
  }

  // Apartment-shared payload — identical across every per-room submission
  // in this batch. Approving any one submission upserts the shared fields
  // onto the parent Apartment row.
  const apartmentShared = {
    bedrooms: input.shared.bedrooms ?? null,
    bathrooms: input.shared.bathrooms ?? null,
    floor: input.shared.floor ?? null,
    floorArea: input.shared.floorArea ?? null,
    amenities: input.shared.amenities ?? [],
    highlights: input.shared.highlights ?? [],
    publishedDescription: input.shared.description ?? null,
  };

  // Atomic batch insert: all submissions or none. We open one transaction
  // and create N UnitSubmission rows directly. We don't dispatch through
  // `createUnitSubmissionService` per-room because each call opens its own
  // implicit transaction; we want one big transaction so partial success
  // is impossible.
  try {
    const ids = await db.$transaction(async (tx) => {
      const created: string[] = [];
      for (const room of input.rooms) {
        const roomType = room.unitType.trim();
        const listingMode = await deriveListingMode(ctx.orgId, roomType);

        const listingPayload = {
          rentalRate: room.rentalRate ?? null,
          depositMonths: room.depositMonths,
          utilitiesDepositMonths: room.utilitiesDepositMonths,
          accessCardDepositPerPcs: room.accessCardDepositPerPcs ?? null,
          accessCardQuantity: room.accessCardQuantity ?? null,
          parkingQuantity: room.parkingQuantity ?? null,
          parkingNumbers: room.parkingNumbers ?? [],
        };

        const sub = await tx.unitSubmission.create({
          data: {
            organizationId: ctx.orgId,
            propertyId: input.shared.propertyId,
            unitCode: normalizedUnitCode,
            listingType: roomType,
            listingMode,
            parentListingId: null,
            sourcingAgentId: ctx.partyId,
            submissionState: "pending",
            submittedPayload: {
              listing: listingPayload,
              apartmentShared,
            } as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        created.push(sub.id);

        await recordAudit(tx, {
          organizationId: ctx.orgId,
          actorUserId: ctx.actorUserId,
          actorRole: "editor",
          action: "inventory.unit.create.portal.batch",
          entityType: "UnitSubmission",
          entityId: sub.id,
          diff: {
            after: {
              id: sub.id,
              propertyId: input.shared.propertyId,
              unitCode: normalizedUnitCode,
              listingType: roomType,
              listingMode,
              batchSize: input.rooms.length,
            },
          } as unknown as Prisma.InputJsonValue,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }
      return created;
    });

    // applyToExistingSiblings is preserved as a no-op for back-compat — the
    // legacy wire shape returns an `updatedIds` array. After the refactor,
    // shared-field updates on an existing apartment require an amendment
    // submission against a Listing the agent owns; this batch endpoint is
    // for new submissions only.
    return { ok: true, status: 201, data: { ids, updatedIds: [] } };
  } catch (err: unknown) {
    // No unique constraint exists on UnitSubmission for (org, propertyId,
    // unitCode, listingType) — multiple pending proposals for the same
    // tuple are allowed (admin resolves them). So a P2002 here means a
    // schema-level invariant was hit; surface as 409 for consistency with
    // the legacy contract.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return {
        ok: false,
        status: 409,
        error: "Conflict creating submissions",
      };
    }
    throw err;
  }
}

// =============================================================================
// List — the agent's own portfolio.
// =============================================================================

/**
 * Agent's own portfolio for the "My Uploads" view. Returns a flat array of
 * the agent's UnitSubmissions in every state (pending, needs_amendment,
 * approved, rejected, withdrawn) for back-compat with the legacy
 * /portal-api/inventory/units route shape.
 *
 * Approved submissions back-point to the live Listing via approvedListingId
 * so the SPA can deep-link to the listing detail when present.
 *
 * The DECIMAL columns on the submission payload remain JSON — we don't
 * unwrap them here. The SPA's My Uploads UI renders the payload preview
 * verbatim (per spec §UnitSubmission).
 */
export async function portalListOwnUnitsService(
  ctx: PortalInventoryActorCtx,
) {
  const db = getDb();
  const rows = await db.unitSubmission.findMany({
    where: {
      organizationId: ctx.orgId,
      sourcingAgentId: ctx.partyId,
      submissionState: { not: "withdrawn" },
    },
    include: {
      property: { select: { id: true, name: true, propertyCode: true } },
      approvedListing: { select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map((s) => ({
    id: s.id,
    propertyId: s.propertyId,
    unitCode: s.unitCode,
    unitType: s.listingType,
    listingType: s.listingType,
    listingMode: s.listingMode,
    submissionState: s.submissionState,
    amendmentNote: s.amendmentNote,
    parentListingId: s.parentListingId,
    approvedListingId: s.approvedListingId,
    approvedListing: s.approvedListing,
    sourcingAgentId: s.sourcingAgentId,
    submittedPayload: s.submittedPayload as Prisma.JsonValue,
    property: s.property,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }));
}

// =============================================================================
// Update — routes to amendment / resubmit / 403 by id type.
// =============================================================================

/**
 * Update an own unit. The `unitId` argument can resolve to either:
 *   - a UnitSubmission in `needs_amendment` (re-submit path)
 *   - a Listing whose sourcingAgentId matches the agent (amendment path)
 *   - anything else (403)
 *
 * Submissions in pending / approved / rejected / withdrawn states are not
 * editable via this endpoint — withdraw + re-submit is the documented flow.
 *
 * The route layer registered this under PATCH /units/:id for back-compat
 * with the SPA. The dispatch logic below figures out what kind of row the
 * id points to.
 */
export async function portalUpdateOwnUnitService(
  ctx: PortalInventoryActorCtx,
  unitId: string,
  input: UpdatePortalUnitInput,
): Promise<Result<{ id: string }>> {
  const db = getDb();
  const payload = splitToSubmissionPayload(input as unknown as Record<string, unknown>);

  // 1. Try UnitSubmission first — the more common edit path (an agent
  //    fixing a needs_amendment proposal). A bare findFirst with
  //    organizationId + id keeps the org-isolation gate.
  const sub = await db.unitSubmission.findFirst({
    where: { id: unitId, organizationId: ctx.orgId },
    select: { id: true, sourcingAgentId: true, submissionState: true },
  });
  if (sub) {
    if (sub.sourcingAgentId !== ctx.partyId) {
      // Wrong owner — 404 (don't leak existence).
      return { ok: false, status: 404, error: "Unit not found" };
    }
    // Pending + needs_amendment both editable. Pre-fix only allowed
    // needs_amendment, mismatching the FE (which lets agents click Edit on
    // pending too): the agent submitted an amendment, the row flipped back
    // to pending, then trying to fix a typo bounced with 409.
    if (sub.submissionState !== "pending" && sub.submissionState !== "needs_amendment") {
      return {
        ok: false,
        status: 409,
        error: `Cannot edit submission in state "${sub.submissionState}"`,
      };
    }
    // Room-type change: thread the new listingType + derived listingMode
    // through to the submission row's columns. Without this, the column
    // froze at create time and admin approval rebuilt the Listing from the
    // stale value (the user-visible "amend success but room stayed Master"
    // bug).
    let structural: { listingType?: string; listingMode?: "WHOLE" | "PARTITIONED" } | undefined;
    if (typeof input.unitType === "string" && input.unitType.trim() !== "") {
      const nextType = input.unitType.trim();
      const nextMode = await deriveListingMode(ctx.orgId, nextType);
      structural = { listingType: nextType, listingMode: nextMode };
    }
    const result = await resubmitSubmissionService(submissionCtx(ctx), unitId, payload, structural);
    if (!result.ok) {
      return { ok: false, status: result.status as 400 | 403 | 404 | 409, error: result.error };
    }
    return { ok: true, status: 200, data: { id: unitId } };
  }

  // 2. Try Listing — amendment to an approved listing the agent owns.
  const listing = await db.listing.findFirst({
    where: { id: unitId, organizationId: ctx.orgId },
    select: { id: true, sourcingAgentId: true },
  });
  if (!listing) {
    return { ok: false, status: 404, error: "Unit not found" };
  }
  if (listing.sourcingAgentId !== ctx.partyId) {
    // Either company-sourced or sourced by a different agent — 403, the
    // agent cannot file an amendment against a listing they don't own.
    return {
      ok: false,
      status: 403,
      error: "Cannot edit a listing you don't own",
    };
  }
  const result = await createAmendmentService(submissionCtx(ctx), unitId, payload);
  if (!result.ok) {
    return { ok: false, status: result.status as 400 | 403, error: result.error };
  }
  return { ok: true, status: 200, data: { id: result.data.submissionId } };
}

// =============================================================================
// Withdraw — soft-cancel a pending / needs_amendment submission.
// =============================================================================

/**
 * Withdraw the agent's own pending submission. Maps to
 * `withdrawSubmissionService` which sets submissionState = "withdrawn".
 *
 * The legacy contract returned 409 if the row was already approved or
 * already cancelled. The submission service mirrors that: a submission
 * outside pending/needs_amendment is non-withdrawable (409).
 *
 * If the id resolves to an approved Listing rather than a submission, we
 * 409 — agents cannot withdraw an approved listing through this endpoint;
 * that's an admin op (archive).
 */
export async function portalCancelOwnUnitService(
  ctx: PortalInventoryActorCtx,
  unitId: string,
): Promise<Result<{ id: string }>> {
  const db = getDb();

  // Is this a submission?
  const sub = await db.unitSubmission.findFirst({
    where: { id: unitId, organizationId: ctx.orgId },
    select: { id: true, sourcingAgentId: true },
  });
  if (sub) {
    if (sub.sourcingAgentId !== ctx.partyId) {
      return { ok: false, status: 404, error: "Unit not found" };
    }
    const result = await withdrawSubmissionService(submissionCtx(ctx), unitId);
    if (!result.ok) {
      return { ok: false, status: result.status as 403 | 404 | 409, error: result.error };
    }
    return { ok: true, status: 200, data: { id: unitId } };
  }

  // Is this a Listing? Then withdraw isn't the right action.
  const listing = await db.listing.findFirst({
    where: { id: unitId, organizationId: ctx.orgId },
    select: { id: true, sourcingAgentId: true },
  });
  if (!listing) {
    return { ok: false, status: 404, error: "Unit not found" };
  }
  if (listing.sourcingAgentId !== ctx.partyId) {
    return { ok: false, status: 404, error: "Unit not found" };
  }
  return {
    ok: false,
    status: 409,
    error: "Cannot withdraw — listing already approved",
  };
}

// =============================================================================
// Apartment-by-property typeahead.
// =============================================================================
//
// Portal mirror of getApartmentsByPropertyService — used by the portal
// create-unit form's +Rooms typeahead to detect existing apartments and
// surface their shared metadata.
//
// Visibility: an apartment surfaces when it has at least one Listing the
// agent can see (listingStatus="active" OR sourcingAgentId=agent). Drafts
// owned by other agents are not surfaced.
//
// The fan-out write path (POST /units/batch) is the final defence against
// unauthorized apartment edits; this endpoint is for read-only discovery.

export async function portalGetApartmentsByPropertyService(
  ctx: PortalInventoryActorCtx,
  propertyId: string,
): Promise<Result<ApartmentSummary[]>> {
  const db = getDb();
  const property = await db.property.findFirst({
    where: { id: propertyId, organizationId: ctx.orgId },
    select: { id: true },
  });
  if (!property) {
    return { ok: false, status: 404, error: "Property not found" };
  }

  const [apartments, amenities, roomTypes] = await Promise.all([
    db.apartment.findMany({
      where: { organizationId: ctx.orgId, propertyId },
      include: {
        listings: {
          where: { listingStatus: { not: "archived" } },
          select: {
            id: true,
            listingType: true,
            rentalRate: true,
            occupancyStatus: true,
            listingStatus: true,
            inChargePartyId: true,
            sourcingAgentId: true,
          },
          orderBy: { listingType: "asc" },
        },
      },
      orderBy: { unitCode: "asc" },
    }),
    db.amenity.findMany({
      where: { organizationId: ctx.orgId },
      select: { id: true, name: true },
    }),
    db.roomType.findMany({
      where: { organizationId: ctx.orgId },
      select: { name: true, kind: true },
    }),
  ]);

  const amenityCatalog = new Map(amenities.map((a) => [a.id, a.name]));
  const kindByName = new Map(
    roomTypes.map((r) => [r.name, r.kind as "WHOLE" | "PARTITION"]),
  );

  const isVisibleToAgent = (
    l: { listingStatus: string; sourcingAgentId: string | null },
  ): boolean => l.listingStatus === "active" || l.sourcingAgentId === ctx.partyId;

  const data: ApartmentSummary[] = [];
  for (const apt of apartments) {
    // Skip apartments where the agent can't see any room.
    const visibleRooms = apt.listings.filter(isVisibleToAgent);
    if (visibleRooms.length === 0) continue;

    // listingMode preference: derive from active listing kinds first (so
    // MIXED apartments surface for the drift UI), fall back to the
    // Apartment column otherwise. Same logic the admin endpoint uses.
    const roomKinds = new Set<"WHOLE" | "PARTITION">();
    for (const l of apt.listings) {
      const k = kindByName.get(l.listingType);
      if (k) roomKinds.add(k);
    }
    let listingMode: "WHOLE" | "PARTITIONED" | "MIXED" | null;
    if (roomKinds.size === 0) {
      listingMode = apt.listingMode as "WHOLE" | "PARTITIONED";
    } else if (roomKinds.size > 1) {
      listingMode = "MIXED";
    } else {
      listingMode = roomKinds.has("WHOLE") ? "WHOLE" : "PARTITIONED";
    }

    data.push({
      id: apt.id,
      unitCode: apt.unitCode,
      floor: apt.floor,
      bedrooms: apt.bedrooms,
      bathrooms: apt.bathrooms == null ? null : Number(apt.bathrooms),
      floorArea: apt.floorArea == null ? null : Number(apt.floorArea),
      amenities: apt.amenities.map((id) => ({
        id,
        name: amenityCatalog.get(id) ?? id,
      })),
      highlights: apt.highlights,
      description: apt.publishedDescription,
      rooms: visibleRooms.map((l) => ({
        id: l.id,
        unitType: l.listingType,
        rentalRate: l.rentalRate == null ? null : Number(l.rentalRate),
        occupancyStatus: l.occupancyStatus,
        listingStatus: l.listingStatus,
        inChargePartyId: l.inChargePartyId,
      })),
      // Single Apartment row -> no fan-out drift possible.
      hasDrift: false,
      listingMode,
    });
  }
  return { ok: true, status: 200, data };
}
