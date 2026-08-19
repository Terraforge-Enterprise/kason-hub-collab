import { getDb, type Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { atLeast, canDelete, type AdminRole } from "../../lib/rbac";
import { deleteObjectsBestEffort } from "../../lib/storage";
import {
  createListingRow,
  deleteListingRow,
  findListingById,
  findListingByIdTx,
  findPropertyById,
  findUnitCodeConflict,
  listListings,
  updateListingRow,
  withTransaction,
} from "./listings.repository";
import { buildDeletionPreview, type DeletionReport } from "./listings.deletion";
import type {
  CreateListingInput,
  ListingRow,
  ListListingsQuery,
  UpdateListingInput,
} from "./listings.types";

type ServiceOk<T> = { ok: true; status: 200 | 201; data: T };
type ServiceErr = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422;
  // 400 may return a structured error object (e.g. LISTING_MODE_MISMATCH);
  // every other status returns a plain string.
  error: string | Record<string, unknown>;
};
type ServiceResult<T> = ServiceOk<T> | ServiceErr;

interface ActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: AdminRole;
  ip?: string;
  userAgent?: string;
}

export async function getListingsService(
  session: { orgId: string; role: string },
  filters?: ListListingsQuery,
): Promise<ServiceResult<ListingRow[]>> {
  const role = session.role as AdminRole;
  if (!atLeast(role, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const data = await listListings(session.orgId, filters);
  return { ok: true, status: 200, data };
}

export async function getListingByIdService(
  session: { orgId: string; role: string },
  id: string,
): Promise<ServiceResult<ListingRow>> {
  const role = session.role as AdminRole;
  if (!atLeast(role, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const row = await findListingById(session.orgId, id);
  if (!row) return { ok: false, status: 404, error: "Listing not found" };
  return { ok: true, status: 200, data: row };
}

export async function createListingService(
  ctx: ActorCtx,
  input: CreateListingInput,
): Promise<ServiceResult<ListingRow>> {
  if (!atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  const property = await findPropertyById(ctx.orgId, input.propertyId);
  if (!property) return { ok: false, status: 404, error: "Property not found" };

  const conflict = await findUnitCodeConflict({
    organizationId: ctx.orgId,
    propertyId: input.propertyId,
    unitCode: input.unitCode,
    unitType: input.unitType,
  });
  if (conflict) return { ok: false, status: 409, error: "Unit code already exists" };

  const row = await withTransaction(async (tx) => {
    const created = await createListingRow(tx, {
      organizationId: ctx.orgId,
      propertyId: input.propertyId,
      unitCode: input.unitCode,
      unitType: input.unitType,
      photoKeys: input.photoKeys,
      videoKeys: input.videoKeys,
      moveInDate: input.moveInDate,
      readyNow: input.readyNow,
      inChargeName: input.inChargeName,
      inChargePartyId: input.inChargePartyId,
      sourcingAgentId: input.sourcingAgentId,
      visibilityMode: input.visibilityMode,
      hiddenFromPartyIds: input.hiddenFromPartyIds,
      rentalRate: input.rentalRate,
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms,
      floorArea: input.floorArea,
    });

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "listing.create",
      entityType: "Unit",
      entityId: created.id,
      diff: { after: created } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return created;
  });

  return { ok: true, status: 201, data: row };
}

export async function updateListingService(
  ctx: ActorCtx,
  id: string,
  input: UpdateListingInput,
): Promise<ServiceResult<ListingRow>> {
  if (!atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  // Pre-tx existence check — gives us a clean 404 without opening a tx.
  // The transactional path below re-reads with `findListingByIdTx` so the
  // ownership check and the `updateListingRow` write share a snapshot;
  // the outer read exists only for early-exit and unit-code conflict
  // detection. Without the same-tx re-read we had a TOCTOU gap where a
  // row could be re-org'd between the check and the update.
  const preCheck = await findListingById(ctx.orgId, id);
  if (!preCheck) return { ok: false, status: 404, error: "Listing not found" };

  if (input.unitCode) {
    const conflict = await findUnitCodeConflict({
      organizationId: ctx.orgId,
      propertyId: input.propertyId ?? preCheck.propertyId,
      unitCode: input.unitCode,
      unitType: input.unitType ?? preCheck.listingType,
      excludeUnitId: id,
    });
    if (conflict) return { ok: false, status: 409, error: "Unit code already exists" };
  }

  const result = await withTransaction(async (tx) => {
    const before = await findListingByIdTx(tx, ctx.orgId, id);
    if (!before) return null; // raced out — caller returns 404
    const updated = await updateListingRow(tx, id, input);

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "listing.update",
      entityType: "Unit",
      entityId: id,
      diff: { before, after: updated } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return updated;
  });

  if (!result) return { ok: false, status: 404, error: "Listing not found" };
  return { ok: true, status: 200, data: result };
}

export async function getDeletionPreviewService(
  ctx: ActorCtx,
  id: string,
): Promise<ServiceResult<DeletionReport>> {
  if (!canDelete(ctx.actorRole)) {
    return { ok: false, status: 403, error: "Forbidden: admin only" };
  }
  const report = await buildDeletionPreview(getDb(), ctx.orgId, id);
  if (!report) return { ok: false, status: 404, error: "Listing not found" };
  return { ok: true, status: 200, data: report };
}

// Deactivate / reactivate a listing.
//
// "Deactivate" is the soft-delete-by-intent path. Sets listingStatus to
// "archived" (the internal enum string we keep for back-compat; surfaced
// as "Deactivated" in the UI). FK relationships (Tenancy, UnitReservation,
// Charge, Deposit) stay intact — the row is just hidden from inventory,
// reports, and the apartment card. Reversible via reactivateListingService.
//
// Validation blocks deactivation when the listing has live commitments:
//   - active Tenancy → must end the tenancy first
//   - open UnitReservation → must cancel/expire the reservation first
// Historical Charges + Deposits do NOT block — they're records, and the
// listing's FK keeps them resolvable.

export type DeactivateBlocker = {
  reason: "active_tenancy" | "open_reservation";
  count: number;
};

export type DeactivationReport = {
  canDeactivate: boolean;
  blockers: DeactivateBlocker[];
};

async function buildDeactivationReport(
  tx: Prisma.TransactionClient,
  orgId: string,
  listingId: string,
): Promise<DeactivationReport> {
  const [activeTenancies, openReservations] = await Promise.all([
    tx.tenancy.count({
      where: { unitId: listingId, organizationId: orgId, status: "active" },
    }),
    tx.unitReservation.count({
      where: {
        unitId: listingId,
        organizationId: orgId,
        // Treat any non-terminal state as "open". Terminal states are
        // cancelled / expired / signed_completed; everything else blocks.
        status: { notIn: ["cancelled", "expired", "signed_completed"] },
      },
    }),
  ]);

  const blockers: DeactivateBlocker[] = [];
  if (activeTenancies > 0) {
    blockers.push({ reason: "active_tenancy", count: activeTenancies });
  }
  if (openReservations > 0) {
    blockers.push({ reason: "open_reservation", count: openReservations });
  }

  return { canDeactivate: blockers.length === 0, blockers };
}

export async function getDeactivationPreviewService(
  ctx: ActorCtx,
  id: string,
): Promise<ServiceResult<DeactivationReport>> {
  if (!atLeast(ctx.actorRole, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const listing = await findListingById(ctx.orgId, id);
  if (!listing) return { ok: false, status: 404, error: "Listing not found" };

  const report = await withTransaction((tx) =>
    buildDeactivationReport(tx, ctx.orgId, id),
  );
  return { ok: true, status: 200, data: report };
}

export async function deactivateListingService(
  ctx: ActorCtx,
  id: string,
): Promise<ServiceResult<{ id: string } | DeactivationReport>> {
  if (!atLeast(ctx.actorRole, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const listing = await findListingById(ctx.orgId, id);
  if (!listing) return { ok: false, status: 404, error: "Listing not found" };
  if (listing.listingStatus === "archived") {
    return { ok: false, status: 409, error: "Listing is already deactivated" };
  }

  const outcome = await withTransaction(async (tx) => {
    const report = await buildDeactivationReport(tx, ctx.orgId, id);
    if (!report.canDeactivate) {
      return { kind: "blocked" as const, report };
    }
    await tx.listing.update({
      where: { id },
      data: { listingStatus: "archived" },
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "listing.deactivate",
      entityType: "Unit",
      entityId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { kind: "ok" as const };
  });

  if (outcome.kind === "blocked") {
    return {
      ok: false,
      status: 409,
      error: outcome.report as unknown as Record<string, unknown>,
    };
  }
  return { ok: true, status: 200, data: { id } };
}

export async function reactivateListingService(
  ctx: ActorCtx,
  id: string,
): Promise<ServiceResult<{ id: string }>> {
  if (!atLeast(ctx.actorRole, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const listing = await findListingById(ctx.orgId, id);
  if (!listing) return { ok: false, status: 404, error: "Listing not found" };
  if (listing.listingStatus !== "archived") {
    return { ok: false, status: 409, error: "Listing is not deactivated" };
  }

  await withTransaction(async (tx) => {
    await tx.listing.update({
      where: { id },
      // Reactivate as draft — admin republishes via the normal status
      // transition so they can edit/verify before exposing to agents.
      data: { listingStatus: "draft" },
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "listing.reactivate",
      entityType: "Unit",
      entityId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  });

  return { ok: true, status: 200, data: { id } };
}

export async function deleteListingService(
  ctx: ActorCtx,
  id: string,
  confirmCode: string,
): Promise<ServiceResult<{ id: string } | DeletionReport>> {
  if (!canDelete(ctx.actorRole)) {
    return { ok: false, status: 403, error: "Forbidden: admin only" };
  }

  const preCheck = await findListingById(ctx.orgId, id);
  if (!preCheck) return { ok: false, status: 404, error: "Listing not found" };

  // Re-validate inside the transaction. Concurrency safety comes from the
  // FK Restrict constraint at delete time — if a child row appears between
  // this re-check and the delete, the constraint will reject the delete
  // and we surface it as a 409. `SELECT FOR UPDATE` on the parent does
  // NOT block child INSERTs in Postgres, so we don't rely on it.
  const outcome = await withTransaction(async (tx) => {
    const before = await findListingByIdTx(tx, ctx.orgId, id);
    if (!before) return { kind: "not_found" as const };

    const report = await buildDeletionPreview(tx, ctx.orgId, id);
    if (!report) return { kind: "not_found" as const };
    if (!report.canDelete) return { kind: "blocked" as const, report };

    // Type-to-confirm: case-sensitive match against the loaded row's
    // unitCode. unitCode is unique only per (org, property, unitCode,
    // unitType) so this comparison is intentionally against the loaded
    // row, never a query.
    if (confirmCode !== report.unitCode) {
      return { kind: "confirm_mismatch" as const };
    }

    let count: number;
    try {
      const result = await deleteListingRow(tx, id, ctx.orgId);
      count = result.count;
    } catch (err) {
      // Defence-in-depth: an FK Restrict violation here means a child row
      // was inserted between the preview re-check and the delete. Re-run
      // the preview and surface as 409 so the UI shows fresh blockers.
      const code = (err as { code?: string })?.code;
      if (code === "P2003" || code === "P2014") {
        const fresh = await buildDeletionPreview(tx, ctx.orgId, id);
        if (fresh) return { kind: "blocked" as const, report: fresh };
      }
      throw err;
    }

    if (count !== 1) return { kind: "not_found" as const };

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "listing.delete",
      entityType: "Unit",
      entityId: id,
      diff: { before } as unknown as Prisma.InputJsonValue,
      meta: {
        cascadeCounts: report.cascades,
        unitCode: report.unitCode,
      } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return {
      kind: "ok" as const,
      mediaKeys: {
        photoKeys: before.photoKeys,
        coverPhotoKey: before.coverPhotoKey,
        videoKeys: before.videoKeys,
      },
    };
  });

  if (outcome.kind === "ok") {
    // Best-effort storage cleanup — runs AFTER the DB transaction commits so
    // we never delete objects for a row that still exists. Never throws.
    await deleteObjectsBestEffort([
      ...outcome.mediaKeys.photoKeys,
      outcome.mediaKeys.coverPhotoKey,
      ...outcome.mediaKeys.videoKeys,
    ]);
    return { ok: true, status: 200, data: { id } };
  }
  if (outcome.kind === "not_found") {
    return { ok: false, status: 404, error: "Listing not found" };
  }
  if (outcome.kind === "confirm_mismatch") {
    return {
      ok: false,
      status: 400,
      error: "Confirmation code does not match the unit code",
    };
  }
  // blocked
  return {
    ok: false,
    status: 409,
    error: outcome.report as unknown as Record<string, unknown>,
  };
}
