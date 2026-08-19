// Portal-side property creation. After the three-table refactor, agent-
// submitted properties live in PropertySubmission (not Property) until
// admin approval. On approval, a Property row is created from the
// submission's payload by the admin approval flow.
//
// Spec: docs/superpowers/specs/2026-05-19-inventory-three-table-refactor-design.md
//       § PropertySubmission, § portal.properties.service.ts
import { getDb, type Prisma } from "@kason/db";
import type {
  CreatePortalPropertyInput,
  UpdatePortalPropertyInput,
} from "@kason/shared";
import { recordAudit } from "../../../lib/audit";

const TERMINAL_STATES = new Set(["approved", "rejected", "withdrawn"]);

export type PortalPropertiesActorCtx = {
  orgId: string;
  actorUserId: string;
  partyId: string;
  ip?: string;
  userAgent?: string;
};

type Result<T> =
  | { ok: true; status: 200 | 201; data: T }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Create a property submission as an agent. Lands in PropertySubmission
 * with submissionState="pending". Admin approval promotes it to a Property
 * row.
 *
 * 409 is returned when (organizationId, propertyCode) already exists as an
 * approved Property — the canonical uniqueness rule. Two pending
 * submissions for the same code are allowed (admin resolves them), but a
 * proposal that conflicts with an already-approved property is rejected up
 * front so the agent doesn't burn time on a submission that can never
 * succeed.
 */
export async function portalCreatePropertyService(
  ctx: PortalPropertiesActorCtx,
  input: CreatePortalPropertyInput,
): Promise<Result<{ id: string }>> {
  const db = getDb();

  const dup = await db.property.findFirst({
    where: {
      organizationId: ctx.orgId,
      propertyCode: input.propertyCode,
    },
    select: { id: true },
  });
  if (dup) {
    return {
      ok: false,
      status: 409,
      error: "Property code already in use",
    };
  }

  const created = await db.propertySubmission.create({
    data: {
      organizationId: ctx.orgId,
      propertyCode: input.propertyCode.trim(),
      proposedName: input.name.trim(),
      propertyType: input.propertyType,
      addressLine1: input.addressLine1.trim(),
      addressLine2: input.addressLine2?.trim() || null,
      city: input.city.trim(),
      state: input.state?.trim() || null,
      postalCode: input.postalCode?.trim() || null,
      country: input.country.trim(),
      sourcingAgentId: ctx.partyId,
      submissionState: "pending",
      submittedPayload: { ...input } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  await recordAudit(db as unknown as Prisma.TransactionClient, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: "editor",
    action: "property.create.portal",
    entityType: "PropertySubmission",
    entityId: created.id,
    diff: {
      after: {
        id: created.id,
        name: input.name,
        propertyCode: input.propertyCode,
      },
    } as unknown as Prisma.InputJsonValue,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return { ok: true, status: 201, data: { id: created.id } };
}

/**
 * Lists the agent's own PropertySubmissions (every state). Used by the
 * portal to render "your pending properties" alongside the unit submission
 * view. Approved submissions surface here too, with `approvedPropertyId`
 * as the back-pointer to the live Property — the SPA can cross-link.
 */
export async function portalListOwnPropertiesService(
  ctx: PortalPropertiesActorCtx,
) {
  const db = getDb();
  const rows = await db.propertySubmission.findMany({
    where: {
      organizationId: ctx.orgId,
      sourcingAgentId: ctx.partyId,
    },
    select: {
      id: true,
      proposedName: true,
      propertyCode: true,
      propertyType: true,
      submissionState: true,
      amendmentNote: true,
      approvedPropertyId: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map((p) => ({
    id: p.id,
    name: p.proposedName,
    propertyCode: p.propertyCode,
    propertyType: p.propertyType,
    submissionState: p.submissionState,
    amendmentNote: p.amendmentNote,
    approvedPropertyId: p.approvedPropertyId,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
}

type GetResult =
  | {
      ok: true;
      status: 200;
      data: {
        id: string;
        propertyCode: string;
        proposedName: string;
        propertyType: string;
        addressLine1: string;
        addressLine2: string | null;
        city: string;
        state: string | null;
        postalCode: string | null;
        country: string;
        submissionState: string;
        amendmentNote: string | null;
        approvedPropertyId: string | null;
        createdAt: string;
        updatedAt: string;
      };
    }
  | { ok: false; status: 404; error: string };

/**
 * Fetch a single PropertySubmission scoped to the calling agent. Used by
 * the property-edit page to prefill the form. Returns 404 — never 403 —
 * when the submission belongs to another agent, matching the unit
 * lookup pattern (don't leak existence).
 */
export async function portalGetOwnPropertyService(
  ctx: PortalPropertiesActorCtx,
  submissionId: string,
): Promise<GetResult> {
  const db = getDb();
  const row = await db.propertySubmission.findFirst({
    where: {
      id: submissionId,
      organizationId: ctx.orgId,
      sourcingAgentId: ctx.partyId,
    },
    select: {
      id: true,
      propertyCode: true,
      proposedName: true,
      propertyType: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      submissionState: true,
      amendmentNote: true,
      approvedPropertyId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) return { ok: false, status: 404, error: "Submission not found" };
  return {
    ok: true,
    status: 200,
    data: {
      id: row.id,
      propertyCode: row.propertyCode,
      proposedName: row.proposedName,
      propertyType: row.propertyType,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      country: row.country,
      submissionState: row.submissionState,
      amendmentNote: row.amendmentNote,
      approvedPropertyId: row.approvedPropertyId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

type UpdateResult =
  | { ok: true; status: 200; data: { id: string } }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Agent edits & resubmits a PropertySubmission. Allowed only when the
 * current state is pending or needs_amendment. Resubmit flips state back
 * to pending and clears amendmentNote — admin re-reviews from scratch.
 *
 * Cross-agent edits 404 (don't leak existence). Approved / rejected /
 * withdrawn submissions are terminal from the agent's side and 409 with
 * SUBMISSION_NOT_AMENDABLE.
 *
 * submittedPayload is regenerated from the new column values so any
 * downstream consumer that reads the snapshot payload (e.g. admin
 * approve-flow rebuilding the Property row) sees the latest content.
 */
export async function portalUpdateOwnPropertyService(
  ctx: PortalPropertiesActorCtx,
  submissionId: string,
  input: UpdatePortalPropertyInput,
): Promise<UpdateResult> {
  const db = getDb();

  const row = await db.propertySubmission.findFirst({
    where: {
      id: submissionId,
      organizationId: ctx.orgId,
      sourcingAgentId: ctx.partyId,
    },
    select: { id: true, submissionState: true },
  });
  if (!row) return { ok: false, status: 404, error: "Submission not found" };
  if (TERMINAL_STATES.has(row.submissionState)) {
    return { ok: false, status: 409, error: "SUBMISSION_NOT_AMENDABLE" };
  }

  const nextColumns = {
    propertyCode: input.propertyCode.trim(),
    proposedName: input.proposedName.trim(),
    propertyType: input.propertyType,
    addressLine1: input.addressLine1.trim(),
    addressLine2: input.addressLine2?.trim() || null,
    city: input.city.trim(),
    state: input.state?.trim() || null,
    postalCode: input.postalCode?.trim() || null,
    country: input.country.trim(),
  };

  await db.$transaction(async (tx) => {
    await tx.propertySubmission.update({
      where: { id: submissionId },
      data: {
        ...nextColumns,
        submissionState: "pending",
        amendmentNote: null,
        submittedPayload: nextColumns as unknown as Prisma.InputJsonValue,
      },
    });

    await recordAudit(tx as unknown as Prisma.TransactionClient, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: "editor",
      action: "property.amend.portal",
      entityType: "PropertySubmission",
      entityId: submissionId,
      diff: { after: nextColumns } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  });

  return { ok: true, status: 200, data: { id: submissionId } };
}

type CancelResult =
  | { ok: true; status: 200; data: { id: string } }
  | { ok: false; status: 404 | 409; error: string; blockingUnitIds?: string[] };

/**
 * Withdraw a PropertySubmission. Mirrors portalCancelOwnUnitService but
 * with a cascade guard: if any child UnitSubmission is still pending or
 * needs_amendment, the withdraw is rejected with PROPERTY_HAS_PENDING_UNITS
 * and the blocking ids are surfaced in the error payload. Agent withdraws
 * those first, then the property.
 *
 * Rationale (spec §4.8 Option B): cascading auto-withdraw would silently
 * lose pending unit work that the agent attached via B7. Making them
 * withdraw children first makes the intent explicit.
 */
export async function portalCancelOwnPropertyService(
  ctx: PortalPropertiesActorCtx,
  submissionId: string,
): Promise<CancelResult> {
  const db = getDb();

  const row = await db.propertySubmission.findFirst({
    where: {
      id: submissionId,
      organizationId: ctx.orgId,
      sourcingAgentId: ctx.partyId,
    },
    select: { id: true, submissionState: true },
  });
  if (!row) return { ok: false, status: 404, error: "Submission not found" };
  if (TERMINAL_STATES.has(row.submissionState)) {
    return { ok: false, status: 409, error: "SUBMISSION_NOT_AMENDABLE" };
  }

  const blockingChildren = await db.unitSubmission.findMany({
    where: {
      propertySubmissionId: submissionId,
      submissionState: { in: ["pending", "needs_amendment"] },
    },
    select: { id: true },
  });
  if (blockingChildren.length > 0) {
    return {
      ok: false,
      status: 409,
      error: "PROPERTY_HAS_PENDING_UNITS",
      blockingUnitIds: blockingChildren.map((u) => u.id),
    };
  }

  await db.$transaction(async (tx) => {
    await tx.propertySubmission.update({
      where: { id: submissionId },
      data: { submissionState: "withdrawn" },
    });

    await recordAudit(tx as unknown as Prisma.TransactionClient, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: "editor",
      action: "property.withdraw.portal",
      entityType: "PropertySubmission",
      entityId: submissionId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  });

  return { ok: true, status: 200, data: { id: submissionId } };
}
