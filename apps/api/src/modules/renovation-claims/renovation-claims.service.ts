import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { atLeast, type AdminRole } from "../../lib/rbac";
import { requireBucket } from "../../lib/storage";
import {
  appendClaimTransition,
  createClaimDocumentRow,
  createClaimRow,
  createPackageRow,
  deleteClaimDocumentRow,
  findClaimById,
  findClaimByIdTx,
  findClaimDocumentById,
  findFullClaimByIdTx,
  findPackageById,
  findPackageByIdTx,
  findPackageByKeyConflict,
  findSalesUnitForClaim,
  findSalesUnitForClaimTx,
  listClaimDocumentsTx,
  listClaims,
  listPackages,
  listRenovationClaimTransitions,
  updateClaimRow,
  updatePackageRow,
  withTransaction,
  type ClaimTransitionRow,
} from "./renovation-claims.repository";
import type {
  CreateClaimInput,
  CreatePackageInput,
  ListClaimsQuery,
  ListPackagesQuery,
  RenovationClaimRow,
  RenovationPackageRow,
  UpdateClaimInput,
  UpdatePackageInput,
} from "./renovation-claims.types";
import {
  validateDocumentGate,
  validateSplitsHundredPercent,
} from "./renovation-claims.validators";

type ServiceOk<T> = { ok: true; status: 200 | 201; data: T };
type ServiceErr = { ok: false; status: 400 | 403 | 404 | 409; error: string };
export type RenovationServiceResult<T> = ServiceOk<T> | ServiceErr;

export interface RenovationActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: AdminRole;
  ip?: string;
  userAgent?: string;
}

const TERMINAL_STATUSES = new Set(["approved", "rejected", "cancelled"]);

// ─── Packages ────────────────────────────────────────────────────────────────

export async function listPackagesService(
  ctx: RenovationActorCtx,
  filters?: ListPackagesQuery,
): Promise<RenovationServiceResult<RenovationPackageRow[]>> {
  if (!atLeast(ctx.actorRole, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const data = await listPackages(ctx.orgId, filters);
  return { ok: true, status: 200, data };
}

export async function getPackageByIdService(
  ctx: RenovationActorCtx,
  id: string,
): Promise<RenovationServiceResult<RenovationPackageRow>> {
  if (!atLeast(ctx.actorRole, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const row = await findPackageById(ctx.orgId, id);
  if (!row) return { ok: false, status: 404, error: "Renovation package not found" };
  return { ok: true, status: 200, data: row };
}

export async function createPackageService(
  ctx: RenovationActorCtx,
  input: CreatePackageInput,
): Promise<RenovationServiceResult<RenovationPackageRow>> {
  if (!atLeast(ctx.actorRole, "admin")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const conflict = await findPackageByKeyConflict({
    organizationId: ctx.orgId,
    key: input.key,
  });
  if (conflict) {
    return { ok: false, status: 409, error: "Renovation package key already exists" };
  }
  // 100% rule on initial splits if provided.
  const splits = input.defaultSplits ?? [];
  if (splits.length > 0) {
    const v = validateSplitsHundredPercent(splits, input.defaultPrice);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
  }

  const row = await withTransaction(async (tx) => {
    const created = await createPackageRow(tx, {
      organizationId: ctx.orgId,
      key: input.key,
      label: input.label,
      description: input.description ?? null,
      defaultPrice: input.defaultPrice,
      archived: input.archived,
      sortOrder: input.sortOrder,
      defaultSplits: splits,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "renovation.package.create",
      entityType: "RenovationPackage",
      entityId: created.id,
      diff: { after: created } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return created;
  });
  return { ok: true, status: 201, data: row };
}

export async function updatePackageService(
  ctx: RenovationActorCtx,
  id: string,
  input: UpdatePackageInput,
): Promise<RenovationServiceResult<RenovationPackageRow>> {
  if (!atLeast(ctx.actorRole, "admin")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const before = await findPackageById(ctx.orgId, id);
  if (!before) return { ok: false, status: 404, error: "Renovation package not found" };

  // 100% rule on splits — re-validated whenever splits OR defaultPrice change.
  const splitsToValidate = input.defaultSplits ?? before.defaultSplits;
  const priceToValidate = input.defaultPrice ?? before.defaultPrice;
  if (splitsToValidate.length > 0) {
    const v = validateSplitsHundredPercent(splitsToValidate, priceToValidate);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
  }

  const row = await withTransaction(async (tx) => {
    const fresh = await findPackageByIdTx(tx, ctx.orgId, id);
    if (!fresh) return null;
    const updated = await updatePackageRow(tx, id, ctx.orgId, {
      label: input.label,
      description: input.description,
      defaultPrice: input.defaultPrice,
      archived: input.archived,
      sortOrder: input.sortOrder,
      defaultSplits: input.defaultSplits,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "renovation.package.update",
      entityType: "RenovationPackage",
      entityId: id,
      diff: { before: fresh, after: updated } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  });
  if (!row) return { ok: false, status: 404, error: "Renovation package not found" };
  return { ok: true, status: 200, data: row };
}

// ─── Claims (read) ───────────────────────────────────────────────────────────

export async function listClaimsService(
  ctx: RenovationActorCtx,
  filters: ListClaimsQuery & { submittedByEq?: string },
  options?: { forceFullSelect?: boolean },
): Promise<RenovationServiceResult<RenovationClaimRow[]>> {
  if (!atLeast(ctx.actorRole, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const data = await listClaims(ctx.orgId, ctx.actorRole, filters, {
    forceFullSelect: options?.forceFullSelect,
  });
  return { ok: true, status: 200, data };
}

export async function getClaimByIdService(
  ctx: RenovationActorCtx,
  id: string,
  options?: { requireSubmittedById?: string; forceFullSelect?: boolean },
): Promise<RenovationServiceResult<RenovationClaimRow>> {
  if (!atLeast(ctx.actorRole, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const row = await findClaimById(ctx.orgId, ctx.actorRole, id, {
    forceFullSelect: options?.forceFullSelect,
  });
  if (!row) return { ok: false, status: 404, error: "Renovation claim not found" };
  if (
    options?.requireSubmittedById &&
    row.submittedById !== options.requireSubmittedById
  ) {
    return { ok: false, status: 404, error: "Renovation claim not found" };
  }
  return { ok: true, status: 200, data: row };
}

/**
 * Audit timeline for a RenovationClaim. Mirrors getClaimByIdService's
 * auth shape so portal callers can reuse the `requireSubmittedById`
 * ownership gate.
 *
 * Returns 404 (not 403) on cross-org or wrong-owner so we don't leak
 * existence — same convention as getClaimByIdService.
 */
export async function listClaimTransitionsService(
  ctx: RenovationActorCtx,
  id: string,
  options?: { requireSubmittedById?: string },
): Promise<RenovationServiceResult<ClaimTransitionRow[]>> {
  if (!atLeast(ctx.actorRole, "editor") && !options?.requireSubmittedById) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const claim = await findClaimById(ctx.orgId, "manager", id);
  if (!claim) return { ok: false, status: 404, error: "Renovation claim not found" };
  if (
    options?.requireSubmittedById &&
    claim.submittedById !== options.requireSubmittedById
  ) {
    return { ok: false, status: 404, error: "Renovation claim not found" };
  }
  const data = await listRenovationClaimTransitions(ctx.orgId, id);
  return { ok: true, status: 200, data };
}

// ─── Claims (mutations) ──────────────────────────────────────────────────────

/**
 * Submit a new RenovationClaim. Used by the portal (agent) flow with
 * `requireOwnerPartyId` for ownership; admin direct-submit isn't in scope
 * for W2b but the service is shape-compatible.
 *
 * Validates:
 *   1. SalesUnit exists & (when required) the agent owns it.
 *   2. Package exists.
 *   3. packagePrice matches the snapshot semantics (we trust the caller-supplied
 *      number AND record what the package's defaultPrice was at this moment).
 *   4. 100% split rule.
 *   5. Document gate (≥1 quotation, ≥1 invoice).
 *
 * Documents arrive as `fileKey` strings already PUT to Supabase via the
 * upload-url endpoint; we materialise RenovationClaimDocument rows for each.
 */
export async function createClaimService(
  ctx: RenovationActorCtx,
  input: CreateClaimInput,
  options: {
    requireSalesUnitOwnerPartyId?: string;
    auditAction?: string;
  } = {},
): Promise<RenovationServiceResult<RenovationClaimRow>> {
  // SalesUnit lookup + ownership.
  const sales = await findSalesUnitForClaim(ctx.orgId, input.salesUnitId);
  if (!sales) return { ok: false, status: 404, error: "Sales unit not found" };
  if (
    options.requireSalesUnitOwnerPartyId &&
    sales.agentPartyId !== options.requireSalesUnitOwnerPartyId
  ) {
    return { ok: false, status: 404, error: "Sales unit not found" };
  }

  // Package lookup.
  const pkg = await findPackageById(ctx.orgId, input.packageId);
  if (!pkg) return { ok: false, status: 404, error: "Renovation package not found" };
  if (pkg.archived) {
    return { ok: false, status: 400, error: "Renovation package is archived" };
  }

  // 100% split rule.
  const v = validateSplitsHundredPercent(input.splits, input.packagePrice);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  // Document gate.
  const g = validateDocumentGate(input.documents);
  if (!g.ok) return { ok: false, status: 400, error: g.error };

  const row = await withTransaction(async (tx) => {
    const created = await createClaimRow(tx, {
      organizationId: ctx.orgId,
      salesUnitId: input.salesUnitId,
      packageId: input.packageId,
      packagePrice: input.packagePrice,
      paymentType: input.paymentType,
      monthlyOffsetAmount: input.monthlyOffsetAmount ?? null,
      notes: input.notes ?? null,
      submittedById: ctx.actorUserId,
      splits: input.splits.map((s) => ({
        partyPartyId: s.partyPartyId ?? null,
        partyDisplayName: s.partyDisplayName,
        roleLabel: s.roleLabel,
        splitType: s.splitType,
        splitValue: s.splitValue,
        isHouseKeep: s.isHouseKeep,
        sortOrder: s.sortOrder,
      })),
    });

    // Materialise documents.
    for (const doc of input.documents) {
      await createClaimDocumentRow(tx, {
        organizationId: ctx.orgId,
        claimId: created.id,
        kind: doc.kind,
        fileKey: doc.fileKey,
        filename: doc.filename,
        uploadedById: ctx.actorUserId,
      });
    }

    await appendClaimTransition(tx, {
      organizationId: ctx.orgId,
      claimId: created.id,
      fromStatus: null,
      toStatus: "submitted",
      changedById: ctx.actorUserId,
      note: null,
    });

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: options.auditAction ?? "renovation.claim.create",
      entityType: "RenovationClaim",
      entityId: created.id,
      diff: { after: created } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    // Re-read the freshly-created claim WITH its documents.
    const fresh = await findFullClaimByIdTx(tx, ctx.orgId, created.id);
    return fresh ?? created;
  });

  return { ok: true, status: 201, data: row };
}

/**
 * PATCH a claim (portal: own-only).
 *
 * Edit-after-approval rebound: if the claim was already approved, flip to
 * `needs_amendment`, set reviewerNote, append a transition. Mirrors the
 * sales-units rebound from W2a.
 *
 * If splits change → re-validate 100%.
 */
export async function updateClaimService(
  ctx: RenovationActorCtx,
  id: string,
  input: UpdateClaimInput,
  options: {
    requireSubmittedById?: string;
    rebindOnApproval?: boolean;
    auditAction?: string;
  } = {},
): Promise<RenovationServiceResult<RenovationClaimRow>> {
  const preCheck = await findClaimById(ctx.orgId, "manager", id);
  if (!preCheck) return { ok: false, status: 404, error: "Renovation claim not found" };

  // Ownership check (portal path).
  if (
    options.requireSubmittedById &&
    preCheck.submittedById !== options.requireSubmittedById
  ) {
    return { ok: false, status: 404, error: "Renovation claim not found" };
  }

  // RBAC: admin-side editing requires manager+; portal-side requires
  // requireSubmittedById to be set.
  if (!options.requireSubmittedById && !atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  // Re-validate splits if changed (or price changed and splits exist).
  const splitsToValidate = input.splits ?? preCheck.splits ?? [];
  const priceToValidate = input.packagePrice ?? preCheck.packagePrice ?? 0;
  if (input.splits !== undefined || input.packagePrice !== undefined) {
    if (splitsToValidate.length === 0) {
      return { ok: false, status: 400, error: "At least one split is required" };
    }
    const v = validateSplitsHundredPercent(splitsToValidate, priceToValidate);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
  }

  const row = await withTransaction(async (tx) => {
    const before = await findFullClaimByIdTx(tx, ctx.orgId, id);
    if (!before) return null;
    if (
      options.requireSubmittedById &&
      before.submittedById !== options.requireSubmittedById
    ) {
      return null;
    }

    let extra: {
      status?: "needs_amendment";
      reviewerNote?: string | null;
      reviewedAt?: Date | null;
      reviewedById?: string | null;
    } = {};
    let appendRebound = false;
    if (options.rebindOnApproval && before.status === "approved") {
      extra = {
        status: "needs_amendment",
        reviewerNote: "Edited by agent post-approval",
        reviewedAt: null,
        reviewedById: null,
      };
      appendRebound = true;
    }

    const updated = await updateClaimRow(tx, id, ctx.orgId, {
      packageId: input.packageId,
      packagePrice: input.packagePrice,
      paymentType: input.paymentType,
      monthlyOffsetAmount: input.monthlyOffsetAmount,
      notes: input.notes,
      splits: input.splits?.map((s) => ({
        partyPartyId: s.partyPartyId ?? null,
        partyDisplayName: s.partyDisplayName,
        roleLabel: s.roleLabel,
        splitType: s.splitType,
        splitValue: s.splitValue,
        isHouseKeep: s.isHouseKeep,
        sortOrder: s.sortOrder,
      })),
      ...extra,
    });

    if (appendRebound) {
      await appendClaimTransition(tx, {
        organizationId: ctx.orgId,
        claimId: id,
        fromStatus: "approved",
        toStatus: "needs_amendment",
        changedById: ctx.actorUserId,
        note: "Edited by agent post-approval",
      });
    }

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: options.auditAction ?? "renovation.claim.update",
      entityType: "RenovationClaim",
      entityId: id,
      diff: { before, after: updated } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  });

  if (!row) return { ok: false, status: 404, error: "Renovation claim not found" };
  return { ok: true, status: 200, data: row };
}

/**
 * Cancel/withdraw a renovation claim. Two callers — same shape as
 * sales-claims.cancelClaimService:
 *   - Portal (agent): own claim, only when status="submitted"
 *   - Admin (manager+): any non-terminal claim in the org
 *
 * "Cancelled" is a new terminal status. The status column is a String
 * so no migration is needed; only the validation enum and the
 * terminal-statuses set are updated.
 */
export async function cancelClaimService(
  ctx: RenovationActorCtx,
  id: string,
  options: {
    requireSubmittedById?: string;
    note?: string | null;
    auditAction?: string;
  } = {},
): Promise<RenovationServiceResult<RenovationClaimRow>> {
  const preCheck = await findClaimById(ctx.orgId, "manager", id);
  if (!preCheck) return { ok: false, status: 404, error: "Renovation claim not found" };

  if (
    options.requireSubmittedById &&
    preCheck.submittedById !== options.requireSubmittedById
  ) {
    return { ok: false, status: 404, error: "Renovation claim not found" };
  }

  if (!options.requireSubmittedById && !atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  if (TERMINAL_STATUSES.has(preCheck.status)) {
    return { ok: false, status: 409, error: `Claim is already ${preCheck.status}` };
  }
  if (
    options.requireSubmittedById &&
    preCheck.status !== "submitted"
  ) {
    return {
      ok: false,
      status: 409,
      error: "Only submitted claims can be withdrawn",
    };
  }

  const row = await withTransaction(async (tx) => {
    const updated = await updateClaimRow(tx, id, ctx.orgId, {
      status: "cancelled",
    });
    await appendClaimTransition(tx, {
      organizationId: ctx.orgId,
      claimId: id,
      fromStatus: preCheck.status,
      toStatus: "cancelled",
      changedById: ctx.actorUserId,
      note: options.note ?? null,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: options.auditAction ?? "renovation.claim.cancel",
      entityType: "RenovationClaim",
      entityId: id,
      diff: {
        before: { status: preCheck.status },
        after: { status: "cancelled" },
      } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  });
  if (!row) return { ok: false, status: 404, error: "Renovation claim not found" };
  return { ok: true, status: 200, data: row };
}

// ─── Approve / reject / needs-amendment ──────────────────────────────────────

export async function approveClaimService(
  ctx: RenovationActorCtx,
  id: string,
): Promise<RenovationServiceResult<RenovationClaimRow>> {
  if (!atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const preCheck = await findClaimById(ctx.orgId, "manager", id);
  if (!preCheck) return { ok: false, status: 404, error: "Renovation claim not found" };

  if (TERMINAL_STATUSES.has(preCheck.status)) {
    return { ok: false, status: 409, error: `Claim is already ${preCheck.status}` };
  }

  // Re-validate splits at approve time.
  if (!preCheck.splits || preCheck.splits.length === 0) {
    return { ok: false, status: 400, error: "Claim has no splits" };
  }
  const v = validateSplitsHundredPercent(preCheck.splits, preCheck.packagePrice ?? 0);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  // Re-run the document gate at approve time. Submit-time validation is
  // necessary but not sufficient: an agent can DELETE a quotation between
  // submit and approve via DELETE /documents/:docId, leaving an approved
  // claim that violates the gate. Re-checking here closes that hole.
  const g = validateDocumentGate(preCheck.documents ?? []);
  if (!g.ok) return { ok: false, status: 400, error: g.error };

  const row = await withTransaction(async (tx) => {
    const before = await findFullClaimByIdTx(tx, ctx.orgId, id);
    if (!before) return null;
    if (TERMINAL_STATUSES.has(before.status)) return "terminal" as const;

    const updated = await updateClaimRow(tx, id, ctx.orgId, {
      status: "approved",
      reviewedAt: new Date(),
      reviewedById: ctx.actorUserId,
    });
    await appendClaimTransition(tx, {
      organizationId: ctx.orgId,
      claimId: id,
      fromStatus: before.status,
      toStatus: "approved",
      changedById: ctx.actorUserId,
      note: null,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "renovation.claim.approve",
      entityType: "RenovationClaim",
      entityId: id,
      diff: {
        before: { status: before.status },
        after: { status: "approved" },
      } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  });

  if (row === "terminal") {
    return { ok: false, status: 409, error: "Claim is already in a terminal state" };
  }
  if (!row) return { ok: false, status: 404, error: "Renovation claim not found" };
  return { ok: true, status: 200, data: row };
}

export async function rejectClaimService(
  ctx: RenovationActorCtx,
  id: string,
  note: string,
): Promise<RenovationServiceResult<RenovationClaimRow>> {
  return reviewerActionInternal(ctx, id, note, "rejected", "renovation.claim.reject");
}

export async function needsAmendmentClaimService(
  ctx: RenovationActorCtx,
  id: string,
  note: string,
): Promise<RenovationServiceResult<RenovationClaimRow>> {
  return reviewerActionInternal(
    ctx,
    id,
    note,
    "needs_amendment",
    "renovation.claim.needs_amendment",
  );
}

async function reviewerActionInternal(
  ctx: RenovationActorCtx,
  id: string,
  note: string,
  toStatus: "rejected" | "needs_amendment",
  auditAction: string,
): Promise<RenovationServiceResult<RenovationClaimRow>> {
  if (!atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const preCheck = await findClaimById(ctx.orgId, "manager", id);
  if (!preCheck) return { ok: false, status: 404, error: "Renovation claim not found" };

  if (TERMINAL_STATUSES.has(preCheck.status)) {
    return { ok: false, status: 409, error: `Claim is already ${preCheck.status}` };
  }

  const row = await withTransaction(async (tx) => {
    const before = await findFullClaimByIdTx(tx, ctx.orgId, id);
    if (!before) return null;
    if (TERMINAL_STATUSES.has(before.status)) return "terminal" as const;

    const updated = await updateClaimRow(tx, id, ctx.orgId, {
      status: toStatus,
      reviewerNote: note,
      reviewedAt: new Date(),
      reviewedById: ctx.actorUserId,
    });
    await appendClaimTransition(tx, {
      organizationId: ctx.orgId,
      claimId: id,
      fromStatus: before.status,
      toStatus,
      changedById: ctx.actorUserId,
      note,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: auditAction,
      entityType: "RenovationClaim",
      entityId: id,
      diff: {
        before: { status: before.status, reviewerNote: before.reviewerNote },
        after: { status: toStatus, reviewerNote: note },
      } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  });

  if (row === "terminal") {
    return { ok: false, status: 409, error: "Claim is already in a terminal state" };
  }
  if (!row) return { ok: false, status: 404, error: "Renovation claim not found" };
  return { ok: true, status: 200, data: row };
}

// ─── Documents ──────────────────────────────────────────────────────────────

/**
 * Build storage prefix for a renovation-claim document.
 *
 * Includes organizationId/claimId so cross-tenant URL guessing is impossible.
 * For pre-claim uploads (claimId not yet known) the temp prefix lets the
 * sweeper recover orphans after 24h.
 */
export function buildClaimDocumentStorageKey(params: {
  organizationId: string;
  claimId: string | null;
  uuid: string;
  filename: string;
}): string {
  const slot = params.claimId ?? "tmp";
  // Strip any path separators from filename to prevent prefix-escape.
  const safe = params.filename.replace(/[\\/]/g, "_");
  return `renovation-claims/${params.organizationId}/${slot}/${params.uuid}-${safe}`;
}

export async function markDocumentUploadedService(
  ctx: RenovationActorCtx,
  claimId: string,
  input: {
    fileKey: string;
    // Wider kind set added in PR6 — keep this in sync with the
    // documentKindEnum in renovation-claims.validation.ts. The portal route
    // pre-validates against that schema, so any value reaching this service
    // is already known-safe.
    kind:
      | "quotation"
      | "invoice"
      | "agreement"
      | "progress_photo"
      | "before_photo"
      | "after_photo"
      | "contract";
    filename: string;
  },
  options: { requireSubmittedById?: string; auditAction?: string } = {},
): Promise<
  RenovationServiceResult<{
    document: import("./renovation-claims.types").RenovationClaimDocumentRow;
  }>
> {
  const claim = await findClaimById(ctx.orgId, "manager", claimId);
  if (!claim) return { ok: false, status: 404, error: "Renovation claim not found" };
  if (
    options.requireSubmittedById &&
    claim.submittedById !== options.requireSubmittedById
  ) {
    return { ok: false, status: 404, error: "Renovation claim not found" };
  }

  // Defence-in-depth: storage key must contain orgId and either the claimId
  // or "tmp" — never another org's prefix.
  const expectedOrgPrefix = `renovation-claims/${ctx.orgId}/`;
  if (!input.fileKey.startsWith(expectedOrgPrefix)) {
    return { ok: false, status: 400, error: "Invalid file key" };
  }

  const document = await withTransaction(async (tx) => {
    const created = await createClaimDocumentRow(tx, {
      organizationId: ctx.orgId,
      claimId,
      kind: input.kind,
      fileKey: input.fileKey,
      filename: input.filename,
      uploadedById: ctx.actorUserId,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: options.auditAction ?? "renovation.claim.document.upload",
      entityType: "RenovationClaimDocument",
      entityId: created.id,
      diff: { after: created } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return created;
  });

  return { ok: true, status: 201, data: { document } };
}

export async function deleteDocumentService(
  ctx: RenovationActorCtx,
  claimId: string,
  docId: string,
  deps: { deleteObject: (bucket: string, key: string) => Promise<void> },
  options: { requireSubmittedById?: string; auditAction?: string } = {},
): Promise<RenovationServiceResult<{ ok: true }>> {
  const claim = await findClaimById(ctx.orgId, "manager", claimId);
  if (!claim) return { ok: false, status: 404, error: "Renovation claim not found" };
  if (
    options.requireSubmittedById &&
    claim.submittedById !== options.requireSubmittedById
  ) {
    return { ok: false, status: 404, error: "Renovation claim not found" };
  }

  const doc = await findClaimDocumentById(ctx.orgId, claimId, docId);
  if (!doc) return { ok: false, status: 404, error: "Document not found" };

  await withTransaction(async (tx) => {
    await deleteClaimDocumentRow(tx, ctx.orgId, claimId, docId);
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: options.auditAction ?? "renovation.claim.document.delete",
      entityType: "RenovationClaimDocument",
      entityId: docId,
      diff: { before: doc } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  });

  // Best-effort storage delete after the DB row is gone — failures here are
  // surfaced by the sweeper's orphan reaper, not the API call.
  try {
    await deps.deleteObject(requireBucket(), doc.fileKey);
  } catch {
    // Swallow: object may already be missing or the bucket layer flaked.
  }

  return { ok: true, status: 200, data: { ok: true } };
}

export async function getDocumentViewUrlService(
  ctx: RenovationActorCtx,
  claimId: string,
  docId: string,
  deps: {
    signSupabaseView: (key: string) => Promise<{ viewUrl: string; expiresAt: Date }>;
  },
  options: { requireSubmittedById?: string } = {},
): Promise<RenovationServiceResult<{ viewUrl: string; expiresAt: Date }>> {
  const claim = await findClaimById(ctx.orgId, "manager", claimId);
  if (!claim) return { ok: false, status: 404, error: "Renovation claim not found" };
  if (
    options.requireSubmittedById &&
    claim.submittedById !== options.requireSubmittedById
  ) {
    return { ok: false, status: 404, error: "Renovation claim not found" };
  }

  const doc = await findClaimDocumentById(ctx.orgId, claimId, docId);
  if (!doc) return { ok: false, status: 404, error: "Document not found" };

  // Defence-in-depth on the storage key prefix — same reason as
  // markDocumentUploadedService.
  const expectedOrgPrefix = `renovation-claims/${ctx.orgId}/`;
  if (!doc.fileKey.startsWith(expectedOrgPrefix)) {
    return { ok: false, status: 404, error: "Document not found" };
  }

  const { viewUrl, expiresAt } = await deps.signSupabaseView(doc.fileKey);
  return { ok: true, status: 200, data: { viewUrl, expiresAt } };
}

/**
 * Helper exposed for tests — returns the in-tx full document list, used
 * when admin re-validates the document gate at approve time. (Approve does
 * NOT re-run the gate today: docs were validated at submit and edits go
 * through PATCH which can't change documents — only the upload/delete
 * endpoints can. This helper is here for future-proofing.)
 */
export async function loadClaimDocumentsTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  claimId: string,
) {
  return listClaimDocumentsTx(tx, organizationId, claimId);
}

// Re-export for convenience.
export { findSalesUnitForClaim, findSalesUnitForClaimTx };
