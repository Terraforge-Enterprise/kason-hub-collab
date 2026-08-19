// Agent E-Namecard service core (per spec §6.1, §8 state machine).
//
// Phase 3 surface: ONE write entry point — `createApprovedFromAdmin`.
//
// Used by:
//   - Agent-creation flow (parties.service): when a `title` is provided at
//     create time, the new Party is paired with an approved card version
//     in the SAME transaction.
//   - (Phase 4) admin "create card" action.
//
// The service is split into a public wrapper that opens its own
// `$transaction` and a TX-aware variant (`createApprovedFromAdminTx`) that
// callers already inside a transaction can use to keep the write atomic
// with the surrounding work. parties.service consumes the TX variant so
// the new Party + card row are part of the same atomic unit.
//
// The reverse coupling — agent-cards importing parties — is forbidden.
// agent-cards is a leaf module here.

import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getDb } from "@kason/db";
import {
  notifyAgentCardApproved,
  notifyAgentCardRejected,
} from "./notifications";

export interface CreateApprovedFromAdminOptions {
  organizationId: string;
  partyId: string;
  displayName: string;
  title: string;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
  /** User.id of the admin doing the data entry. Used as both `submittedById`
   *  and `reviewedById` because the admin path skips review. Also recorded
   *  on the AuditLog row as `actorUserId`. */
  submittedById: string;
  /** Optional admin role ("admin" | "manager" | "editor") for the AuditLog
   *  `actorRole` column. Defaults to "admin" when called in a non-route
   *  context (e.g. seed scripts). The AuditLog model REQUIRES actorRole. */
  actorRole?: string;
}

export interface CreateApprovedResult {
  versionId: string;
  publicToken: string;
  expiresAt: Date;
}

/**
 * Thrown when the org has not yet completed `OrganizationCardSettings`
 * configuration. The route layer maps this to HTTP 409.
 */
export class OrgCardSettingsNotConfiguredError extends Error {
  status = 409 as const;
  code = "org_card_settings_not_configured" as const;

  constructor(message?: string) {
    super(
      message ??
        "Organization card settings are not configured. Configure /organization/agents/card-settings first.",
    );
    this.name = "OrgCardSettingsNotConfiguredError";
  }
}

/**
 * TX-aware variant. Use this when you're already inside a Prisma
 * `$transaction(async (tx) => { ... })` block (e.g. parties.createAgent).
 *
 * Invariants & side effects (all on the supplied `tx` client):
 *   1. Validates `OrganizationCardSettings.isConfigured = true` (else
 *      throws `OrgCardSettingsNotConfiguredError`).
 *   2. INSERT AgentCardVersion (`status='approved'`,
 *      `submittedByType='admin'`, `reviewedById=submitterId`,
 *      `approvedAt=NOW`, `expiresAt=NOW + cardExpiryMonths`,
 *      `reconfirmCount=0`, `publicToken =
 *      crypto.randomBytes(16).toString('base64url')` → 22 chars).
 *   3. UPDATE Party.activeCardVersionId.
 *   4. INSERT AuditLog row (`action='card.approve'`, `entityType='AgentCardVersion'`,
 *      `meta={ submittedByType: 'admin', initialCreate: true }`).
 */
export async function createApprovedFromAdminTx(
  tx: Prisma.TransactionClient,
  opts: CreateApprovedFromAdminOptions,
): Promise<CreateApprovedResult> {
  const settings = await tx.organizationCardSettings.findUnique({
    where: { organizationId: opts.organizationId },
  });
  if (!settings || !settings.isConfigured) {
    throw new OrgCardSettingsNotConfiguredError();
  }

  // Calendar-month arithmetic: Date#setMonth handles month-end correctly
  // (e.g. Jan 31 + 1 month → Feb 28/29). Span in ms therefore varies, so
  // tests assert a 5.9–6.1-month band around the expected value.
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + settings.cardExpiryMonths);

  // 16 bytes → 22-char URL-safe base64 (no padding). Same shape the public
  // sub-app's regex enforces (`/^[A-Za-z0-9_-]{22}$/`), so newly minted
  // tokens are guaranteed to round-trip through the public surface.
  const publicToken = crypto.randomBytes(16).toString("base64url");

  const now = new Date();

  const version = await tx.agentCardVersion.create({
    data: {
      organizationId: opts.organizationId,
      partyId: opts.partyId,
      displayName: opts.displayName,
      title: opts.title,
      primaryEmail: opts.primaryEmail ?? null,
      primaryPhone: opts.primaryPhone ?? null,
      status: "approved",
      submittedById: opts.submittedById,
      submittedByType: "admin",
      reviewedById: opts.submittedById,
      reviewedAt: now,
      approvedAt: now,
      publicToken,
      expiresAt,
      reconfirmCount: 0,
    },
  });

  await tx.party.update({
    where: { id: opts.partyId },
    data: { activeCardVersionId: version.id },
  });

  await tx.auditLog.create({
    data: {
      organizationId: opts.organizationId,
      actorUserId: opts.submittedById,
      // actorRole is REQUIRED on the AuditLog model (no `?` in the schema).
      // Default to "admin" — the path is admin-initiated by definition;
      // callers may override (e.g. a manager creating on behalf of).
      actorRole: opts.actorRole ?? "admin",
      entityType: "AgentCardVersion",
      entityId: version.id,
      action: "card.approve",
      meta: { submittedByType: "admin", initialCreate: true } as Prisma.InputJsonValue,
    },
  });

  return { versionId: version.id, publicToken, expiresAt };
}

/**
 * Public wrapper — opens its own `$transaction`. Use this from route
 * handlers or other top-level callers.
 */
export async function createApprovedFromAdmin(
  opts: CreateApprovedFromAdminOptions,
): Promise<CreateApprovedResult> {
  const db = getDb();
  return db.$transaction((tx) => createApprovedFromAdminTx(tx, opts));
}

// ── Mutation errors (Phase 4) ───────────────────────────────────────────
//
// Two distinct failure modes the route layer must distinguish:
//  - NotFound → HTTP 404 (also covers cross-org reads, by design — same
//    response shape so a caller cannot enumerate other orgs by timing).
//  - Conflict → HTTP 409 (state-machine violation: e.g. trying to
//    approve/reject a row that's no longer pending, or trying to
//    regenerate/revoke when there's no active version).

export class AgentCardNotFoundError extends Error {
  status = 404 as const;
  code = "agent_card_not_found" as const;
  constructor(message?: string) {
    super(message ?? "Agent card not found");
    this.name = "AgentCardNotFoundError";
  }
}

export class AgentCardConflictError extends Error {
  status = 409 as const;
  code = "agent_card_conflict" as const;
  constructor(message: string) {
    super(message);
    this.name = "AgentCardConflictError";
  }
}

// ── Phase 4 mutations: approve / reject / regenerate-token / revoke ─────
//
// Token rotation policy (per spec §8):
//   - On approval, if the previous version's `submittedByType === 'agent'`,
//     ROTATE the publicToken (generates a new one, NULLs the old row's
//     token). This invalidates any leaked URL from the prior agent-self-
//     submitted version.
//   - If `submittedByType === 'admin'`, KEEP the existing publicToken so
//     printed cards / saved URLs continue to resolve.
//   - Admin can always force-rotate via the dedicated `regenerateToken`
//     endpoint, regardless of submission origin.
//
// All mutations write an AuditLog row inside the same transaction. The
// `meta` JSON column carries context (rotated/reason/previousTokenHash)
// for forensic queries — see spec §9.9.

export interface MutationActor {
  actorUserId: string;
  actorRole: string;
  organizationId: string;
}

export interface ApproveResult {
  versionId: string;
}

export interface RejectResult {
  versionId: string;
}

export interface RegenerateResult {
  versionId: string;
  publicToken: string;
}

export interface RevokeResult {
  versionId: string;
}

/** Short, non-reversible fingerprint of a token, suitable for AuditLog
 *  meta. We deliberately store ONLY the first 16 hex chars of the SHA-256
 *  digest so the audit log cannot itself be used as a token-recovery
 *  oracle even if the table leaks. */
function tokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Approve a pending card version.
 *
 * Flow:
 *   1. Loads the version (must be pending, must belong to caller's org).
 *   2. Loads OrganizationCardSettings for `cardExpiryMonths`.
 *   3. Picks publicToken: rotate if agent-submitted, preserve if admin-submitted.
 *   4. UPDATEs version: status='approved', reviewedBy*, approvedAt, expiresAt,
 *      publicToken, reconfirmCount=0.
 *   5. NULLs publicToken on the previous active version (if any) — guarantees
 *      uniqueness of `publicToken` is preserved when we rotate.
 *   6. UPDATEs Party.activeCardVersionId to the new version's id.
 *   7. Writes AuditLog row.
 *
 * Throws:
 *   - AgentCardNotFoundError if the version doesn't exist or is cross-org.
 *   - AgentCardConflictError if the version is no longer pending.
 *   - OrgCardSettingsNotConfiguredError if settings missing/incomplete.
 */
export async function approveVersion(
  versionId: string,
  opts: MutationActor,
): Promise<ApproveResult> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const version = await tx.agentCardVersion.findFirst({
      where: { id: versionId, organizationId: opts.organizationId },
    });
    if (!version) throw new AgentCardNotFoundError();
    if (version.status !== "pending") {
      throw new AgentCardConflictError(
        `Version is not pending (current status: ${version.status})`,
      );
    }

    const settings = await tx.organizationCardSettings.findUnique({
      where: { organizationId: opts.organizationId },
    });
    if (!settings || !settings.isConfigured) {
      throw new OrgCardSettingsNotConfiguredError();
    }

    // Find the prior active version on the same Party (if any). We need
    // its publicToken so we can either reuse it (admin-submitted preserve
    // path) or NULL it out (agent-submitted rotate path) to keep the
    // partial unique index on publicToken consistent.
    const party = await tx.party.findFirst({
      where: { id: version.partyId, organizationId: opts.organizationId },
      select: { id: true, activeCardVersionId: true },
    });
    if (!party) throw new AgentCardNotFoundError();

    let priorActive: { id: string; publicToken: string | null } | null = null;
    if (party.activeCardVersionId) {
      priorActive = await tx.agentCardVersion.findUnique({
        where: { id: party.activeCardVersionId },
        select: { id: true, publicToken: true },
      });
    }

    const rotated = version.submittedByType === "agent";
    const publicToken =
      rotated || !priorActive?.publicToken
        ? crypto.randomBytes(16).toString("base64url")
        : priorActive.publicToken;

    // If the prior row still holds a token, NULL it first to free the
    // unique constraint before we (re)assign the value below. Admin
    // preserve path then writes the same string back on the new row.
    if (priorActive && priorActive.publicToken && priorActive.id !== version.id) {
      await tx.agentCardVersion.update({
        where: { id: priorActive.id },
        data: { publicToken: null },
      });
    }

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + settings.cardExpiryMonths);
    const now = new Date();

    const updated = await tx.agentCardVersion.update({
      where: { id: version.id },
      data: {
        status: "approved",
        reviewedById: opts.actorUserId,
        reviewedAt: now,
        approvedAt: now,
        publicToken,
        expiresAt,
        reconfirmCount: 0,
      },
    });

    await tx.party.update({
      where: { id: version.partyId },
      data: { activeCardVersionId: updated.id },
    });

    await tx.auditLog.create({
      data: {
        organizationId: opts.organizationId,
        actorUserId: opts.actorUserId,
        actorRole: opts.actorRole,
        entityType: "AgentCardVersion",
        entityId: updated.id,
        action: "card.approve",
        meta: {
          submittedByType: version.submittedByType,
          rotated,
        } as Prisma.InputJsonValue,
      },
    });

    // Phase 7: notify the agent of approval (spec §11 row 2).
    // Fire-and-forget AFTER the transaction commits — runs in the
    // microtask queue without blocking the response. Errors are
    // swallowed inside the helper so a notification failure cannot
    // surface as a 500 on the approval call.
    void notifyAgentCardApproved({
      organizationId: opts.organizationId,
      agentPartyId: version.partyId,
      publicToken,
    });

    return { versionId: updated.id };
  });
}

/**
 * Reject a pending card version. Records the reason on the row and in the
 * AuditLog meta. Does NOT touch publicToken or Party.activeCardVersionId
 * — the previously active version (if any) remains live.
 */
export async function rejectVersion(
  versionId: string,
  opts: MutationActor & { reason: string },
): Promise<RejectResult> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const version = await tx.agentCardVersion.findFirst({
      where: { id: versionId, organizationId: opts.organizationId },
    });
    if (!version) throw new AgentCardNotFoundError();
    if (version.status !== "pending") {
      throw new AgentCardConflictError(
        `Version is not pending (current status: ${version.status})`,
      );
    }

    const updated = await tx.agentCardVersion.update({
      where: { id: version.id },
      data: {
        status: "rejected",
        reviewedById: opts.actorUserId,
        reviewedAt: new Date(),
        rejectionReason: opts.reason,
      },
    });

    await tx.auditLog.create({
      data: {
        organizationId: opts.organizationId,
        actorUserId: opts.actorUserId,
        actorRole: opts.actorRole,
        entityType: "AgentCardVersion",
        entityId: updated.id,
        action: "card.reject",
        meta: { reason: opts.reason } as Prisma.InputJsonValue,
      },
    });

    // Phase 7: notify the agent of rejection (spec §11 row 3).
    void notifyAgentCardRejected({
      organizationId: opts.organizationId,
      agentPartyId: version.partyId,
      reason: opts.reason,
    });

    return { versionId: updated.id };
  });
}

/**
 * Force-rotate the publicToken on the currently-active card version for a
 * party. Useful when a token leaks. Records a forensic fingerprint of the
 * PRIOR token in the audit log so investigators can correlate against
 * access logs without exposing the token itself.
 *
 * Throws AgentCardNotFoundError when the party has no active version
 * (cannot rotate what doesn't exist) or when the party is cross-org.
 */
export async function regenerateToken(
  partyId: string,
  opts: MutationActor,
): Promise<RegenerateResult> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const party = await tx.party.findFirst({
      where: { id: partyId, organizationId: opts.organizationId },
      select: { id: true, activeCardVersionId: true },
    });
    if (!party || !party.activeCardVersionId) throw new AgentCardNotFoundError();

    const active = await tx.agentCardVersion.findFirst({
      where: { id: party.activeCardVersionId, organizationId: opts.organizationId },
    });
    if (!active) throw new AgentCardNotFoundError();

    const priorTokenHash = active.publicToken ? tokenFingerprint(active.publicToken) : null;
    const newToken = crypto.randomBytes(16).toString("base64url");

    const updated = await tx.agentCardVersion.update({
      where: { id: active.id },
      data: { publicToken: newToken },
    });

    await tx.auditLog.create({
      data: {
        organizationId: opts.organizationId,
        actorUserId: opts.actorUserId,
        actorRole: opts.actorRole,
        entityType: "AgentCardVersion",
        entityId: updated.id,
        action: "card.token.rotate",
        meta: { previousTokenHash: priorTokenHash } as Prisma.InputJsonValue,
      },
    });

    return { versionId: updated.id, publicToken: newToken };
  });
}

/**
 * Revoke the active card by NULLing its publicToken. The version row is
 * preserved (we keep audit history) and `Party.activeCardVersionId` is
 * NOT cleared — the row still exists, it just has no live token, so
 * public-card lookups by token will 404. Re-issuing a card (creating a
 * new version) is a separate flow.
 */
export async function revokeActiveCard(
  partyId: string,
  opts: MutationActor,
): Promise<RevokeResult> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const party = await tx.party.findFirst({
      where: { id: partyId, organizationId: opts.organizationId },
      select: { id: true, activeCardVersionId: true },
    });
    if (!party || !party.activeCardVersionId) throw new AgentCardNotFoundError();

    const active = await tx.agentCardVersion.findFirst({
      where: { id: party.activeCardVersionId, organizationId: opts.organizationId },
    });
    if (!active) throw new AgentCardNotFoundError();

    const priorTokenHash = active.publicToken ? tokenFingerprint(active.publicToken) : null;

    const updated = await tx.agentCardVersion.update({
      where: { id: active.id },
      data: { publicToken: null },
    });

    await tx.auditLog.create({
      data: {
        organizationId: opts.organizationId,
        actorUserId: opts.actorUserId,
        actorRole: opts.actorRole,
        entityType: "AgentCardVersion",
        entityId: updated.id,
        action: "card.revoke",
        meta: { previousTokenHash: priorTokenHash } as Prisma.InputJsonValue,
      },
    });

    return { versionId: updated.id };
  });
}

// ── Read-only queries (Task 3.3) ────────────────────────────────────────

/**
 * Slim shape returned by both list + detail. We DELIBERATELY do NOT return
 * `publicToken` to admin clients here — the token is the URL-safe secret
 * that grants public read access to the card; once leaked it cannot be
 * scoped. The web shows it via the dedicated copy-link control which
 * fetches a tokenised public URL through a different path.
 */
export interface AgentCardVersionRow {
  id: string;
  organizationId: string;
  partyId: string;
  displayName: string;
  title: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  status: string;
  submittedById: string;
  submittedByType: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  approvedAt: Date | null;
  expiresAt: Date | null;
  reconfirmCount: number;
  createdAt: Date;
}

const VERSION_SELECT = {
  id: true,
  organizationId: true,
  partyId: true,
  displayName: true,
  title: true,
  primaryEmail: true,
  primaryPhone: true,
  status: true,
  submittedById: true,
  submittedByType: true,
  reviewedById: true,
  reviewedAt: true,
  rejectionReason: true,
  approvedAt: true,
  expiresAt: true,
  reconfirmCount: true,
  createdAt: true,
} as const;

/**
 * Version history for a single party. Caller-org scoped; rows belonging
 * to other orgs are filtered out at the WHERE clause (no enumeration leak).
 * Newest first.
 */
export async function listVersionsForParty(
  organizationId: string,
  partyId: string,
): Promise<AgentCardVersionRow[]> {
  const db = getDb();
  return db.agentCardVersion.findMany({
    where: { organizationId, partyId },
    orderBy: { createdAt: "desc" },
    select: VERSION_SELECT,
  });
}

/**
 * Single version by id. Returns `null` when the row doesn't exist OR when
 * it belongs to another org — the route layer maps both to a 404 to
 * avoid cross-org enumeration via timing.
 */
export async function getVersionForOrg(
  organizationId: string,
  versionId: string,
): Promise<AgentCardVersionRow | null> {
  const db = getDb();
  return db.agentCardVersion.findFirst({
    where: { id: versionId, organizationId },
    select: VERSION_SELECT,
  });
}

// ── Phase 4 reads: queue list ───────────────────────────────────────────

export interface ListVersionsOptions {
  status?: "pending" | "approved" | "rejected";
  limit: number;
  offset: number;
}

export interface ListVersionsResult {
  data: AgentCardVersionRow[];
  pagination: { total: number; limit: number; offset: number };
}

/**
 * Paginated list of card versions for the moderation queue. Org-scoped
 * (no cross-org reads). Newest first. When `status` is supplied the list
 * is filtered to that single state.
 */
export async function listVersionsForOrg(
  organizationId: string,
  opts: ListVersionsOptions,
): Promise<ListVersionsResult> {
  const db = getDb();
  const where = {
    organizationId,
    ...(opts.status ? { status: opts.status } : {}),
  };
  const [data, total] = await Promise.all([
    db.agentCardVersion.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: opts.limit,
      skip: opts.offset,
      select: VERSION_SELECT,
    }),
    db.agentCardVersion.count({ where }),
  ]);
  return { data, pagination: { total, limit: opts.limit, offset: opts.offset } };
}

/**
 * Count of pending card versions for the org — used by the admin sidebar
 * to show a badge. Cheap COUNT(*) scoped by organizationId.
 */
export async function countPendingVersions(organizationId: string): Promise<number> {
  const db = getDb();
  return db.agentCardVersion.count({
    where: { organizationId, status: "pending" },
  });
}
