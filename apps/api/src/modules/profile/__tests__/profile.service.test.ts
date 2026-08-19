import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionPayload } from "../../../lib/auth";

// ── Hoist mock fns so vi.mock factories can reference them ────────────────────
const { mockDeleteObjectsBestEffort } = vi.hoisted(() => ({
  mockDeleteObjectsBestEffort: vi.fn().mockResolvedValue({ deleted: 1, failed: 0 }),
}));

const mockTx = {
  user: { update: vi.fn() },
  auditLog: { create: vi.fn() },
};

const mockDb = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
};

vi.mock("@kason/db", () => ({
  getDb: () => mockDb,
}));

vi.mock("../../../lib/storage", () => ({
  createSignedUploadUrl: vi.fn(),
  createSignedDownloadUrl: vi.fn(),
  deleteObjectsBestEffort: mockDeleteObjectsBestEffort,
}));

import { createSignedUploadUrl, createSignedDownloadUrl } from "../../../lib/storage";
import { getMyProfile, updateMyProfile, mintAvatarUploadUrl } from "../profile.service";

const session: SessionPayload = {
  userId: "user-1",
  orgId: "org-1",
  role: "editor",
} as never;

describe("getMyProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the calling operator's profile with a signed photoUrl when photoKey is set", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "me@example.com",
      fullName: "Me",
      role: "editor",
      photoKey: "avatars/users/user-1/abc.jpg",
      mustChangePassword: false,
      lastLoginAt: null,
    });
    vi.mocked(createSignedDownloadUrl).mockResolvedValueOnce("https://signed.example/abc.jpg");

    const result = await getMyProfile(session);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        id: "user-1",
        email: "me@example.com",
        fullName: "Me",
        role: "editor",
        photoKey: "avatars/users/user-1/abc.jpg",
        photoUrl: "https://signed.example/abc.jpg",
        mustChangePassword: false,
      }),
    );
    expect(createSignedDownloadUrl).toHaveBeenCalledWith("avatars/users/user-1/abc.jpg");
  });

  it("returns photoUrl=null when photoKey is null", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "me@example.com",
      fullName: "Me",
      role: "editor",
      photoKey: null,
      mustChangePassword: false,
      lastLoginAt: null,
    });
    const result = await getMyProfile(session);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.data.photoUrl).toBeNull();
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });
});

describe("updateMyProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates fullName when provided", async () => {
    mockTx.user.update.mockResolvedValueOnce({});
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "me@example.com",
      fullName: "New Name",
      role: "editor",
      photoKey: null,
      mustChangePassword: false,
      lastLoginAt: null,
    });

    const result = await updateMyProfile(session, { fullName: "New Name" });

    expect(result.ok).toBe(true);
    expect(mockTx.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { fullName: "New Name" },
    });
    expect(mockTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1",
        actorUserId: "user-1",
        actorRole: "editor",
        action: "profile.update.self",
        entityType: "user",
        entityId: "user-1",
        diff: { input: { fullName: "New Name" } },
      }),
    });
  });

  it("rejects a photoKey that does not belong to the caller", async () => {
    const result = await updateMyProfile(session, {
      photoKey: "avatars/users/other-user/oops.jpg",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/photo key does not belong/i);
    }
    expect(mockDb.user.update).not.toHaveBeenCalled();
    expect(mockTx.auditLog.create).not.toHaveBeenCalled();
  });

  it("accepts photoKey: null to clear the avatar", async () => {
    mockTx.user.update.mockResolvedValueOnce({});
    // First findUnique: pre-tx old-row read (photoKey only). No old key → no deletion.
    mockDb.user.findUnique.mockResolvedValueOnce({ photoKey: null });
    // Second findUnique: getMyProfile after the transaction.
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "me@example.com",
      fullName: "Me",
      role: "editor",
      photoKey: null,
      mustChangePassword: false,
      lastLoginAt: null,
    });

    const result = await updateMyProfile(session, { photoKey: null });
    expect(result.ok).toBe(true);
    expect(mockTx.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { photoKey: null },
    });
    expect(mockTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "profile.update.self",
        diff: { input: { photoKey: null } },
      }),
    });
  });
});

// ── Avatar orphan-cleanup tests ───────────────────────────────────────────────
// These verify that updateMyProfile calls deleteObjectsBestEffort with the old
// photoKey after the transaction commits, mirroring the Party-avatar fix.
describe("updateMyProfile — avatar orphan cleanup", () => {
  const USER_ID = "user-1";
  const PREFIX = `avatars/users/${USER_ID}/`;

  // Convenience: seed mockDb.user.findUnique for the pre-tx lookup (old row)
  // and mockDb.user.findUnique for the post-tx getMyProfile call.
  function seedFindUnique(oldPhotoKey: string | null, returnedPhotoKey: string | null = null) {
    // First call: pre-tx old-row read
    mockDb.user.findUnique.mockResolvedValueOnce({ photoKey: oldPhotoKey });
    // Second call: getMyProfile inside the return value
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: USER_ID,
      email: "me@example.com",
      fullName: "Me",
      role: "editor",
      photoKey: returnedPhotoKey,
      mustChangePassword: false,
      lastLoginAt: null,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx.user.update.mockResolvedValue({});
    mockDeleteObjectsBestEffort.mockResolvedValue({ deleted: 1, failed: 0 });
  });

  // ─── 1. replace ─────────────────────────────────────────────────────────────
  it("calls deleteObjectsBestEffort with old key when replacing photo", async () => {
    const oldKey = `${PREFIX}old.jpg`;
    const newKey = `${PREFIX}new.jpg`;
    seedFindUnique(oldKey, newKey);

    const result = await updateMyProfile(session, { photoKey: newKey });

    expect(result.ok).toBe(true);
    expect(mockDeleteObjectsBestEffort).toHaveBeenCalledOnce();
    expect(mockDeleteObjectsBestEffort).toHaveBeenCalledWith([oldKey]);
  });

  // ─── 2. clear ───────────────────────────────────────────────────────────────
  it("calls deleteObjectsBestEffort with old key when clearing photo (null)", async () => {
    const oldKey = `${PREFIX}existing.jpg`;
    seedFindUnique(oldKey, null);

    const result = await updateMyProfile(session, { photoKey: null });

    expect(result.ok).toBe(true);
    expect(mockDeleteObjectsBestEffort).toHaveBeenCalledOnce();
    expect(mockDeleteObjectsBestEffort).toHaveBeenCalledWith([oldKey]);
  });

  // ─── 3. photo unchanged (undefined) ─────────────────────────────────────────
  it("does NOT call deleteObjectsBestEffort when photoKey is not provided (undefined)", async () => {
    // Only the getMyProfile findUnique is needed here (no pre-tx lookup)
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: USER_ID,
      email: "me@example.com",
      fullName: "Me",
      role: "editor",
      photoKey: `${PREFIX}same.jpg`,
      mustChangePassword: false,
      lastLoginAt: null,
    });

    const result = await updateMyProfile(session, { fullName: "Updated Name" });

    expect(result.ok).toBe(true);
    expect(mockDeleteObjectsBestEffort).not.toHaveBeenCalled();
  });

  // ─── 4. set with no prior photo ─────────────────────────────────────────────
  it("does NOT call deleteObjectsBestEffort when old photoKey is null (no prior photo)", async () => {
    const newKey = `${PREFIX}first.jpg`;
    seedFindUnique(null, newKey);

    const result = await updateMyProfile(session, { photoKey: newKey });

    expect(result.ok).toBe(true);
    expect(mockDeleteObjectsBestEffort).not.toHaveBeenCalled();
  });

  // ─── 5. same key ────────────────────────────────────────────────────────────
  it("does NOT call deleteObjectsBestEffort when new photoKey equals old photoKey", async () => {
    const sameKey = `${PREFIX}same.jpg`;
    seedFindUnique(sameKey, sameKey);

    const result = await updateMyProfile(session, { photoKey: sameKey });

    expect(result.ok).toBe(true);
    expect(mockDeleteObjectsBestEffort).not.toHaveBeenCalled();
  });
});

describe("mintAvatarUploadUrl", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mints a signed PUT URL keyed under avatars/users/{userId}/", async () => {
    vi.mocked(createSignedUploadUrl).mockResolvedValueOnce({
      uploadUrl: "https://put.example",
      method: "PUT",
      headers: {},
      storageKey: "avatars/users/user-1/uuid.jpg",
    });

    const result = await mintAvatarUploadUrl(session, {
      contentType: "image/jpeg",
      sizeBytes: 100_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.url).toBe("https://put.example");
      expect(result.data.key).toMatch(/^avatars\/users\/user-1\/[a-f0-9-]+\.jpg$/);
    }
  });
});
