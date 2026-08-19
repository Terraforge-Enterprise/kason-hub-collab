// apps/api/src/modules/submissions/submission.service.ts
import { getDb, Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import {
  createUnitSubmission,
  findUnitSubmissionById,
  updateSubmissionTx,
} from "./submission.repository";
import { unitSubmissionPayloadSchema } from "./submission.schema";
import { deriveReadyNow } from "../inventory/inventory.service";
import { findPropertyStatus } from "../inventory/inventory.repository";

type Session = { orgId: string; userId: string; partyId?: string; actorRole?: string };

type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error });

// =============================================================================
// Agent-side: create new submission (no parentListing -> a brand-new listing)
// =============================================================================

export async function createUnitSubmissionService(
  ctx: Session,
  // Caller provides EITHER propertyId (approved Property) OR
  // propertySubmissionId (agent's own pending property). The two are
  // mutually exclusive. The cascade in approvePropertySubmissionService
  // rewrites child UnitSubmissions to the real propertyId when admin
  // approves the property.
  input:
    | {
        propertyId: string;
        propertySubmissionId?: undefined;
        unitCode: string;
        listingType: string;
        listingMode: "WHOLE" | "PARTITIONED";
        payload: unknown;
      }
    | {
        propertyId?: undefined;
        propertySubmissionId: string;
        unitCode: string;
        listingType: string;
        listingMode: "WHOLE" | "PARTITIONED";
        payload: unknown;
      },
): Promise<Result<{ id: string }>> {
  if (!ctx.partyId) return err(403, "Caller has no partyId (not an agent)");

  const parsed = unitSubmissionPayloadSchema.safeParse(input.payload);
  if (!parsed.success) return err(400, "Invalid payload");

  const sub = await createUnitSubmission({
    organizationId: ctx.orgId,
    propertyId: input.propertyId ?? null,
    propertySubmissionId: input.propertySubmissionId ?? null,
    unitCode: input.unitCode,
    listingType: input.listingType,
    listingMode: input.listingMode,
    parentListingId: null,
    sourcingAgentId: ctx.partyId,
    submittedPayload: parsed.data as unknown as Prisma.InputJsonValue,
  });

  return ok({ id: sub.id }, 201);
}

// =============================================================================
// Agent-side: create amendment to existing approved Listing
// =============================================================================

export async function createAmendmentService(
  ctx: Session,
  listingId: string,
  payload: unknown,
): Promise<Result<{ submissionId: string }>> {
  if (!ctx.partyId) return err(403, "Caller has no partyId");

  const db = getDb();
  const listing = await db.listing.findFirst({
    where: {
      id: listingId,
      organizationId: ctx.orgId,
      sourcingAgentId: ctx.partyId, // access gate: only own agent-sourced listings
    },
    select: {
      id: true,
      listingType: true,
      apartment: { select: { listingMode: true, propertyId: true, unitCode: true } },
    },
  });
  if (!listing) return err(403, "Listing not editable by this agent");

  const parsed = unitSubmissionPayloadSchema.safeParse(payload);
  if (!parsed.success) return err(400, "Invalid payload");

  const sub = await createUnitSubmission({
    organizationId: ctx.orgId,
    propertyId: listing.apartment.propertyId,
    unitCode: listing.apartment.unitCode,
    listingType: listing.listingType,
    listingMode: listing.apartment.listingMode as "WHOLE" | "PARTITIONED",
    parentListingId: listing.id,
    sourcingAgentId: ctx.partyId,
    submittedPayload: parsed.data as unknown as Prisma.InputJsonValue,
  });

  return ok({ submissionId: sub.id }, 201);
}

// =============================================================================
// Agent-side: withdraw own pending submission
// =============================================================================

export async function withdrawSubmissionService(
  ctx: Session,
  submissionId: string,
): Promise<Result<{ id: string }>> {
  const sub = await findUnitSubmissionById(ctx.orgId, submissionId);
  if (!sub) return err(404, "Submission not found");
  if (sub.sourcingAgentId !== ctx.partyId) return err(403, "Not your submission");
  if (sub.submissionState !== "pending" && sub.submissionState !== "needs_amendment") {
    return err(409, "Cannot withdraw from current state");
  }

  await getDb().$transaction(async (tx) => {
    await updateSubmissionTx(tx, submissionId, { submissionState: "withdrawn" });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      actorRole: ctx.actorRole ?? "editor",
      action: "unit_submission.withdrawn",
      entityType: "UnitSubmission",
      entityId: submissionId,
    });
  });

  return ok({ id: submissionId });
}

// =============================================================================
// Agent-side: re-submit a pending or needs_amendment submission.
// =============================================================================
//
// Two callers:
//   - Agent fixes a needs_amendment submission per admin note → state was
//     "needs_amendment", flips to "pending" and clears amendmentNote.
//   - Agent realizes their pending submission has wrong data, edits before
//     admin acts → state was "pending", stays "pending" (audit action is
//     `edited_pending` so the trail tells the two apart).
//
// `structural` carries column-level changes that aren't part of
// submittedPayload (currently listingType + its derived listingMode). When
// the agent changes room type, the dispatcher passes them through so the
// submission row's columns track the latest value — without this, the
// listingType column froze at create time and admin approval rebuilt the
// Listing from the stale value.

export async function resubmitSubmissionService(
  ctx: Session,
  submissionId: string,
  payload: unknown,
  structural?: { listingType?: string; listingMode?: "WHOLE" | "PARTITIONED" },
): Promise<Result<{ id: string }>> {
  const sub = await findUnitSubmissionById(ctx.orgId, submissionId);
  if (!sub) return err(404, "Submission not found");
  if (sub.sourcingAgentId !== ctx.partyId) return err(403, "Not your submission");
  if (sub.submissionState !== "pending" && sub.submissionState !== "needs_amendment") {
    return err(409, "Only pending or needs_amendment submissions can be edited");
  }

  const parsed = unitSubmissionPayloadSchema.safeParse(payload);
  if (!parsed.success) return err(400, "Invalid payload");

  const wasNeedsAmendment = sub.submissionState === "needs_amendment";

  await getDb().$transaction(async (tx) => {
    await updateSubmissionTx(tx, submissionId, {
      submissionState: "pending",
      // Only clear the admin note when the agent is acting on it (i.e. the
      // row was previously needs_amendment). A pending-pending edit must
      // not blank the note retroactively (it was already null anyway, but
      // guard explicitly).
      amendmentNote: wasNeedsAmendment ? null : undefined,
      submittedPayload: parsed.data as unknown as Prisma.InputJsonValue,
      ...(structural?.listingType !== undefined ? { listingType: structural.listingType } : {}),
      ...(structural?.listingMode !== undefined ? { listingMode: structural.listingMode } : {}),
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      actorRole: ctx.actorRole ?? "editor",
      action: wasNeedsAmendment
        ? "unit_submission.resubmitted"
        : "unit_submission.edited_pending",
      entityType: "UnitSubmission",
      entityId: submissionId,
    });
  });

  return ok({ id: submissionId });
}

// =============================================================================
// Admin-side: approve submission (auto-publishes to Listing)
// =============================================================================

export async function approveSubmissionService(
  ctx: Session,
  submissionId: string,
): Promise<Result<{ approvedListingId: string }>> {
  const sub = await findUnitSubmissionById(ctx.orgId, submissionId);
  if (!sub) return err(404, "Submission not found");
  if (sub.submissionState !== "pending" && sub.submissionState !== "needs_amendment") {
    return err(409, "Submission not approvable from current state");
  }
  if (!sub.propertyId) {
    return err(409, "Submission has no propertyId — property must be approved first");
  }

  const payload = unitSubmissionPayloadSchema.parse(sub.submittedPayload);
  const db = getDb();

  // readyNow is derived from the parent Property's lifecycle + the listing's
  // own lifecycle. Without this here, an admin-approved agent submission lands
  // as a Listing with readyNow=false (DB default) and silently drops out of
  // the agent reservation picker (which filters `readyNow: true`).
  const propertyStatus = await findPropertyStatus(ctx.orgId, sub.propertyId);
  if (propertyStatus == null) return err(404, "Parent property not found");

  return db.$transaction(async (tx) => {
    let listingId: string;

    if (sub.parentListingId) {
      // Amendment path: update existing approved listing.
      const existing = await tx.listing.findUnique({
        where: { id: sub.parentListingId },
        select: { listingStatus: true, visibilityMode: true, occupancyStatus: true },
      });
      if (!existing) return err(404, "Parent listing not found");
      const listingPayload = payload.listing as Record<string, unknown>;
      const updateData: Prisma.ListingUpdateInput = {};
      for (const [k, v] of Object.entries(listingPayload)) {
        if (v !== undefined) (updateData as Record<string, unknown>)[k] = v;
      }
      // Recompute readyNow from the post-merge lifecycle so amendments that
      // touch occupancy/visibility don't leave a stale truthy value, and so
      // pre-fix listings still healing back to readyNow=true when valid.
      (updateData as Record<string, unknown>).readyNow = deriveReadyNow({
        propertyStatus,
        listingStatus:
          (listingPayload.listingStatus as string | undefined) ?? existing.listingStatus,
        visibilityMode:
          (listingPayload.visibilityMode as string | undefined) ?? existing.visibilityMode,
        occupancyStatus:
          (listingPayload.occupancyStatus as string | undefined) ?? existing.occupancyStatus,
      });
      const updated = await tx.listing.update({
        where: { id: sub.parentListingId },
        data: updateData,
        select: { id: true },
      });
      listingId = updated.id;
    } else {
      // New submission: find-or-create the parent Apartment, then create Listing.
      // Note: sub.propertyId is non-null here (checked above).
      //
      // Media fields (photoKeys / videoKeys / coverPhotoKey) used to live on
      // Apartment but now live per-Listing (spec 2026-05-24). For back-compat
      // the submission wire still accepts them inside `apartmentShared` — peel
      // them off here and route to the listing create.
      const apartmentSharedInput = (payload.apartmentShared ?? {}) as Record<string, unknown>;
      const { photoKeys: sharedPhotoKeys, videoKeys: sharedVideoKeys, coverPhotoKey: sharedCoverPhotoKey, ...apartmentSharedRest } =
        apartmentSharedInput;

      const apt = await tx.apartment.upsert({
        where: {
          organizationId_propertyId_unitCode: {
            organizationId: sub.organizationId,
            propertyId: sub.propertyId!,
            unitCode: sub.unitCode,
          },
        },
        create: {
          organizationId: sub.organizationId,
          propertyId: sub.propertyId!,
          unitCode: sub.unitCode,
          listingMode: sub.listingMode,
          ...apartmentSharedRest,
        } as Prisma.ApartmentUncheckedCreateInput,
        update: {}, // never overwrite shared fields on a sibling submission
      });

      // Spread the submitted payload first so explicit fields (organizationId,
      // listingStatus, etc.) win, AND so we can fall back to defaults for any
      // required Listing fields the payload didn't include. `occupancyStatus`
      // is the common one: agent-side create form may leave it unset; the
      // schema requires a value. Default to "vacant" for fresh listings.
      const listingPayload = payload.listing as Record<string, unknown>;
      const effectiveListingStatus =
        (listingPayload.listingStatus as string | undefined) ?? "active";
      const effectiveOccupancyStatus =
        (listingPayload.occupancyStatus as string | undefined) ?? "vacant";
      const effectiveVisibilityMode =
        (listingPayload.visibilityMode as string | undefined) ?? "PUBLIC";
      const readyNow = deriveReadyNow({
        propertyStatus,
        listingStatus: effectiveListingStatus,
        visibilityMode: effectiveVisibilityMode,
        occupancyStatus: effectiveOccupancyStatus,
      });
      const listing = await tx.listing.create({
        data: {
          organizationId: sub.organizationId,
          apartmentId: apt.id,
          listingType: sub.listingType,
          listingStatus: "active",
          currency: "MYR",
          sourcingAgentId: sub.sourcingAgentId,
          occupancyStatus: "vacant",
          ...listingPayload,
          // Media fields routed from apartmentShared (back-compat — see above).
          // listing payload wins if it also specifies these, but in practice
          // it never does — agent UI only ever puts media in apartmentShared.
          ...(sharedPhotoKeys !== undefined ? { photoKeys: sharedPhotoKeys } : {}),
          ...(sharedVideoKeys !== undefined ? { videoKeys: sharedVideoKeys } : {}),
          ...(sharedCoverPhotoKey !== undefined ? { coverPhotoKey: sharedCoverPhotoKey } : {}),
          readyNow,
        } as Prisma.ListingUncheckedCreateInput,
        select: { id: true },
      });
      listingId = listing.id;
    }

    await updateSubmissionTx(tx, submissionId, {
      submissionState: "approved",
      approvedAt: new Date(),
      approvedById: ctx.userId,
      approvedListingId: listingId,
    });

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      actorRole: ctx.actorRole ?? "admin",
      action: sub.parentListingId ? "unit_submission.amendment.approved" : "unit_submission.approved",
      entityType: "Listing",
      entityId: listingId,
    });

    return ok({ approvedListingId: listingId });
  });
}

// =============================================================================
// Admin-side: send back for amendment
// =============================================================================

export async function setSubmissionNeedsAmendmentService(
  ctx: Session,
  submissionId: string,
  note: string,
): Promise<Result<{ id: string }>> {
  const sub = await findUnitSubmissionById(ctx.orgId, submissionId);
  if (!sub) return err(404, "Submission not found");
  if (sub.submissionState !== "pending") {
    return err(409, "Only pending submissions can be sent back");
  }

  await getDb().$transaction(async (tx) => {
    await updateSubmissionTx(tx, submissionId, {
      submissionState: "needs_amendment",
      amendmentNote: note,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      actorRole: ctx.actorRole ?? "admin",
      action: "unit_submission.needs_amendment",
      entityType: "UnitSubmission",
      entityId: submissionId,
      diff: { note } as unknown as Prisma.InputJsonValue,
    });
  });

  return ok({ id: submissionId });
}

// =============================================================================
// Admin-side: reject (terminal)
// =============================================================================

export async function rejectSubmissionService(
  ctx: Session,
  submissionId: string,
  note: string,
): Promise<Result<{ id: string }>> {
  const sub = await findUnitSubmissionById(ctx.orgId, submissionId);
  if (!sub) return err(404, "Submission not found");
  if (sub.submissionState !== "pending" && sub.submissionState !== "needs_amendment") {
    return err(409, "Submission not rejectable from current state");
  }

  await getDb().$transaction(async (tx) => {
    await updateSubmissionTx(tx, submissionId, {
      submissionState: "rejected",
      amendmentNote: note,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      actorRole: ctx.actorRole ?? "admin",
      action: "unit_submission.rejected",
      entityType: "UnitSubmission",
      entityId: submissionId,
      diff: { note } as unknown as Prisma.InputJsonValue,
    });
  });

  return ok({ id: submissionId });
}
