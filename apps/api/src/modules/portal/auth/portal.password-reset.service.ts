import { getDb } from "@kason/db";
import { createSessionToken, verifySessionToken, hashPassword } from "../../../lib/auth";
import { sendEmail } from "../../../lib/email";
import { passwordResetEmail } from "../../../lib/email-templates/password-reset";
import { recordAudit } from "../../../lib/audit";
import crypto from "node:crypto";

const RESET_TOKEN_EXPIRY = "15m";
const PORTAL_RESET_AUDIENCE = "reset:portal";

export async function requestPortalPasswordResetService(email: string) {
  const db = getDb();
  const normalized = email.toLowerCase().trim();
  const user = await db.user.findFirst({
    where: { email: normalized, status: "active", userType: "agent" },
    select: { id: true, organizationId: true, email: true, fullName: true },
  });

  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ event: "password_reset.requested", surface: "portal", emailHash: hashEmail(normalized), found: !!user }));

  if (!user) return { ok: true as const };

  const token = await createSessionToken(user.id, user.organizationId, "reset", {
    iss: "reset",
    aud: PORTAL_RESET_AUDIENCE,
  }, RESET_TOKEN_EXPIRY);

  const tokenHash = sha256Hex(token);
  await db.user.update({
    where: { id: user.id },
    data: { resetTokenHash: tokenHash },
  });

  // Portal lives on the same SPA origin as admin — APP_URL covers both.
  const baseUrl = process.env.APP_URL || "http://localhost:5173";
  const resetUrl = `${baseUrl}/portal/reset-password?token=${encodeURIComponent(token)}`;
  const email_ = passwordResetEmail({ surface: "portal", fullName: user.fullName, resetUrl });
  const sendResult = await sendEmail({
    to: user.email,
    subject: email_.subject,
    body: email_.html,
    text: email_.text,
  });
  if (!sendResult.success) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ event: "password_reset.send_failed", surface: "portal", emailHash: hashEmail(normalized), error: sendResult.error }));
  }

  return { ok: true as const };
}

export async function verifyPortalResetTokenService(
  token: string,
): Promise<{ ok: true; fullName: string } | { ok: false }> {
  const session = await verifySessionToken(token, { issuer: "reset", audience: PORTAL_RESET_AUDIENCE });
  if (!session) return { ok: false };

  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, fullName: true, status: true, resetTokenHash: true },
  });
  if (!user || user.status !== "active" || !user.resetTokenHash) return { ok: false };

  const tokenHash = sha256Hex(token);
  if (tokenHash !== user.resetTokenHash) return { ok: false };

  return { ok: true, fullName: user.fullName };
}

export async function resetPortalPasswordService(token: string, newPassword: string) {
  const session = await verifySessionToken(token, { issuer: "reset", audience: PORTAL_RESET_AUDIENCE });
  if (!session) return { ok: false as const, status: 401, error: "Invalid or expired reset token" };

  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, organizationId: true, role: true, resetTokenHash: true, status: true },
  });

  if (!user || user.status !== "active" || !user.resetTokenHash) {
    return { ok: false as const, status: 401, error: "Invalid or expired reset token" };
  }

  const tokenHash = sha256Hex(token);
  if (tokenHash !== user.resetTokenHash) {
    return { ok: false as const, status: 401, error: "Invalid or expired reset token" };
  }

  const passwordHash = await hashPassword(newPassword);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, resetTokenHash: null, mustChangePassword: false },
    });
    await recordAudit(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      actorRole: user.role,
      action: "user.password_reset",
      entityType: "user",
      entityId: user.id,
    });
  });

  return { ok: true as const };
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hashEmail(email: string): string {
  return crypto.createHash("sha256").update(email).digest("hex").slice(0, 16);
}
