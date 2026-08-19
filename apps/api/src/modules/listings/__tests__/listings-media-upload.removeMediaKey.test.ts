/**
 * TDD tests for the post-commit storage-delete behaviour added to
 * removeMediaKey.  These tests are intentionally separate from the existing
 * listings-media-upload.service.test.ts file so the module-level vi.mock
 * factories don't interfere with each other (Vitest isolates per file).
 *
 * What's covered:
 *  1. Removing a photo key → deleteObjectsBestEffort called once with [key].
 *  2. Removing a key that equals coverPhotoKey → update sets coverPhotoKey: null
 *     AND object is deleted.
 *  3. Removing a video key → helper called with [key]; videoKeys filtered.
 *  4. Key already absent (idempotent no-op) → helper NOT called.
 *  5. Invalid storage key (fails regex) → 400 result, helper NOT called.
 *  6. Org mismatch (cross-org IDOR guard) → 404, no update, helper NOT called.
 *  7. Storage delete reports failure → DB key still removed, result stays ok
 *     (best-effort contract: failure is swallowed, not rolled back).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Storage mock — includes deleteObjectsBestEffort spy ──────────────────────
const deleteObjectsBestEffortMock = vi.fn(async () => ({ deleted: 1, failed: 0 }));

vi.mock("../../../lib/storage", () => ({
  createSignedUploadUrl: vi.fn(),
  objectExists: vi.fn(async () => true),
  deleteObjectsBestEffort: deleteObjectsBestEffortMock,
}));

vi.mock("../listings-media.service", async () => {
  const actual = await vi.importActual<typeof import("../listings-media.service")>(
    "../listings-media.service",
  );
  return {
    ...actual,
    stripExifInPlace: vi.fn(async () => undefined),
    transcodeVideoInPlace: vi.fn(async () => undefined),
  };
});

// ── DB mock ──────────────────────────────────────────────────────────────────
const findUniqueMock = vi.fn();
const updateMock = vi.fn();

vi.mock("@kason/db", () => ({
  getDb: () => ({
    listing: { findUnique: findUniqueMock, update: updateMock },
    $transaction: (cb: (tx: unknown) => unknown) =>
      cb({
        listing: { findUnique: findUniqueMock, update: updateMock },
      }),
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
const UNIT_ID = "11111111-1111-1111-1111-111111111111";
const PHOTO_KEY_A = `units/${UNIT_ID}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg`;
const PHOTO_KEY_B = `units/${UNIT_ID}/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg`;
const VIDEO_KEY_C = `units/${UNIT_ID}/cccccccc-cccc-cccc-cccc-cccccccccccc.mp4`;

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
  deleteObjectsBestEffortMock.mockReset();
  deleteObjectsBestEffortMock.mockResolvedValue({ deleted: 1, failed: 0 });
});

describe("removeMediaKey — storage delete behaviour", () => {
  it("1. removing a photo key calls deleteObjectsBestEffort once with [storageKey] after commit", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [PHOTO_KEY_A, PHOTO_KEY_B],
      videoKeys: [],
      coverPhotoKey: PHOTO_KEY_B, // A is not the cover
    });
    updateMock.mockResolvedValueOnce({
      photoKeys: [PHOTO_KEY_B],
      videoKeys: [],
    });

    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: PHOTO_KEY_A,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.photoKeys).toEqual([PHOTO_KEY_B]);
    }

    // The delete helper must be called once, after commit, with the removed key.
    expect(deleteObjectsBestEffortMock).toHaveBeenCalledOnce();
    expect(deleteObjectsBestEffortMock).toHaveBeenCalledWith([PHOTO_KEY_A]);

    // The update should NOT clear coverPhotoKey because A ≠ cover.
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      where: { id: UNIT_ID },
      data: { photoKeys: [PHOTO_KEY_B] },
    });
    expect(updateMock.mock.calls[0][0].data).not.toHaveProperty("coverPhotoKey");
  });

  it("2. removing the coverPhotoKey sets coverPhotoKey: null in the update AND deletes the object", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [PHOTO_KEY_A, PHOTO_KEY_B],
      videoKeys: [],
      coverPhotoKey: PHOTO_KEY_A, // A IS the cover
    });
    updateMock.mockResolvedValueOnce({
      photoKeys: [PHOTO_KEY_B],
      videoKeys: [],
    });

    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: PHOTO_KEY_A,
    });

    expect(r.ok).toBe(true);

    // The update must include coverPhotoKey: null.
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      where: { id: UNIT_ID },
      data: {
        photoKeys: [PHOTO_KEY_B],
        coverPhotoKey: null,
      },
    });

    // Object must still be deleted.
    expect(deleteObjectsBestEffortMock).toHaveBeenCalledOnce();
    expect(deleteObjectsBestEffortMock).toHaveBeenCalledWith([PHOTO_KEY_A]);
  });

  it("3. removing a video key calls deleteObjectsBestEffort and filters videoKeys", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [],
      videoKeys: [VIDEO_KEY_C],
      coverPhotoKey: null,
    });
    updateMock.mockResolvedValueOnce({ photoKeys: [], videoKeys: [] });

    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: VIDEO_KEY_C,
    });

    expect(r.ok).toBe(true);

    expect(updateMock.mock.calls[0][0]).toMatchObject({
      where: { id: UNIT_ID },
      data: { videoKeys: [] },
    });

    expect(deleteObjectsBestEffortMock).toHaveBeenCalledOnce();
    expect(deleteObjectsBestEffortMock).toHaveBeenCalledWith([VIDEO_KEY_C]);
  });

  it("4. key already absent (idempotent no-op) → deleteObjectsBestEffort NOT called", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [PHOTO_KEY_B],
      videoKeys: [],
      coverPhotoKey: null,
    });

    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: PHOTO_KEY_A, // A is absent
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.photoKeys).toEqual([PHOTO_KEY_B]);
    }

    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteObjectsBestEffortMock).not.toHaveBeenCalled();
  });

  it("5. invalid storage key (fails regex) → 400 result, deleteObjectsBestEffort NOT called", async () => {
    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: "units/not-a-uuid/whatever.heic",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(deleteObjectsBestEffortMock).not.toHaveBeenCalled();
  });

  it("6. org mismatch (listing owned by another org) → 404, no update, deleteObjectsBestEffort NOT called", async () => {
    // IDOR guard: the caller's org (o2) does not own this listing (o1). This
    // is the guard that keeps the editor-role widening safe — an editor in
    // one org must never be able to strip/delete media of another org's
    // listing. The storage object must be left untouched.
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [PHOTO_KEY_A],
      videoKeys: [],
      coverPhotoKey: null,
    });

    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o2", // different org than the listing's o1
      unitId: UNIT_ID,
      storageKey: PHOTO_KEY_A,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteObjectsBestEffortMock).not.toHaveBeenCalled();
  });

  it("7. storage delete reports failure (failed:1) → DB key still removed, result stays ok (best-effort)", async () => {
    // Documents the accepted best-effort contract the route comment describes:
    // deleteObjectsBestEffort never throws; a storage failure does NOT roll back
    // the committed DB removal. The key is gone from the listing even though the
    // object may briefly survive (reconciled later by report:storage-orphans).
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [PHOTO_KEY_A, PHOTO_KEY_B],
      videoKeys: [],
      coverPhotoKey: PHOTO_KEY_B,
    });
    updateMock.mockResolvedValueOnce({
      photoKeys: [PHOTO_KEY_B],
      videoKeys: [],
    });
    deleteObjectsBestEffortMock.mockResolvedValueOnce({ deleted: 0, failed: 1 });

    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: PHOTO_KEY_A,
    });

    // Best-effort failure is swallowed: the caller still sees success and the
    // DB no longer references the key.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.photoKeys).toEqual([PHOTO_KEY_B]);
    }
    expect(deleteObjectsBestEffortMock).toHaveBeenCalledOnce();
    expect(deleteObjectsBestEffortMock).toHaveBeenCalledWith([PHOTO_KEY_A]);
  });
});
