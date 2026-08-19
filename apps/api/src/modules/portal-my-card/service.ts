// Portal-side service for the agent's own e-namecard (per spec §6.2, §8).
//
// Four functions, one per portal endpoint:
//   - getMyCard       — read shape: { active, pending, history }
//   - submitMyCard    — agent submits a new card draft for manager review
//   - reconfirmMyCard — agent extends expiry on their currently-approved card
//   - withdrawMyCard  — agent rescinds their own pending submission
//
// Invariants enforced at the service layer (the DB also enforces some of
// these; pre-checks exist for friendly UX, not correctness):
//   - At most ONE pending row per party at any time (raw-SQL partial unique
//     index `agent_card_one_pending_per_party`; see spec §5).
//   - `OrganizationCardSettings.isConfigured = true` is required to submit
//     (spec §6.2). The DB constraint cannot enforce this; the service must.
//   - Reconfirm cap: 4. Once reconfirmCount = 4 the only escape is a fresh
//     submit → manager re-approval, which resets the counter (spec §6.1).
//   - Reconfirm rate-limit: 1 per agent per 24h, derived from AuditLog rows
//     of action `card.reconfirm` for the active version.
//   - Reconfirm window: only when `expiresAt` is within 30 days from NOW.
//
// Every state-changing function runs in a Prisma `$transaction` and writes
// an AuditLog row in the SAME tx so the audit trail is atomic with the
// state change. AuditLog meta JSON carries context for forensic queries
// (spec §9.9).
//
// All reads/writes are scoped to the caller's party (`partyId`) to prevent
// cross-org access. The portal middleware has already validated the
// session, so `partyId` is trusted by the time it reaches this module.

import type { Prisma } from "@prisma/client";
import { getDb } from "@kason/db";
import {
  notifyAgentReconfirmCapReached,
  notifyManagersOfPendingCard,
} from "../agent-cards/notifications";

// ── Errors ──────────────────────────────────────────────────────────────────
//
// Each one carries a `status` (HTTP) and `code` so the route layer can map
// directly to a response without an `instanceof` cascade per call site —
// the routes still match on the class for clarity.

export class MyCardNotFoundError extends Error {
  status = 404 as const;
  code = "my_card_not_found" as const;
  constructor(message?: string) {
    super(message ?? "Card not found");
    this.name = "MyCardNotFoundError";
  }
}

export class MyCardPendingExistsError extends Error {
  status = 409 as const;
  code = "pending_exists" as const;
  constructor(message?: string) {
    super(message ?? "A pending submission already exists for this agent");
    this.name = "MyCardPendingExistsError";
  }
}

export class OrgCardSettingsNotConfiguredError extends Error {
  status = 409 as const;
  code = "org_card_settings_not_configured" as const;
  constructor(message?: string) {
    super(
      message ??
        "Organization card settings are not configured. Ask your admin to configure card branding first.",
    );
    this.name = "OrgCardSettingsNotConfiguredError";
  }
}

export class ReconfirmNotInWindowError extends Error {
  status = 409 as const;
  code = "not_in_window" as const;
  constructor(message?: string) {
    super(message ?? "Re-confirm only available within 30 days of expiry");
    this.name = "ReconfirmNotInWindowError";
  }
}

export class ReconfirmCapReachedError extends Error {
  status = 409 as const;
  code = "cap_reached" as const;
  constructor(message?: string) {
    super(
      message ??
        "Re-confirm cap reached (4). Submit a fresh card for manager re-approval to continue.",
    );
    this.name = "ReconfirmCapReachedError";
  }
}

export class ReconfirmRateLimitedError extends Error {
  status = 429 as const;
  code = "rate_limited" as const;
  constructor(message?: string) {
    super(message ?? "Re-confirm allowed at most once every 24 hours");
    this.name = "ReconfirmRateLimitedError";
  }
}

// ── Shared types ────────────────────────────────────────────────────────────

/** Slim shape returned to the portal client. PUBLIC TOKEN is included only
 *  on `active` (the agent NEEDS it to share their public link); pending +
 *  history rows have it stripped. */
export interface MyCardVersionDto {
  id: string;
  displayName: string;
  title: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  status: string;
  submittedByType: string;
  rejectionReason: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  reconfirmCount: number;
  createdAt: string;
  /** Only present on the `active` row. Always null on pending/history. */
  publicToken: string | null;
}

export interface GetMyCardResult {
  active: MyCardVersionDto | null;
  pending: MyCardVersionDto | null;
  history: MyCardVersionDto[];
}

export interface MutationActor {
  /** Caller's User.id — recorded on AuditLog.actorUserId. */
  actorUserId: string;
  /** Caller's role string — recorded on AuditLog.actorRole. The portal
   *  session does not carry an admin role; we record the userType ("agent")
   *  for traceability. */
  actorRole: string;
  /** Caller's organization id — required by the AuditLog row. */
  organizationId: string;
}

const HISTORY_CAP = 20;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Maps a Prisma row to the wire DTO. Pass `includeToken=true` only for the
 *  `active` row — the spec strips publicToken from pending + history per
 *  §6.2. */
function toDto(
  row: {
    id: string;
    displayName: string;
    title: string;
    primaryEmail: string | null;
    primaryPhone: string | null;
    status: string;
    submittedByType: string;
    rejectionReason: string | null;
    approvedAt: Date | null;
    expiresAt: Date | null;
    reconfirmCount: number;
    createdAt: Date;
    publicToken: string | null;
  },
  includeToken: boolean,
): MyCardVersionDto {
  return {
    id: row.id,
    displayName: row.displayName,
    title: row.title,
    primaryEmail: row.primaryEmail,
    primaryPhone: row.primaryPhone,
    status: row.status,
    submittedByType: row.submittedByType,
    rejectionReason: row.rejectionReason,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    reconfirmCount: row.reconfirmCount,
    createdAt: row.createdAt.toISOString(),
    publicToken: includeToken ? row.publicToken : null,
  };
}

// ── getMyCard ───────────────────────────────────────────────────────────────

/**
 * Returns { active, pending, history } for the agent.
 *
 * - `active`: the row whose id matches `Party.activeCardVersionId`. Includes
 *   `publicToken` (the agent needs it to share their public link).
 * - `pending`: the (at-most-one) row with `status='pending'`. PublicToken
 *   stripped — pending rows do not have one anyway.
 * - `history`: ALL rows for the party, newest first, capped at 20. Includes
 *   the active + pending rows so the client can render a unified timeline.
 *   PublicToken stripped from every history entry.
 *
 * No transaction needed — pure read.
 */
export async function getMyCard(partyId: string): Promise<GetMyCardResult> {
  const db = getDb();

  // Need the Party row to know which version is the "active" one. If the
  // party doesn't exist, return all-nulls — callers shouldn't reach here
  // (portal session guarantees the party exists) but defensive.
  const party = await db.party.findUnique({
    where: { id: partyId },
    select: { id: true, activeCardVersionId: true },
  });
  if (!party) {
    return { active: null, pending: null, history: [] };
  }

  // Single SELECT for all versions, newest first; partition in memory. The
  // alternative (three queries) would round-trip thrice for what's at most
  // ~20 small rows per party.
  const rows = await db.agentCardVersion.findMany({
    where: { partyId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_CAP,
    select: {
      id: true,
      displayName: true,
      title: true,
      primaryEmail: true,
      primaryPhone: true,
      status: true,
      submittedByType: true,
      rejectionReason: true,
      approvedAt: true,
      expiresAt: true,
      reconfirmCount: true,
      createdAt: true,
      publicToken: true,
    },
  });

  // Pending = the (at-most-one) row with status='pending'. The DB partial
  // unique index guarantees at most one; use `find` and not `filter` to
  // make that contract explicit.
  const pendingRow = rows.find((r) => r.status === "pending") ?? null;

  // Active = the row whose id equals Party.activeCardVersionId AND is
  // approved. (Belt-and-braces: the activeCardVersionId pointer should
  // only ever reference an approved row, but check status too.)
  const activeRow =
    party.activeCardVersionId
      ? rows.find((r) => r.id === party.activeCardVersionId && r.status === "approved") ?? null
      : null;

  return {
    active: activeRow ? toDto(activeRow, /* includeToken */ true) : null,
    pending: pendingRow ? toDto(pendingRow, /* includeToken */ false) : null,
    history: rows.map((r) => toDto(r, /* includeToken */ false)),
  };
}

// ── submitMyCard ────────────────────────────────────────────────────────────

export interface SubmitMyCardInput {
  displayName: string;
  title: string;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
}

export interface SubmitMyCardResult {
  versionId: string;
}

/**
 * Agent submits a new card draft. Creates an AgentCardVersion row in
 * `pending` status. NO publicToken, NO approvedAt, NO expiresAt — those
 * land on approval. reconfirmCount=0 (set on approval, not on submission).
 *
 * Pre-checks (defensive — DB also enforces #1):
 *   1. No existing `pending` row for this party (DB partial unique index
 *      catches this; we pre-check to return a clean 409 instead of a
 *      P2002 trace). Falls through to the catch block on race condition.
 *   2. `OrganizationCardSettings.isConfigured = true`.
 *
 * Writes (in $transaction):
 *   - INSERT AgentCardVersion (status=pending, submittedById=actorUserId,
 *     submittedByType='agent').
 *   - INSERT AuditLog (action='card.submit', meta={ submittedByType:
 *     'agent' }).
 */
export async function submitMyCard(
  partyId: string,
  input: SubmitMyCardInput,
  opts: MutationActor,
): Promise<SubmitMyCardResult> {
  const db = getDb();

  let result: SubmitMyCardResult;
  try {
    result = await db.$transaction(async (tx) => {
      // Org-settings gate. The DB cannot enforce this — service must.
      const settings = await tx.organizationCardSettings.findUnique({
        where: { organizationId: opts.organizationId },
      });
      if (!settings || !settings.isConfigured) {
        throw new OrgCardSettingsNotConfiguredError();
      }

      // Pre-check: pending exists. The partial unique index is the source
      // of truth (catches concurrent submits via P2002 below), but doing
      // the read here lets us return a friendly 409 instead of relying on
      // the catch block alone.
      const existingPending = await tx.agentCardVersion.findFirst({
        where: { partyId, status: "pending" },
        select: { id: true },
      });
      if (existingPending) {
        throw new MyCardPendingExistsError();
      }

      const created = await tx.agentCardVersion.create({
        data: {
          organizationId: opts.organizationId,
          partyId,
          displayName: input.displayName,
          title: input.title,
          primaryEmail: input.primaryEmail ?? null,
          primaryPhone: input.primaryPhone ?? null,
          status: "pending",
          submittedById: opts.actorUserId,
          submittedByType: "agent",
          // No publicToken / approvedAt / expiresAt — those land on approval.
          reconfirmCount: 0,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: opts.organizationId,
          actorUserId: opts.actorUserId,
          actorRole: opts.actorRole,
          entityType: "AgentCardVersion",
          entityId: created.id,
          action: "card.submit",
          meta: { submittedByType: "agent" } as Prisma.InputJsonValue,
        },
      });

      return { versionId: created.id };
    });
  } catch (err) {
    // Translate Prisma's P2002 (unique constraint violation) on the
    // partial unique index → friendly 409. This protects against the
    // race window between the pre-check and the INSERT.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === "P2002"
    ) {
      throw new MyCardPendingExistsError();
    }
    throw err;
  }

  // Phase 7: notify all managers/admins in the org (spec §11 row 1 —
  // in-app only). Fire-and-forget AFTER the tx commits so a notification
  // failure cannot leak into the user-facing 201. Reconfirm is
  // DELIBERATELY silent (per spec — the agent took the action themselves).
  void notifyManagersOfPendingCard({
    organizationId: opts.organizationId,
    versionId: result.versionId,
    agentName: input.displayName,
    newTitle: input.title,
  });

  return result;
}

// ── reconfirmMyCard ─────────────────────────────────────────────────────────

export interface ReconfirmMyCardResult {
  versionId: string;
  newExpiresAt: string;
}

/**
 * Agent re-confirms their currently-approved card to extend its expiry by
 * `cardExpiryMonths` (org-configurable, default 3).
 *
 * Validations (any failure throws; route maps to 4xx):
 *   - Active version exists (404 if not).
 *   - `expiresAt` is within 30 days from NOW (else 409 not_in_window).
 *   - `reconfirmCount < 4` (else 409 cap_reached).
 *   - Last `card.reconfirm` AuditLog for this version is > 24h ago (else
 *     429 rate_limited).
 *
 * Writes (in $transaction):
 *   - UPDATE active version: expiresAt = OLD expiresAt + cardExpiryMonths,
 *     reconfirmCount = OLD + 1. (Bump from CURRENT expiresAt — this
 *     preserves accumulated extensions; bumping from NOW would silently
 *     shorten the card if the agent reconfirmed early.)
 *   - INSERT AuditLog (action='card.reconfirm', meta={ previousExpiresAt,
 *     newExpiresAt, reconfirmCount }).
 */
export async function reconfirmMyCard(
  partyId: string,
  opts: MutationActor,
): Promise<ReconfirmMyCardResult> {
  const db = getDb();

  const result = await db.$transaction(async (tx) => {
    // Look up the party + its active card version pointer.
    const party = await tx.party.findUnique({
      where: { id: partyId },
      select: { id: true, activeCardVersionId: true },
    });
    if (!party || !party.activeCardVersionId) {
      throw new MyCardNotFoundError("No active card to re-confirm");
    }

    const active = await tx.agentCardVersion.findUnique({
      where: { id: party.activeCardVersionId },
    });
    if (!active) {
      throw new MyCardNotFoundError("No active card to re-confirm");
    }

    // expiresAt window check. The cron-reminder system targets cards
    // expiring within 30 days; the reconfirm action lives in that same
    // window. Cards with no expiresAt cannot be reconfirmed — but per
    // spec §16, an approved row with null expiresAt is an invariant
    // violation, so 404 here is acceptable.
    if (!active.expiresAt) {
      throw new MyCardNotFoundError("Active card has no expiry — cannot re-confirm");
    }
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (active.expiresAt > thirtyDaysFromNow) {
      throw new ReconfirmNotInWindowError();
    }

    // Cap check.
    if (active.reconfirmCount >= 4) {
      throw new ReconfirmCapReachedError();
    }

    // Rate-limit check: last `card.reconfirm` AuditLog for this version >
    // 24h ago. Querying AuditLog (instead of a denormalised
    // lastReconfirmAt column) keeps the schema flat at the cost of one
    // extra read per reconfirm — acceptable given reconfirms are rare.
    const lastReconfirm = await tx.auditLog.findFirst({
      where: {
        entityType: "AgentCardVersion",
        entityId: active.id,
        action: "card.reconfirm",
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (lastReconfirm) {
      const diffMs = now.getTime() - lastReconfirm.createdAt.getTime();
      if (diffMs < 24 * 60 * 60 * 1000) {
        throw new ReconfirmRateLimitedError();
      }
    }

    // Org settings — needed for cardExpiryMonths. If missing/incomplete
    // the agent should not be hitting this endpoint at all (no live
    // card), but bail out cleanly if it happens.
    const settings = await tx.organizationCardSettings.findUnique({
      where: { organizationId: opts.organizationId },
    });
    if (!settings) {
      throw new OrgCardSettingsNotConfiguredError();
    }

    // Bump from CURRENT expiresAt, not from NOW. Date#setMonth handles
    // calendar-month edge cases (Jan 31 + 1 mo → Feb 28/29).
    const previousExpiresAt = active.expiresAt;
    const newExpiresAt = new Date(previousExpiresAt);
    newExpiresAt.setMonth(newExpiresAt.getMonth() + settings.cardExpiryMonths);
    const newReconfirmCount = active.reconfirmCount + 1;

    await tx.agentCardVersion.update({
      where: { id: active.id },
      data: { expiresAt: newExpiresAt, reconfirmCount: newReconfirmCount },
    });

    await tx.auditLog.create({
      data: {
        organizationId: opts.organizationId,
        actorUserId: opts.actorUserId,
        actorRole: opts.actorRole,
        entityType: "AgentCardVersion",
        entityId: active.id,
        action: "card.reconfirm",
        meta: {
          previousExpiresAt: previousExpiresAt.toISOString(),
          newExpiresAt: newExpiresAt.toISOString(),
          reconfirmCount: newReconfirmCount,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      versionId: active.id,
      newExpiresAt: newExpiresAt.toISOString(),
      reachedCap: newReconfirmCount === 4,
    };
  });

  // Phase 7: notify the agent when the cap is hit (spec §11 row 5 — in-app
  // + WhatsApp). Fires AFTER the tx commits. Reconfirm itself is silent
  // (no notification on each reconfirm); only the cap-reached event
  // triggers a message.
  if (result.reachedCap) {
    void notifyAgentReconfirmCapReached({
      organizationId: opts.organizationId,
      agentPartyId: partyId,
    });
  }

  return { versionId: result.versionId, newExpiresAt: result.newExpiresAt };
}

// ── withdrawMyCard ──────────────────────────────────────────────────────────

export interface WithdrawMyCardResult {
  versionId: string;
}

/**
 * Agent withdraws their own pending submission. Sets the row to
 * `status='rejected'` with `rejectionReason='Withdrawn by agent'` so the
 * row remains in history (immutable audit trail per spec §5.1) but no
 * longer occupies the "pending" slot — the next submit can proceed.
 *
 * Writes (in $transaction):
 *   - UPDATE pending version: status='rejected', reviewedById=actorUserId,
 *     reviewedAt=NOW, rejectionReason='Withdrawn by agent'.
 *   - INSERT AuditLog (action='card.withdraw' — distinct from
 *     'card.reject' so dashboards can distinguish manager rejections from
 *     self-withdrawals).
 */
export async function withdrawMyCard(
  partyId: string,
  opts: MutationActor,
): Promise<WithdrawMyCardResult> {
  const db = getDb();

  return db.$transaction(async (tx) => {
    const pending = await tx.agentCardVersion.findFirst({
      where: { partyId, status: "pending" },
    });
    if (!pending) {
      throw new MyCardNotFoundError("No pending submission to withdraw");
    }

    const now = new Date();
    await tx.agentCardVersion.update({
      where: { id: pending.id },
      data: {
        status: "rejected",
        reviewedById: opts.actorUserId,
        reviewedAt: now,
        rejectionReason: "Withdrawn by agent",
      },
    });

    await tx.auditLog.create({
      data: {
        organizationId: opts.organizationId,
        actorUserId: opts.actorUserId,
        actorRole: opts.actorRole,
        entityType: "AgentCardVersion",
        entityId: pending.id,
        action: "card.withdraw",
        meta: { withdrawnBy: "agent" } as Prisma.InputJsonValue,
      },
    });

    return { versionId: pending.id };
  });
}
