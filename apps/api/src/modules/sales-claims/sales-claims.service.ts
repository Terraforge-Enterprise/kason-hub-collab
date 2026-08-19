import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { atLeast, type AdminRole } from "../../lib/rbac";
import {
  appendClaimTransition,
  createClaimRow,
  findClaimById,
  findFullClaimByIdTx,
  findSalesUnitForClaim,
  listClaims,
  listSalesClaimTransitions,
  updateClaimRow,
  withTransaction,
  type ClaimTransitionRow,
} from "./sales-claims.repository";
import type {
  CommissionType,
  CreateClaimInput,
  ListClaimsQuery,
  SalesClaimRow,
  SalesPaymentType,
  UpdateClaimInput,
} from "./sales-claims.types";
import {
  computeSalesCommissionAmount,
  validateSalesSplitsHundredPercent,
} from "./sales-claims.validators";

type ServiceOk<T> = { ok: true; status: 200 | 201; data: T };
type ServiceErr = { ok: false; status: 400 | 403 | 404 | 409; error: string };
export type SalesClaimsServiceResult<T> = ServiceOk<T> | ServiceErr;

export interface SalesClaimsActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: AdminRole;
  ip?: string;
  userAgent?: string;
}

const TERMINAL_STATUSES = new Set(["approved", "rejected", "cancelled"]);

// ─── Claims (read) ───────────────────────────────────────────────────────────

export async function listClaimsService(
  ctx: SalesClaimsActorCtx,
  filters: ListClaimsQuery & { submittedByEq?: string },
  options?: { forceFullSelect?: boolean },
): Promise<SalesClaimsServiceResult<SalesClaimRow[]>> {
  if (!atLeast(ctx.actorRole, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const data = await listClaims(ctx.orgId, ctx.actorRole, filters, {
    forceFullSelect: options?.forceFullSelect,
  });
  return { ok: true, status: 200, data };
}

/**
 * Audit timeline for a SalesClaim. Mirrors getClaimByIdService's auth
 * shape so portal callers can reuse the `requireSubmittedById` ownership
 * gate that already protects the detail endpoint.
 *
 * Returns 404 (not 403) on cross-org or wrong-owner so we don't leak
 * existence — same convention as getClaimByIdService.
 */
export async function listClaimTransitionsService(
  ctx: SalesClaimsActorCtx,
  id: string,
  options?: { requireSubmittedById?: string },
): Promise<SalesClaimsServiceResult<ClaimTransitionRow[]>> {
  if (!atLeast(ctx.actorRole, "editor") && !options?.requireSubmittedById) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  // Verify the claim exists in this org (and matches the optional owner)
  // BEFORE returning transitions. listSalesClaimTransitions filters by
  // org id, but a portal caller probing arbitrary UUIDs shouldn't get
  // back even an empty array — they should hit the same 404 the detail
  // route returns.
  const claim = await findClaimById(ctx.orgId, "manager", id);
  if (!claim) return { ok: false, status: 404, error: "Sales claim not found" };
  if (
    options?.requireSubmittedById &&
    claim.submittedById !== options.requireSubmittedById
  ) {
    return { ok: false, status: 404, error: "Sales claim not found" };
  }
  const data = await listSalesClaimTransitions(ctx.orgId, id);
  return { ok: true, status: 200, data };
}

export async function getClaimByIdService(
  ctx: SalesClaimsActorCtx,
  id: string,
  options?: { requireSubmittedById?: string; forceFullSelect?: boolean },
): Promise<SalesClaimsServiceResult<SalesClaimRow>> {
  if (!atLeast(ctx.actorRole, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const row = await findClaimById(ctx.orgId, ctx.actorRole, id, {
    forceFullSelect: options?.forceFullSelect,
  });
  if (!row) return { ok: false, status: 404, error: "Sales claim not found" };
  if (
    options?.requireSubmittedById &&
    row.submittedById !== options.requireSubmittedById
  ) {
    return { ok: false, status: 404, error: "Sales claim not found" };
  }
  return { ok: true, status: 200, data: row };
}

// ─── Claims (mutations) ──────────────────────────────────────────────────────

/**
 * Submit a new SalesClaim. Used by the portal (agent) flow with
 * `requireSalesUnitOwnerPartyId` for ownership; admin direct-submit isn't in
 * scope for W2c but the service is shape-compatible.
 *
 * Validates:
 *   1. SalesUnit exists & (when required) the agent owns it.
 *   2. computedAmount = serverComputed(commissionType, commissionValue,
 *      SalesUnit.purchasePrice) — clients DO NOT submit this directly.
 *   3. 100% split rule against the server-computed amount.
 */
export async function createClaimService(
  ctx: SalesClaimsActorCtx,
  input: CreateClaimInput,
  options: {
    requireSalesUnitOwnerPartyId?: string;
    auditAction?: string;
  } = {},
): Promise<SalesClaimsServiceResult<SalesClaimRow>> {
  // SalesUnit lookup + ownership.
  const sales = await findSalesUnitForClaim(ctx.orgId, input.salesUnitId);
  if (!sales) return { ok: false, status: 404, error: "Sales unit not found" };
  if (
    options.requireSalesUnitOwnerPartyId &&
    sales.agentPartyId !== options.requireSalesUnitOwnerPartyId
  ) {
    return { ok: false, status: 404, error: "Sales unit not found" };
  }

  // Server-side commission amount calculation.
  const computedAmount = computeSalesCommissionAmount(
    input.commissionType,
    input.commissionValue,
    sales.purchasePrice,
  );

  // 100% split rule against the computed amount.
  const v = validateSalesSplitsHundredPercent(input.splits, computedAmount);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  const row = await withTransaction(async (tx) => {
    const created = await createClaimRow(tx, {
      organizationId: ctx.orgId,
      salesUnitId: input.salesUnitId,
      commissionType: input.commissionType,
      commissionValue: input.commissionValue,
      computedAmount,
      paymentType: input.paymentType,
      notes: input.notes ?? null,
      submittedById: ctx.actorUserId,
      splits: input.splits.map((s) => ({
        partyPartyId: s.partyPartyId ?? null,
        partyDisplayName: s.partyDisplayName,
        roleLabel: s.roleLabel,
        splitType: s.splitType,
        splitValue: s.splitValue,
        sortOrder: s.sortOrder,
      })),
    });

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
      action: options.auditAction ?? "sales.claim.create",
      entityType: "SalesClaim",
      entityId: created.id,
      diff: { after: created } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return created;
  });

  return { ok: true, status: 201, data: row };
}

/**
 * PATCH a claim (portal: own-only).
 *
 * Edit-after-approval rebound: if the claim was already approved, flip to
 * `needs_amendment`, set reviewerNote, append a transition. Mirrors the
 * W2b renovation-claim rebound.
 *
 * If commission fields change → recompute computedAmount.
 * If splits OR commission fields change → re-validate 100%.
 */
export async function updateClaimService(
  ctx: SalesClaimsActorCtx,
  id: string,
  input: UpdateClaimInput,
  options: {
    requireSubmittedById?: string;
    rebindOnApproval?: boolean;
    auditAction?: string;
  } = {},
): Promise<SalesClaimsServiceResult<SalesClaimRow>> {
  const preCheck = await findClaimById(ctx.orgId, "manager", id);
  if (!preCheck) return { ok: false, status: 404, error: "Sales claim not found" };

  // Ownership check (portal path).
  if (
    options.requireSubmittedById &&
    preCheck.submittedById !== options.requireSubmittedById
  ) {
    return { ok: false, status: 404, error: "Sales claim not found" };
  }

  // RBAC: admin-side editing requires manager+; portal-side requires
  // requireSubmittedById to be set.
  if (!options.requireSubmittedById && !atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  // Determine effective commission fields after merge.
  const effectiveCommissionType: CommissionType =
    input.commissionType ?? preCheck.commissionType;
  const effectiveCommissionValue: number =
    input.commissionValue ?? preCheck.commissionValue ?? 0;

  // Commission fields may have changed — recompute computedAmount whenever
  // ANY of them changed. Need fresh SalesUnit.purchasePrice for that.
  let recomputedAmount: number | undefined;
  const commissionChanged =
    input.commissionType !== undefined || input.commissionValue !== undefined;
  if (commissionChanged) {
    const sales = await findSalesUnitForClaim(ctx.orgId, preCheck.salesUnitId);
    if (!sales) {
      // Defence: SalesUnit shouldn't disappear, but if it did we cannot
      // recompute the amount — bail out with 404 to fail safe.
      return { ok: false, status: 404, error: "Sales unit not found" };
    }
    recomputedAmount = computeSalesCommissionAmount(
      effectiveCommissionType,
      effectiveCommissionValue,
      sales.purchasePrice,
    );
  }

  // 100% rule re-validation. Triggered when splits OR commission fields change.
  // Compare against the (potentially recomputed) amount.
  if (input.splits !== undefined || commissionChanged) {
    const splitsToValidate = input.splits ?? preCheck.splits ?? [];
    if (splitsToValidate.length === 0) {
      return { ok: false, status: 400, error: "At least one split is required" };
    }
    const amountToValidate = recomputedAmount ?? preCheck.computedAmount ?? 0;
    const v = validateSalesSplitsHundredPercent(splitsToValidate, amountToValidate);
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
      commissionType: input.commissionType,
      commissionValue: input.commissionValue,
      computedAmount: recomputedAmount,
      paymentType: input.paymentType,
      notes: input.notes,
      splits: input.splits?.map((s) => ({
        partyPartyId: s.partyPartyId ?? null,
        partyDisplayName: s.partyDisplayName,
        roleLabel: s.roleLabel,
        splitType: s.splitType,
        splitValue: s.splitValue,
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
      action: options.auditAction ?? "sales.claim.update",
      entityType: "SalesClaim",
      entityId: id,
      diff: { before, after: updated } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  });

  if (!row) return { ok: false, status: 404, error: "Sales claim not found" };
  return { ok: true, status: 200, data: row };
}

// ─── Approve / reject / needs-amendment ──────────────────────────────────────

export async function approveClaimService(
  ctx: SalesClaimsActorCtx,
  id: string,
): Promise<SalesClaimsServiceResult<SalesClaimRow>> {
  if (!atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const preCheck = await findClaimById(ctx.orgId, "manager", id);
  if (!preCheck) return { ok: false, status: 404, error: "Sales claim not found" };

  if (TERMINAL_STATUSES.has(preCheck.status)) {
    return { ok: false, status: 409, error: `Claim is already ${preCheck.status}` };
  }

  // Re-validate splits at approve time. Mirrors W2b approve re-validation:
  // an agent could PATCH the claim after submit (or before reviewer picks
  // it up) and break the 100% rule; re-checking here closes that hole.
  if (!preCheck.splits || preCheck.splits.length === 0) {
    return { ok: false, status: 400, error: "Claim has no splits" };
  }
  const v = validateSalesSplitsHundredPercent(
    preCheck.splits,
    preCheck.computedAmount ?? 0,
  );
  if (!v.ok) return { ok: false, status: 400, error: v.error };

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
      action: "sales.claim.approve",
      entityType: "SalesClaim",
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
  if (!row) return { ok: false, status: 404, error: "Sales claim not found" };
  return { ok: true, status: 200, data: row };
}

/**
 * Cancel/withdraw a claim. Two callers:
 *
 *  - Portal (agent): can withdraw their OWN claim, but only while it's
 *    still `submitted`. Once a reviewer touches it (`needs_amendment` /
 *    `approved` / `rejected`) the agent is locked out — they have to
 *    re-engage with the reviewer. `requireSubmittedById` enforces this.
 *
 *  - Admin (manager+): can cancel any non-terminal claim in their org.
 *    Used for cleaning up duplicates / mis-submitted entries.
 *
 * "Cancelled" is a new terminal status. Schema-wise the column is a
 * String so no migration is needed — only the validation enum and the
 * terminal-statuses set are updated.
 */
export async function cancelClaimService(
  ctx: SalesClaimsActorCtx,
  id: string,
  options: {
    requireSubmittedById?: string;
    note?: string | null;
    auditAction?: string;
  } = {},
): Promise<SalesClaimsServiceResult<SalesClaimRow>> {
  const preCheck = await findClaimById(ctx.orgId, "manager", id);
  if (!preCheck) return { ok: false, status: 404, error: "Sales claim not found" };

  // Portal ownership gate.
  if (
    options.requireSubmittedById &&
    preCheck.submittedById !== options.requireSubmittedById
  ) {
    return { ok: false, status: 404, error: "Sales claim not found" };
  }

  // RBAC: admin path requires manager+; portal path requires the owner.
  if (!options.requireSubmittedById && !atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  // Portal can only withdraw while still in `submitted`. Admin can cancel
  // any non-terminal status. Both rules collapse into "not terminal" with
  // an extra constraint when called via the portal.
  if (TERMINAL_STATUSES.has(preCheck.status) || preCheck.status === "cancelled") {
    return { ok: false, status: 409, error: "Claim is already in a terminal state" };
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
      action: options.auditAction ?? "sales.claim.cancel",
      entityType: "SalesClaim",
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
  if (!row) return { ok: false, status: 404, error: "Sales claim not found" };
  return { ok: true, status: 200, data: row };
}

export async function rejectClaimService(
  ctx: SalesClaimsActorCtx,
  id: string,
  note: string,
): Promise<SalesClaimsServiceResult<SalesClaimRow>> {
  return reviewerActionInternal(ctx, id, note, "rejected", "sales.claim.reject");
}

export async function needsAmendmentClaimService(
  ctx: SalesClaimsActorCtx,
  id: string,
  note: string,
): Promise<SalesClaimsServiceResult<SalesClaimRow>> {
  return reviewerActionInternal(
    ctx,
    id,
    note,
    "needs_amendment",
    "sales.claim.needs_amendment",
  );
}

async function reviewerActionInternal(
  ctx: SalesClaimsActorCtx,
  id: string,
  note: string,
  toStatus: "rejected" | "needs_amendment",
  auditAction: string,
): Promise<SalesClaimsServiceResult<SalesClaimRow>> {
  if (!atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const preCheck = await findClaimById(ctx.orgId, "manager", id);
  if (!preCheck) return { ok: false, status: 404, error: "Sales claim not found" };

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
      entityType: "SalesClaim",
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
  if (!row) return { ok: false, status: 404, error: "Sales claim not found" };
  return { ok: true, status: 200, data: row };
}

// Re-export so portal & tests can reuse without bouncing through repository.
export { findSalesUnitForClaim };

// Avoid unused-type warning when SalesPaymentType isn't directly referenced.
export type { SalesPaymentType };
