// apps/api/src/modules/submissions/property-submission.service.ts
//
// Admin-side PropertySubmission lifecycle: approve / reject / needs-amendment.
// Restores the Phase-C follow-up that the 2026-05-19 three-table inventory
// refactor left behind (see docs/superpowers/specs/
// 2026-05-21-inventory-restoration-and-bug-cleanup-design.md §5.2 S2.a).
//
// Mirror of submission.service.ts's UnitSubmission handlers, kept in a
// separate file because PropertySubmission and UnitSubmission have different
// schemas, different payload shapes, and different downstream effects on
// approval. Co-located so future readers find them together.

import { getDb, Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";

type Session = { orgId: string; userId: string; partyId?: string; actorRole?: string };

type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error });

// =============================================================================
// Approve — creates a real Property row + cascades to child UnitSubmissions.
// =============================================================================
//
// Cascade strategy (eager rewrite — see spec §5.2 S2.d):
// When admin approves a property submission, any UnitSubmission rows the
// agent attached via `propertySubmissionId` get rewritten in the same
// transaction: `propertyId = newPropertyId, propertySubmissionId = null`.
// This lets downstream unit-submission approval read `propertyId` directly
// without a special "submission-resolved" branch.

export async function approvePropertySubmissionService(
  ctx: Session,
  submissionId: string,
): Promise<Result<{ approvedPropertyId: string }>> {
  const db = getDb();
  const sub = await db.propertySubmission.findFirst({
    where: { id: submissionId, organizationId: ctx.orgId },
  });
  if (!sub) return err(404, "Property submission not found");
  if (sub.submissionState !== "pending" && sub.submissionState !== "needs_amendment") {
    return err(409, "Property submission not approvable from current state");
  }

  return db.$transaction(async (tx) => {
    // Create the real Property row from the submission's pinned columns.
    // We do NOT spread submittedPayload — it stores the agent's submission
    // snapshot (whose keys include PropertySubmission-only columns like
    // `proposedName`), and createPortalPropertySchema doesn't carry any
    // Property-only extras. Spreading would smuggle in unknown args and
    // crash Prisma — that's the post-amend approve regression (proposedName
    // collision when nextColumns from portalUpdateOwnPropertyService writes
    // the snapshot back).
    const property = await tx.property.create({
      data: {
        organizationId: sub.organizationId,
        propertyCode: sub.propertyCode,
        name: sub.proposedName,
        propertyType: sub.propertyType,
        addressLine1: sub.addressLine1,
        addressLine2: sub.addressLine2,
        city: sub.city,
        state: sub.state,
        postalCode: sub.postalCode,
        country: sub.country,
        status: "active",
        // Property.publishStatus is NOT NULL; matches the "draft" default
        // every other Property create path uses (admin direct create, sales
        // import). Admin can flip to "published" later via the property edit
        // dialog if it should be visible to other agents.
        publishStatus: "draft",
      } as Prisma.PropertyUncheckedCreateInput,
      select: { id: true },
    });

    // Mark the submission approved and link to the materialised property.
    await tx.propertySubmission.update({
      where: { id: submissionId },
      data: {
        submissionState: "approved",
        approvedAt: new Date(),
        approvedById: ctx.userId,
        approvedPropertyId: property.id,
      },
    });

    // Cascade: rewrite child unit submissions to reference the real property
    // directly. Any UnitSubmission that was attached via propertySubmissionId
    // (because the property was still pending when the agent filed the unit)
    // now points to a real Property and can be approved normally.
    await tx.unitSubmission.updateMany({
      where: { propertySubmissionId: submissionId },
      data: { propertyId: property.id, propertySubmissionId: null },
    });

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      actorRole: ctx.actorRole ?? "admin",
      action: "property_submission.approved",
      entityType: "Property",
      entityId: property.id,
    });

    return ok({ approvedPropertyId: property.id });
  });
}

// =============================================================================
// Needs amendment — non-terminal, sends back to the agent.
// =============================================================================

export async function setPropertySubmissionNeedsAmendmentService(
  ctx: Session,
  submissionId: string,
  note: string,
): Promise<Result<{ id: string }>> {
  const db = getDb();
  const sub = await db.propertySubmission.findFirst({
    where: { id: submissionId, organizationId: ctx.orgId },
    select: { id: true, submissionState: true },
  });
  if (!sub) return err(404, "Property submission not found");
  if (sub.submissionState !== "pending") {
    return err(409, "Only pending property submissions can be sent back");
  }

  await db.$transaction(async (tx) => {
    await tx.propertySubmission.update({
      where: { id: submissionId },
      data: { submissionState: "needs_amendment", amendmentNote: note },
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      actorRole: ctx.actorRole ?? "admin",
      action: "property_submission.needs_amendment",
      entityType: "PropertySubmission",
      entityId: submissionId,
      diff: { note } as unknown as Prisma.InputJsonValue,
    });
  });

  return ok({ id: submissionId });
}

// =============================================================================
// Reject — terminal.
// =============================================================================

export async function rejectPropertySubmissionService(
  ctx: Session,
  submissionId: string,
  note: string,
): Promise<Result<{ id: string }>> {
  const db = getDb();
  const sub = await db.propertySubmission.findFirst({
    where: { id: submissionId, organizationId: ctx.orgId },
    select: { id: true, submissionState: true },
  });
  if (!sub) return err(404, "Property submission not found");
  if (sub.submissionState !== "pending" && sub.submissionState !== "needs_amendment") {
    return err(409, "Property submission not rejectable from current state");
  }

  await db.$transaction(async (tx) => {
    await tx.propertySubmission.update({
      where: { id: submissionId },
      data: { submissionState: "rejected", amendmentNote: note },
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      actorRole: ctx.actorRole ?? "admin",
      action: "property_submission.rejected",
      entityType: "PropertySubmission",
      entityId: submissionId,
      diff: { note } as unknown as Prisma.InputJsonValue,
    });
  });

  return ok({ id: submissionId });
}
