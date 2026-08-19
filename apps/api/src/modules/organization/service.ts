import type { Prisma } from "@kason/db";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../lib/auth";
import { recordAudit } from "../../lib/audit";

type Result<T> =
  | { ok: true; status: 200; data: T }
  | { ok: false; status: 403 | 404; error: string };

export interface OrganizationProfile {
  id: string;
  name: string;
  /**
   * Owner-statement auto-send schedule — the day-of-month and hour at which the
   * just-ended month's frozen statements are released to owners.
   *
   * Interpreted in `timezone`, NEVER UTC: an admin choosing "the 3rd at 09:00"
   * means their local 3rd. `timezone` is returned read-only so the UI can say so
   * out loud rather than leaving the reader to guess which clock applies.
   */
  ownerStatementSendDay: number;
  ownerStatementSendHour: number;
  timezone: string;
}

/** The columns every read/write in this module projects — kept in one place so a
 *  new field can never be returned by one path and silently dropped by the other. */
const PROFILE_SELECT = {
  id: true,
  name: true,
  ownerStatementSendDay: true,
  ownerStatementSendHour: true,
  timezone: true,
} as const;

// Both reads and writes require manager+. Editors cannot touch org-level
// settings because the org name appears on every client-facing document
// (letterhead, reservation PDFs, e-namecard); changes are auditable.
function hasAdminAccess(session: SessionPayload): boolean {
  return session.role === "admin" || session.role === "manager";
}

export async function getOrganizationProfileService(
  session: SessionPayload,
): Promise<Result<OrganizationProfile>> {
  if (!hasAdminAccess(session)) {
    return { ok: false, status: 403, error: "Admin or manager role required" };
  }
  const db = getDb();
  const row = await db.organization.findUniqueOrThrow({
    where: { id: session.orgId },
    select: PROFILE_SELECT,
  });
  return { ok: true, status: 200, data: row };
}

export async function updateOrganizationProfileService(
  session: SessionPayload,
  input: {
    name: string;
    /** Optional so an existing name-only PATCH is unchanged; absent ⇒ left as-is. */
    ownerStatementSendDay?: number;
    ownerStatementSendHour?: number;
  },
): Promise<Result<OrganizationProfile>> {
  if (!hasAdminAccess(session)) {
    return { ok: false, status: 403, error: "Admin or manager role required" };
  }

  const db = getDb();
  return db.$transaction(async (tx) => {
    const before = await tx.organization.findUniqueOrThrow({
      where: { id: session.orgId },
      select: PROFILE_SELECT,
    });

    // An omitted schedule field means "leave it alone", not "reset it" — so
    // resolve each against the current value before comparing or writing.
    const nextSendDay = input.ownerStatementSendDay ?? before.ownerStatementSendDay;
    const nextSendHour = input.ownerStatementSendHour ?? before.ownerStatementSendHour;

    // No-op short-circuit: don't write audit rows for a "save without changing
    // anything" submit. This is the rule-of-charity for forms where the user clicks
    // Save unchanged. Must cover EVERY writable field — checking only `name` would
    // silently discard a send-schedule edit made without touching the name.
    if (
      before.name === input.name &&
      before.ownerStatementSendDay === nextSendDay &&
      before.ownerStatementSendHour === nextSendHour
    ) {
      return { ok: true as const, status: 200 as const, data: before };
    }

    const after = await tx.organization.update({
      where: { id: session.orgId },
      data: {
        name: input.name,
        ownerStatementSendDay: nextSendDay,
        ownerStatementSendHour: nextSendHour,
      },
      select: PROFILE_SELECT,
    });

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role,
      action: "organization.profile_updated",
      entityType: "Organization",
      entityId: session.orgId,
      // The schedule decides WHEN owners receive a money document, so a change to
      // it must be as auditable as a rename — record all writable fields, not just
      // the name.
      diff: {
        before: {
          name: before.name,
          ownerStatementSendDay: before.ownerStatementSendDay,
          ownerStatementSendHour: before.ownerStatementSendHour,
        },
        after: {
          name: after.name,
          ownerStatementSendDay: after.ownerStatementSendDay,
          ownerStatementSendHour: after.ownerStatementSendHour,
        },
      } as Prisma.InputJsonValue,
    });

    return { ok: true as const, status: 200 as const, data: after };
  });
}
