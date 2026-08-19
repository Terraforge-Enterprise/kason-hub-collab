// apps/api/src/modules/owner-funding-requests/owner-funding-requests.service.ts
// Accounting-document redesign P7, reshaped (2026-07-23) — Owner Funding Request:
// a DELIBERATE admin-issued ask for the owner to fund KAEN (e.g. a big repair far
// exceeds the rent collected this month). NOT a status, NOT auto-derived, NOT a
// BillingDocument/invoice/debit_note/receivable — KAEN is not EARNING this money,
// it's asking the owner to send money IN. The already-carried-forward negative
// owner running balance stays silent + automatic: this service NEVER calls
// computeOwnerRunningBalance / derivePeriodRemittanceStatus, and NEVER writes to
// any payout-math primitive. amount/reason are admin-SUPPLIED (deliberate), never
// auto-computed — createOwnerFundingRequestService persists exactly what the actor
// passed in. computeAvailableOwnerPayableC is read ONLY by the list/GET side, as a
// read-only DISPLAY helper (task-mandated), never to derive or gate the amount.
import { getDb, type Prisma } from "@kason/db";
import type { OwnerFundingRequestInput } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { computeAvailableOwnerPayableC } from "../owner-remittance/owner-remittance.repository";

export type OwnerFundingRequestActorCtx = {
  orgId: string;
  actorUserId: string;
  actorRole: string;
  ip?: string;
  userAgent?: string;
};

export class OwnerFundingRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
    this.name = "OwnerFundingRequestError";
  }
}

export interface OwnerFundingRequestDto {
  id: string;
  organizationId: string;
  ownerPartyId: string;
  propertyId: string | null;
  amount: string;
  reason: string;
  status: string;
  requestedById: string;
  settledAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

type FundingRequestRow = Prisma.OwnerFundingRequestGetPayload<object>;

function toDto(row: FundingRequestRow): OwnerFundingRequestDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    ownerPartyId: row.ownerPartyId,
    propertyId: row.propertyId,
    amount: row.amount.toString(),
    reason: row.reason,
    status: row.status,
    requestedById: row.requestedById,
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Creates ONE OwnerFundingRequest row (status "requested", requestedById = the
 * calling actor) + an audit row, in the same transaction. `input.amount` and
 * `input.reason` are persisted VERBATIM — this function performs no balance
 * lookup, no payout computation, no status derivation. If a future caller wants
 * the owner's current balance as a default to pre-fill the admin's form, that is
 * the GET/list side's job (`listOwnerFundingRequestsService` below); create never
 * reads it.
 */
export async function createOwnerFundingRequestService(
  ctx: OwnerFundingRequestActorCtx,
  input: OwnerFundingRequestInput,
): Promise<OwnerFundingRequestDto> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const created = await tx.ownerFundingRequest.create({
      data: {
        organizationId: ctx.orgId,
        ownerPartyId: input.ownerPartyId,
        propertyId: input.propertyId ?? null,
        amount: input.amount,
        reason: input.reason,
        status: "requested",
        requestedById: ctx.actorUserId,
      },
    });

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "owner_funding_requests.create",
      entityType: "OwnerFundingRequest",
      entityId: created.id,
      meta: {
        ownerPartyId: input.ownerPartyId,
        propertyId: input.propertyId ?? null,
        amount: input.amount,
        reason: input.reason,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return toDto(created);
  });
}

export interface OwnerFundingRequestListResult {
  requests: OwnerFundingRequestDto[];
  /**
   * The owner's CURRENT signed available-payable balance, in cents — the exact
   * same reversal-aware primitive owner-remittance uses (negative = owner has
   * been over-deducted/owes; positive = KAEN owes the owner). Included purely as
   * a DISPLAY helper so an admin deciding whether to raise a funding request can
   * see the number; it is never written, never derived from the requests below,
   * and this read never changes computeOwnerRunningBalance / payout math.
   */
  currentBalanceC: number;
}

/**
 * Lists an owner's funding requests (org-scoped), newest first, alongside a
 * read-only snapshot of their current signed balance. Both reads run inside one
 * transaction for a consistent snapshot — no advisory lock (this is a display
 * read, not a guard ahead of a write, so GC3's lock-then-read contract doesn't
 * apply here).
 */
export async function listOwnerFundingRequestsService(
  ctx: OwnerFundingRequestActorCtx,
  ownerPartyId: string,
): Promise<OwnerFundingRequestListResult> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const rows = await tx.ownerFundingRequest.findMany({
      where: { organizationId: ctx.orgId, ownerPartyId },
      orderBy: { createdAt: "desc" },
    });
    const currentBalanceC = await computeAvailableOwnerPayableC(tx, ctx.orgId, ownerPartyId);
    return { requests: rows.map(toDto), currentBalanceC };
  });
}
