import { randomUUID } from "node:crypto";
import { getDb } from "@kason/db";
import { createSignedUploadUrl, createSignedDownloadUrl, deleteObjectsBestEffort } from "../../lib/storage";
import { recordAudit } from "../../lib/audit";
import type { SessionPayload } from "../../lib/auth";
import type { UpdateMyProfileInput, AvatarUploadUrlInput } from "./profile.validation";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function avatarKeyPrefix(userId: string): string {
  return `avatars/users/${userId}/`;
}

export async function getMyProfile(session: SessionPayload) {
  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      photoKey: true,
      mustChangePassword: true,
      lastLoginAt: true,
    },
  });
  if (!user) {
    return { ok: false as const, status: 404 as const, error: "User not found" };
  }
  const photoUrl = user.photoKey ? await createSignedDownloadUrl(user.photoKey) : null;
  return { ok: true as const, data: { ...user, photoUrl } };
}

export async function updateMyProfile(session: SessionPayload, input: UpdateMyProfileInput) {
  // Ownership guard for photoKey: must start with the caller's prefix.
  if (input.photoKey != null) {
    if (!input.photoKey.startsWith(avatarKeyPrefix(session.userId))) {
      return {
        ok: false as const,
        status: 403 as const,
        error: "Photo key does not belong to caller",
      };
    }
  }

  const db = getDb();

  // Read the current photoKey BEFORE the transaction so we can delete the old
  // object from storage after the DB write commits (best-effort, post-commit).
  let oldPhotoKey: string | null = null;
  if (input.photoKey !== undefined) {
    const current = await db.user.findUnique({
      where: { id: session.userId },
      select: { photoKey: true },
    });
    oldPhotoKey = current?.photoKey ?? null;
  }

  const data: { fullName?: string; photoKey?: string | null } = {};
  if (input.fullName !== undefined) data.fullName = input.fullName;
  if (input.photoKey !== undefined) data.photoKey = input.photoKey;

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: session.userId }, data });
    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role,
      action: "profile.update.self",
      entityType: "user",
      entityId: session.userId,
      diff: { input },
    });
  });

  // Delete the old avatar object after the transaction commits — best-effort
  // so a storage failure never rolls back the DB write.
  if (oldPhotoKey && oldPhotoKey !== input.photoKey) {
    await deleteObjectsBestEffort([oldPhotoKey]);
  }

  return getMyProfile(session);
}

export async function mintAvatarUploadUrl(
  session: SessionPayload,
  input: AvatarUploadUrlInput,
) {
  const ext = MIME_TO_EXT[input.contentType];
  const key = `${avatarKeyPrefix(session.userId)}${randomUUID()}.${ext}`;
  const signed = await createSignedUploadUrl({ storageKey: key, contentType: input.contentType });
  return { ok: true as const, data: { url: signed.uploadUrl, key, headers: signed.headers } };
}
