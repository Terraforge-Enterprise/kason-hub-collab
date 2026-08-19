import { getDb } from "@kason/db";
import { createSessionToken, hashPassword, verifyPassword } from "../../../lib/auth";

const PORTAL_TOKEN_EXPIRY = "4h";
const ABSOLUTE_SESSION_HOURS = 8;

/**
 * Start of a fresh absolute session ceiling. Only credential-verifying callers
 * (login, change-password) may call this — the middleware's sliding refresh
 * deliberately carries the EXISTING absoluteExp forward so mere activity can
 * never push the ceiling out.
 */
function freshAbsoluteExp(): number {
  return Math.floor(Date.now() / 1000) + ABSOLUTE_SESSION_HOURS * 3600;
}

export async function portalLoginService(input: { email: string; password: string }) {
  const db = getDb();
  const email = input.email.trim().toLowerCase();

  const user = await db.user.findFirst({
    where: {
      email,
      status: "active",
      organization: { status: "active" },
    },
    select: {
      id: true,
      organizationId: true,
      role: true,
      userType: true,
      partyId: true,
      passwordHash: true,
    },
  });

  if (!user?.passwordHash) {
    return { ok: false as const, status: 401, error: "Invalid credentials" };
  }

  // Must be tenant, agent, or owner userType
  const allowedTypes = ["tenant", "agent", "owner"];
  if (!user.userType || !allowedTypes.includes(user.userType.toLowerCase())) {
    return { ok: false as const, status: 401, error: "Invalid credentials" };
  }

  if (!user.partyId) {
    return { ok: false as const, status: 401, error: "Invalid credentials" };
  }

  const isValid = await verifyPassword(input.password, user.passwordHash);
  if (!isValid) {
    return { ok: false as const, status: 401, error: "Invalid credentials" };
  }

  // Portal access is controlled purely by the granted User account: create = access,
  // revoke/deactivate = no access. We intentionally do NOT require an active Tenancy or
  // PartyRole here — a granted login keeps working regardless of current lease/role status
  // (an admin revokes to remove access, not the lease lifecycle).

  const absoluteExp = freshAbsoluteExp();

  const token = await createSessionToken(
    user.id,
    user.organizationId,
    user.role,
    { userType: user.userType, partyId: user.partyId, absoluteExp, iss: "portal", aud: "portal" },
    PORTAL_TOKEN_EXPIRY,
  );

  return {
    ok: true as const,
    status: 200,
    data: { token },
  };
}

export async function portalChangePasswordService(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<
  | { ok: true; token: string | null }
  | { ok: false; status: 400 | 401 | 403 | 404; error: string }
> {
  if (newPassword.length < 6) {
    return { ok: false, status: 400, error: "New password must be at least 6 characters" };
  }

  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      passwordHash: true,
      userType: true,
      organizationId: true,
      role: true,
      partyId: true,
      status: true,
      organization: { select: { status: true } },
    },
  });
  if (!user || !user.passwordHash) {
    return { ok: false, status: 404, error: "User not found" };
  }
  if (user.userType !== "agent" && user.userType !== "tenant" && user.userType !== "owner") {
    return { ok: false, status: 403, error: "Not a portal user" };
  }

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) return { ok: false, status: 401, error: "Current password is incorrect" };

  const newHash = await hashPassword(newPassword);
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash, mustChangePassword: false },
  });

  // Re-issue the session so a first-login user continues straight into the
  // portal instead of being bounced to /portal/login. They just re-proved the
  // current password above, so this is a re-authentication event: rotating the
  // token on a credential change is the standard session-fixation defence, and
  // the fresh absoluteExp gives them a full session window rather than the
  // remainder of the one minted with their temporary password.
  //
  // Deliberately NOT done for the emailed-link reset (resetPortalPasswordService)
  // — that caller is unauthenticated and a reset link is a weaker credential, so
  // it still ends at the login page.
  //
  // Re-check status the way portalLoginService does, because minting here is a
  // login in all but name and it resets BOTH expiry mechanisms at once. A new
  // token carries a new `iat`, and portal.auth.middleware.ts:62 only re-reads
  // User.status once a cookie is older than the 30-minute sliding window — so a
  // revoked user calling this endpoint every 29 minutes would never trip that
  // check, while the fresh absoluteExp defeats the absolute ceiling in parallel.
  // Withholding the token (rather than erroring) leaves the password change
  // itself alone and lets their current cookie age out into a 401.
  //
  // partyId is required for a portal session (portalLoginService rejects without
  // it). If it has since been cleared, degrade to no token rather than throwing:
  // the password row is already written, so a 500 here would tell the user their
  // change failed and send them back with the old password. Their existing
  // session cookie stays valid either way.
  const mayHoldSession =
    user.status === "active" && user.organization?.status === "active" && !!user.partyId;

  const token = mayHoldSession
    ? await createPortalSessionToken(
        user.id,
        user.organizationId,
        user.role,
        user.partyId as string,
        freshAbsoluteExp(),
        user.userType,
      )
    : null;

  return { ok: true, token };
}

export async function createPortalSessionToken(
  userId: string,
  orgId: string,
  role: string,
  partyId: string,
  absoluteExp: number,
  userType: "tenant" | "agent" | "owner" = "tenant",
): Promise<string> {
  return createSessionToken(
    userId,
    orgId,
    role,
    { userType, partyId, absoluteExp, iss: "portal", aud: "portal" },
    PORTAL_TOKEN_EXPIRY,
  );
}
